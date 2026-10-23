#!/usr/bin/env node
/** PROD-UX-03 owner-run receipt: contract, PostgreSQL and Docker lanes from the wave6 plan on one frozen commit.
 * Usage (repository root, Node 22, Docker): node scripts/ci/ux03-receipt.mjs <new-output-dir>
 * Starts one disposable PostgreSQL (generated password, random loopback port) and removes it; never prunes. */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs"; import path from "node:path"; import os from "node:os"; import net from "node:net";
const repo = process.cwd();
const out = path.resolve(process.argv[2] ?? ""); if (!process.argv[2] || fs.existsSync(out)) throw new Error("usage: ux03-receipt.mjs <new-output-dir>"); fs.mkdirSync(out, { recursive: true });
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", ...opts }).trim();
const sha = (v) => createHash("sha256").update(v).digest("hex");
const freeze = () => ({ head: sh("git", ["rev-parse", "HEAD"]), tracked: sh("git", ["status", "--porcelain", "--untracked-files=no"]) });
const floor = () => Number(sh("df", ["-k", repo]).split("\n")[1].split(/\s+/)[3]) * 1024;
const before = freeze(); if (before.tracked) throw new Error("tracked changes present");
const { commandsForRequirement } = await import(repo + "/scripts/ci/wave6-gates.mjs");
const plan = commandsForRequirement("PROD-UX-03"), lanes = [];
const run = (name, argv, env, verify) => {
  const started = new Date().toISOString(), freeBefore = floor();
  const r = spawnSync(argv[0], argv.slice(1), { env: { ...process.env, ...env }, encoding: "utf8", maxBuffer: 64 << 20 });
  fs.writeFileSync(path.join(out, name + ".log"), (r.stdout ?? "") + (r.stderr ?? ""));
  const lane = { name, argv, argvSha256: sha(JSON.stringify(argv)), gates: Object.keys(env).filter(k => k.startsWith("ZENITH_TEST_")), started, finished: new Date().toISOString(), exit: r.status, freeBytesBefore: freeBefore };
  const m = /Tests\s+(.*)/.exec(r.stdout ?? ""); lane.summary = m ? m[1].replace(/\x1b\[[0-9;]*m/g, "").trim() : null;
  if (verify) { const v = spawnSync(verify[0], verify.slice(1), { encoding: "utf8" }); lane.verify = { argv: verify, exit: v.status, output: v.stdout.trim() || v.stderr.trim() }; }
  lanes.push(lane); console.log(name, lane.exit, lane.summary, lane.verify?.output ?? "");
};
const node = process.execPath;
// contract
run("contract", [node, ...plan.commands[0].argv.slice(1), "--reporter=default", "--reporter=json", "--outputFile", path.join(out, "contract.json")], {});
// PostgreSQL: disposable server, generated password, random loopback port
const img = "postgres:16.15-alpine@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685";
const port = await new Promise(r => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
const pw = randomBytes(24).toString("hex"), pg = "zenith-plugin-pg-" + randomBytes(6).toString("hex");
sh("docker", ["run", "--pull", "never", "-d", "--name", pg, "--memory", "512m", "--cpus", "1", "-e", "POSTGRES_PASSWORD=" + pw, "-e", "POSTGRES_DB=zenith_plugin", "-p", `127.0.0.1:${port}:5432`, img]);
const psql = (sql) => sh("docker", ["exec", "-i", pg, "psql", "-qtA", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "zenith_plugin"], { input: sql });
let pgProof;
const pgUrl = `postgres://postgres:${pw}@127.0.0.1:${port}/zenith_plugin`;
const tls = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-plugin-tls.")); fs.chmodSync(tls, 0o700);
try {
  for (let i = 0; i < 60; i++) { if (spawnSync("docker", ["exec", pg, "pg_isready", "-U", "postgres", "-d", "zenith_plugin"]).status === 0) break; await new Promise(r => setTimeout(r, 1000)); }
  psql("create role service_role;"); psql(fs.readFileSync("supabase/migrations/0006_agent_link.sql", "utf8"));
  const tables = () => psql("select count(*) from information_schema.tables where table_schema not in ('pg_catalog','information_schema')");
  const tablesBefore = tables();
  run("postgres", [node, "node_modules/vitest/vitest.mjs", "run", "tests/plugins/launch-integration.test.ts", "tests/plugins/service.test.ts", "--no-file-parallelism", "--maxWorkers=2", "--reporter=default", "--reporter=json", "--outputFile", path.join(out, "postgres.json")],
    { ZENITH_TEST_PLATFORM_PG_URL: pgUrl });
  pgProof = { image: img, tablesBeforeTests: Number(tablesBefore), tablesAfterTests: Number(tables()), pluginTables: psql("select string_agg(table_schema||'.'||table_name, ',' order by 1) from information_schema.tables where table_name like '%plugin%'") };
  sh("docker", ["pull", "-q", "--platform", "linux/arm64", "node:22.23.3-bookworm-slim"]);
  const sandbox = sh("docker", ["image", "inspect", "node:22.23.3-bookworm-slim", "--format", "{{index .RepoDigests 0}}"]);
  pgProof.pluginSandboxImage = sandbox;
  fs.writeFileSync(path.join(tls, "openssl.cnf"), "[req]\nprompt = no\ndistinguished_name = dn\nx509_extensions = v3\n[dn]\nCN = host.docker.internal\n[v3]\nsubjectAltName = DNS:host.docker.internal,IP:127.0.0.1\nbasicConstraints = critical,CA:TRUE\nkeyUsage = critical,digitalSignature,keyEncipherment,keyCertSign\n");
  spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-config", path.join(tls, "openssl.cnf"), "-keyout", path.join(tls, "server.key"), "-out", path.join(tls, "server.crt")]);
  fs.chmodSync(path.join(tls, "server.key"), 0o600);
  const env = { ZENITH_TEST_PLATFORM_PG_URL: pgUrl, ZENITH_TEST_PLUGIN_DOCKER: "1", ZENITH_PLUGIN_SANDBOX_IMAGE: sandbox,
    ZENITH_PLUGIN_TEST_TLS_CERT_FILE: path.join(tls, "server.crt"), ZENITH_PLUGIN_TEST_TLS_KEY_FILE: path.join(tls, "server.key") };
  // Every registered case except the operated browser lane, which needs the J1/J3 stack and is recorded as not run.
  for (const c of plan.commands.filter(c => c.id)) {
    const fix = (a) => a.startsWith(".data-ci-lane/") ? path.join(out, path.basename(a)) : a;
    if (c.argv.includes("tests/cli/plugin-platform-live.test.ts")) { lanes.push({ name: c.id, notRun: "operated browser lane: needs J1 stack, J3 MFA fixture, Mailpit and Chromium" }); continue; }
    run(c.id, [node, ...c.argv.slice(1).map(fix)], Object.fromEntries(Object.entries(env).filter(([k]) => [...(c.gates ?? []), ...(c.privatePrerequisites ?? [])].includes(k))), [node, ...c.verify.slice(1).map(fix)]);
  }
} finally { spawnSync("docker", ["rm", "--force", pg]); fs.rmSync(tls, { recursive: true, force: true }); }
const leftovers = { containers: sh("docker", ["ps", "-aq", "--filter", "label=zenith.plugin.launch"]), volumes: sh("docker", ["volume", "ls", "-q", "--filter", "label=zenith.plugin.launch"]), pgContainer: sh("docker", ["ps", "-aq", "--filter", "name=" + pg]) };
const after = freeze();
const receipt = { schemaVersion: 1, requirement: "PROD-UX-03", recordedAt: new Date().toISOString(), executionReceiptComplete: lanes.every(l => l.notRun || (l.exit === 0 && (!l.verify || l.verify.exit === 0))),
  sourceFreeze: { before, after, unchanged: JSON.stringify(before) === JSON.stringify(after) },
  environment: { host: `${os.type()} ${os.arch()}`, node: process.version, docker: sh("docker", ["version", "--format", "{{.Server.Version}}"]), postgres: pgProof },
  floors: { requiredFreeBytes: 22 * 2 ** 30, minimumObservedFreeBytes: Math.min(...lanes.filter(l => l.freeBytesBefore).map(l => l.freeBytesBefore)), met: Math.min(...lanes.filter(l => l.freeBytesBefore).map(l => l.freeBytesBefore)) >= 22 * 2 ** 30 },
  lanes, reportSha256: Object.fromEntries(fs.readdirSync(out).filter(f => f.endsWith(".json")).map(f => [f, sha(fs.readFileSync(path.join(out, f)))])), cleanup: { ...leftovers, clean: !leftovers.containers && !leftovers.volumes && !leftovers.pgContainer, tlsDirectoryRemoved: !fs.existsSync(tls) } };
const body = JSON.stringify(receipt, null, 2); fs.writeFileSync(path.join(out, "receipt.json"), body + "\n"); fs.writeFileSync(path.join(out, "receipt.json.sha256"), sha(body + "\n") + "\n");
console.log(JSON.stringify({ unchanged: receipt.sourceFreeze.unchanged, floors: receipt.floors.met, cleanup: receipt.cleanup.clean, pg: pgProof }));
