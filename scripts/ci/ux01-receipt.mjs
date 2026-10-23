#!/usr/bin/env node
/**
 * PROD-UX-01 owner-run receipt for the lanes that run on this machine, on one frozen commit:
 * contract batches, the receipt gate against hosted UX + J2 receipts, the MFA PostgreSQL cases and the
 * Keycloak DCR cases. The hosted J2 + UX + MFA-browser run is recorded by its run id.
 *
 *   node scripts/ci/ux01-receipt.mjs <new-output-dir> <hosted-run-id> <downloaded-artifacts-dir>
 *
 * Starts a disposable PostgreSQL and a disposable pinned Keycloak (fixed loopback port 8443) and removes both.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs"; import path from "node:path"; import os from "node:os"; import net from "node:net";

const repo = process.cwd();
const [outArg, runId, artifacts] = process.argv.slice(2);
if (!outArg || !/^\d+$/.test(runId ?? "") || !artifacts) throw new Error("usage: ux01-receipt.mjs <new-output-dir> <hosted-run-id> <artifacts-dir>");
const out = path.resolve(outArg); if (fs.existsSync(out)) throw new Error("output exists"); fs.mkdirSync(out, { recursive: true });
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", ...opts }).trim();
const sha = (v) => createHash("sha256").update(v).digest("hex");
const freeze = () => ({ head: sh("git", ["rev-parse", "HEAD"]), tracked: sh("git", ["status", "--porcelain", "--untracked-files=no"]) });
const before = freeze(); if (before.tracked) throw new Error("tracked changes present");
const { commandsForRequirement } = await import(repo + "/scripts/ci/wave6-gates.mjs");
const plan = commandsForRequirement("PROD-UX-01"), lanes = [], node = process.execPath;
const run = (name, argv, env = {}, verify) => {
  const started = new Date().toISOString();
  const r = spawnSync(argv[0], argv.slice(1), { env: { ...process.env, ...env }, encoding: "utf8", maxBuffer: 64 << 20 });
  fs.writeFileSync(path.join(out, name + ".log"), (r.stdout ?? "") + (r.stderr ?? ""));
  const m = /Tests\s+(.*)/.exec(r.stdout ?? "");
  const lane = { name, argv, argvSha256: sha(JSON.stringify(argv)), gates: Object.keys(env).filter(k => /^ZENITH_TEST_|^ZENITH_MFA_/.test(k)), started, finished: new Date().toISOString(), exit: r.status,
    summary: m ? m[1].replace(/\x1b\[[0-9;]*m/g, "").trim() : null };
  if (verify) { const v = spawnSync(node, ["scripts/ci/wave6-gates.mjs", "--case", verify.id, "--report", verify.report], { encoding: "utf8" }); lane.verify = { id: verify.id, exit: v.status, output: v.stdout.trim() || v.stderr.trim() }; }
  lanes.push(lane); console.log(name, lane.exit, lane.summary ?? "", lane.verify?.output ?? "");
};
// Contract batches from the registered plan.
plan.commands.filter(c => !c.id && c.argv[1] === "node_modules/vitest/vitest.mjs").forEach((c, i) =>
  run(`contract-${i + 1}`, [node, ...c.argv.slice(1), "--reporter=default", "--reporter=json", "--outputFile", path.join(out, `contract-${i + 1}.json`)]));
// Receipt gate: hosted UX + J2 receipts, private copies (0600 in a 0700 directory outside the checkout).
const priv = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-ux01-")); fs.chmodSync(priv, 0o700);
const hosted = [];
try {
  for (const arch of ["amd64", "arm64"]) {
    const ux = path.join(priv, `ux-${arch}.json`), j2 = path.join(priv, `j2-${arch}.json`);
    fs.copyFileSync(path.join(artifacts, `clean-host-ux-${arch}/ux-receipt.json`), ux); fs.copyFileSync(path.join(artifacts, `clean-host-journey-${arch}/clean-host-journey-receipt.json`), j2);
    fs.chmodSync(ux, 0o600); fs.chmodSync(j2, 0o600);
    hosted.push({ arch, uxReceiptSha256: sha(fs.readFileSync(ux)), journeyReceiptSha256: sha(fs.readFileSync(j2)) });
    const report = path.join(out, `wave6-03be46338cbeb148-${arch}.json`);
    run(`receipt-gate-${arch}`, [node, "node_modules/vitest/vitest.mjs", "run", "tests/e2e/default/ux-receipt-gated.test.ts", "--no-file-parallelism", "--maxWorkers=2", "--reporter=json", "--outputFile", report],
      { ZENITH_TEST_UX01_RECEIPT: "1", ZENITH_UX01_RECEIPT: ux, ZENITH_JOURNEY_RECEIPT: j2 }, { id: "wave6-03be46338cbeb148", report });
  }
} finally { fs.rmSync(priv, { recursive: true, force: true }); }
// MFA PostgreSQL cases on a disposable server.
const img = "postgres:16.15-alpine@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685";
const port = await new Promise(r => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
const pw = randomBytes(24).toString("hex"), pg = "zenith-ux01-pg-" + randomBytes(6).toString("hex");
sh("docker", ["run", "--pull", "never", "-d", "--name", pg, "--memory", "512m", "--cpus", "1", "-e", "POSTGRES_PASSWORD=" + pw, "-e", "POSTGRES_DB=zenith_mfa", "-p", `127.0.0.1:${port}:5432`, img]);
try {
  for (let i = 0; i < 60; i++) { if (spawnSync("docker", ["exec", pg, "pg_isready", "-U", "postgres", "-d", "zenith_mfa"]).status === 0) break; await new Promise(r => setTimeout(r, 1000)); }
  const report = path.join(out, "mfa-postgres.json");
  run("mfa-postgres", [node, "node_modules/vitest/vitest.mjs", "run", "tests/auth/mfa-workspace-state.test.ts", "--no-file-parallelism", "--maxWorkers=2", "--reporter=default", "--reporter=json", "--outputFile", report],
    { ZENITH_MFA_PG: "1", ZENITH_TEST_PLATFORM_PG_URL: `postgres://postgres:${pw}@127.0.0.1:${port}/zenith_mfa` });
  for (const c of plan.commands.filter(c => c.gates?.includes("ZENITH_MFA_PG"))) {
    const v = spawnSync(node, ["scripts/ci/wave6-gates.mjs", "--case", c.id, "--report", report], { encoding: "utf8" });
    lanes.push({ name: c.id, verifyOf: "mfa-postgres", exit: v.status, output: v.stdout.trim() || v.stderr.trim() });
  }
} finally { spawnSync("docker", ["rm", "--force", pg]); }
// Keycloak DCR cases on a disposable pinned issuer.
const interop = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-interop-")); fs.rmSync(interop, { recursive: true });
const project = "zenith-interop-" + randomBytes(4).toString("hex");
sh(node, ["deploy/acceptance/oauth-issuer/prepare.mjs", "--dir", interop, "--zenith-origin", "https://127.0.0.1:3443", "--subject", "interop-member-1"]);
const compose = ["compose", "-p", project, "--env-file", path.join(interop, "compose.env"), "-f", "deploy/acceptance/oauth-issuer/compose.yaml"];
try {
  sh("docker", [...compose, "up", "-d"]);
  for (let i = 0; i < 90; i++) {
    if (spawnSync("curl", ["-sf", "--cacert", path.join(interop, "tls/ca.crt"), "https://localhost:8443/realms/zenith-interop/.well-known/openid-configuration", "-o", "/dev/null"]).status === 0) break;
    await new Promise(r => setTimeout(r, 2000));
  }
  const report = path.join(out, "oauth-dcr.json");
  run("oauth-dcr", [node, "node_modules/vitest/vitest.mjs", "run", "tests/agent-v3/oauth-issuer-live.test.ts", "--no-file-parallelism", "--maxWorkers=2", "--reporter=default", "--reporter=json", "--outputFile", report],
    { ZENITH_TEST_OAUTH_ISSUER: "1", ZENITH_INTEROP_DIR: interop, NODE_EXTRA_CA_CERTS: path.join(interop, "tls/ca.crt") });
  for (const c of plan.commands.filter(c => c.gates?.includes("ZENITH_TEST_OAUTH_ISSUER"))) {
    const v = spawnSync(node, ["scripts/ci/wave6-gates.mjs", "--case", c.id, "--report", report], { encoding: "utf8" });
    lanes.push({ name: c.id, verifyOf: "oauth-dcr", exit: v.status, output: v.stdout.trim() || v.stderr.trim() });
  }
} finally { spawnSync("docker", [...compose, "down", "-v"]); fs.rmSync(interop, { recursive: true, force: true }); }
const leftovers = { postgres: sh("docker", ["ps", "-aq", "--filter", "name=" + pg]), keycloak: sh("docker", ["ps", "-aq", "--filter", "name=" + project]) };
const after = freeze();
const notRun = plan.commands.filter(c => c.id && !c.gates?.some(g => ["ZENITH_MFA_PG", "ZENITH_TEST_OAUTH_ISSUER"].includes(g)) && c.id !== "wave6-03be46338cbeb148")
  .map(c => ({ id: c.id, gates: c.gates, ranHere: false }));
const receipt = { schemaVersion: 1, requirement: "PROD-UX-01", recordedAt: new Date().toISOString(),
  sourceFreeze: { before, after, unchanged: JSON.stringify(before) === JSON.stringify(after) },
  hostedRun: { runId: Number(runId), url: `https://github.com/saivedant169/zenith/actions/runs/${runId}`, receipts: hosted },
  environment: { host: `${os.type()} ${os.arch()}`, node: process.version, docker: sh("docker", ["version", "--format", "{{.Server.Version}}"]), postgresImage: img },
  lanes, notRunHere: notRun,
  reportSha256: Object.fromEntries(fs.readdirSync(out).filter(f => f.endsWith(".json")).map(f => [f, sha(fs.readFileSync(path.join(out, f)))])),
  cleanup: { ...leftovers, clean: !leftovers.postgres && !leftovers.keycloak, privateCopiesRemoved: !fs.existsSync(priv), interopRemoved: !fs.existsSync(interop) } };
const body = JSON.stringify(receipt, null, 2) + "\n";
fs.writeFileSync(path.join(out, "receipt.json"), body); fs.writeFileSync(path.join(out, "receipt.json.sha256"), sha(body) + "\n");
console.log(JSON.stringify({ unchanged: receipt.sourceFreeze.unchanged, cleanup: receipt.cleanup.clean, failed: lanes.filter(l => l.exit !== 0 || (l.verify && l.verify.exit !== 0)).map(l => l.name) }));
