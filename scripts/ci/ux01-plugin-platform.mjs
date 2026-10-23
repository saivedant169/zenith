#!/usr/bin/env node
/**
 * PROD-UX-01 operated plugin-platform case (wave6-546689f4b22fdb85) on this Mac: a real J1 API behind its HTTPS
 * edge, a real browser AAL2 session, a signed fixture plugin and the actual Docker sandbox. Two phases:
 *
 *   node --import tsx scripts/ci/ux01-plugin-platform.mjs publishers <new 0700 private dir>
 *     writes <dir>/plugin-platform.json (public verify key, for up.mjs --plugin-platform) and the publisher key.
 *   ZENITH_ACCEPTANCE_DEFAULT_STACK=1 node scripts/acceptance/default-stack/up.mjs --profile lean \
 *     --plugin-platform <dir>/plugin-platform.json --directory <stack>
 *   NODE_EXTRA_CA_CERTS=<stack>/tls/ca.crt node --import tsx scripts/ci/ux01-plugin-platform.mjs run <dir> <stack> <new evidence dir>
 *
 * The run phase stops the execution worker and Temporal (memory), creates one disposable operator, workspace,
 * project and linked parent credential, serves the plugin artifact over HTTPS from the stack's CA-signed edge
 * certificate, runs the gated case and verifies it. Passwords, cookies and tokens stay in the private dir,
 * which is removed afterwards. Nothing secret is printed.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, createPrivateKey, X509Certificate, randomBytes } from "node:crypto";
import fs from "node:fs"; import https from "node:https"; import path from "node:path"; import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = process.cwd();
if (!fs.existsSync(path.join(repo, "scripts/ci/ux01-plugin-platform.mjs"))) throw new Error("run from the repository root");
const PUBLISHER = "acme", KEY_ID = "acme-ux01", CASE = "wave6-546689f4b22fdb85";
const SANDBOX = "node@sha256:3ed98443660ff48413b5af19ecefce3b9d50845a901a43420d47cc63a9fddbe9";
const sha = (v) => createHash("sha256").update(v).digest("hex");
const sh = (cmd, args) => { const r = spawnSync(cmd, args, { encoding: "utf8" }); if (r.status !== 0) throw new Error(`${cmd} failed`); return r.stdout.trim(); };
const privateDir = (dir, create) => {
  const d = path.resolve(dir);
  if (d.startsWith(repo + path.sep)) throw new Error("private dir must be outside the checkout");
  if (create) { if (fs.existsSync(d)) throw new Error("private dir exists"); fs.mkdirSync(d, { mode: 0o700 }); }
  const st = fs.lstatSync(d); if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o077)) throw new Error("private dir must be 0700");
  return d;
};
const write = (file, text) => fs.writeFileSync(file, text, { mode: 0o600, flag: "wx" });
const spki = (pem) => createHash("sha256").update(new X509Certificate(pem).publicKey.export({ type: "spki", format: "der" })).digest("base64");

const [phase, ...args] = process.argv.slice(2);
if (phase === "publishers") {
  const dir = privateDir(args[0] ?? "", true);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
  write(path.join(dir, "plugin-platform.json"), JSON.stringify({ publishers: { [PUBLISHER]: [{ keyId: KEY_ID, publicKey: raw }] } }));
  write(path.join(dir, "publisher.key"), privateKey.export({ format: "pem", type: "pkcs8" }));
  console.log(JSON.stringify({ publisherKeyId: KEY_ID }));
} else if (phase === "run") {
  const dir = privateDir(args[0] ?? ""), stackDir = path.resolve(args[1] ?? ""), out = path.resolve(args[2] ?? "");
  if (!args[2] || fs.existsSync(out)) throw new Error("usage: run <private dir> <stack dir> <new evidence dir>");
  const freeze = () => ({ head: sh("git", ["rev-parse", "HEAD"]), tracked: sh("git", ["status", "--porcelain", "--untracked-files=no"]) });
  const before = freeze(); if (before.tracked) throw new Error("tracked changes present");
  await import(pathToFileURL(path.join(repo, "scripts/acceptance/loopback-docker-host.mjs")).href);
  process.env.ZENITH_ACCEPTANCE_DEFAULT_STACK = "1";
  const runtime = await import(pathToFileURL(path.join(repo, "scripts/acceptance/default-stack/runtime.mjs")).href);
  const state = runtime.readState(stackDir);
  const plugin = state.pluginPlatform;
  if (!plugin?.origin || new URL(plugin.origin).hostname !== "host.docker.internal") throw new Error("stack was not started with --plugin-platform");
  if (path.resolve(process.env.NODE_EXTRA_CA_CERTS ?? "") !== path.resolve(plugin.caFile)) throw new Error("set NODE_EXTRA_CA_CERTS to the stack CA");
  const trust = JSON.parse(fs.readFileSync(path.join(dir, "plugin-platform.json"), "utf8")).publishers;
  // Memory: the case needs the API, Auth, PostgREST and the database, not execution.
  await runtime.compose(state, ["stop", "execution-worker", "temporal"]);
  const support = await import(pathToFileURL(path.join(repo, "tests/e2e/default/support.mjs")).href);
  const { enrollOperator } = await import(pathToFileURL(path.join(repo, "tests/e2e/default/mfa.mjs")).href);
  const { baseManifest, signManifest } = await import(pathToFileURL(path.join(repo, "tests/plugins/support.ts")).href);
  const { archive } = await import(pathToFileURL(path.join(repo, "tests/plugins/launcher-support.ts")).href);
  const { chromium } = await import("@playwright/test");
  const input = JSON.parse(support.privateFile(path.join(stackDir, "input.json")));
  const stack = { apiUrl: plugin.origin, supabaseUrl: new URL(input.environment.SUPABASE_URL).origin, adminKey: input.environment.SUPABASE_SERVICE_ROLE_KEY };
  const tls = path.join(stackDir, "tls");
  const pins = ["edge.crt", "api-edge.crt"].map((f) => spki(fs.readFileSync(path.join(tls, f)))).join(",");
  const browser = await chromium.launch({ headless: true, args: [`--ignore-certificate-errors-spki-list=${pins}`, "--host-resolver-rules=MAP host.docker.internal 127.0.0.1"] });
  const users = []; let server; const lanes = []; const chromiumVersion = browser.version();
  try {
    const user = await support.operator(stack, state.mailpitUrl, "p", users);
    const context = await browser.newContext(); const page = await context.newPage();
    // Sign in as mfa-fixtures does: a new operator has no workspace yet, so bootstrap follows workspace creation.
    await page.goto(plugin.origin + "/login?next=/overview");
    await page.getByLabel("Email", { exact: true }).fill(user.email);
    await page.getByLabel("Password", { exact: true }).fill(user.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL((url) => url.origin === plugin.origin && url.pathname !== "/login");
    const workspace = support.ok(await support.browserRequest(page, "/api/workspace", { name: "Zenith UX-01 plugin " + Date.now() })).workspace;
    support.ok(await support.browserRequest(page, "/api/bootstrap"));
    await enrollOperator(page, stack);
    const name = "UX-01 plugin " + randomBytes(4).toString("hex");
    const created = await support.action(page, "project.create", { name });
    if (typeof created.environmentId !== "string") throw new Error("no default environment");
    const parent = await support.linkedAgent(page, stack, { id: created.projectId, name }, workspace.id);
    const cookie = (await context.cookies(plugin.origin)).map((c) => c.name + "=" + c.value).join("; ");
    // Artifact over HTTPS from the stack's CA-signed edge certificate (127.0.0.1); the launcher verifies its digest.
    const bytes = archive([{ name: "main.mjs", content: "setInterval(() => {}, 1000);" }]);
    server = https.createServer({ cert: fs.readFileSync(path.join(tls, "edge.crt")), key: fs.readFileSync(path.join(tls, "edge.key")) },
      (req, res) => { if (req.url === "/plugin.tgz") { res.writeHead(200, { "content-type": "application/gzip" }); res.end(bytes); } else { res.writeHead(404); res.end(); } });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const version = `1.0.${Date.now() % 100000}`;
    const manifest = signManifest(baseManifest({ id: `${PUBLISHER}/ux01-viewer-${randomBytes(3).toString("hex")}`, version,
      artifact: { format: "tar.gz", url: `https://127.0.0.1:${server.address().port}/plugin.tgz`, digest: `sha256:${sha(bytes)}` },
      components: { mcpServers: [{ name: "zenith", transport: "stdio", command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/main.mjs"], env: { ZENITH_API_VERSION: "3" } }] } }),
    createPrivateKey(fs.readFileSync(path.join(dir, "publisher.key"))), KEY_ID);
    const manifestFile = path.join(dir, "manifest.json"), cookieFile = path.join(dir, "cookie.txt");
    write(manifestFile, JSON.stringify(manifest)); write(cookieFile, cookie);
    fs.mkdirSync(out, { recursive: true });
    const report = path.join(out, `${CASE}.json`);
    const argv = [process.execPath, "node_modules/vitest/vitest.mjs", "run", "tests/cli/plugin-platform-live.test.ts", "--reporter=default", "--reporter=json", "--outputFile", report];
    const started = new Date().toISOString();
    // Async: this process serves the artifact while the case runs.
    const r = await new Promise((resolve) => { const child = spawn(argv[0], argv.slice(1), { env: { ...process.env,
      NODE_OPTIONS: `--import ${path.join(repo, "scripts/acceptance/loopback-docker-host.mjs")}`,
      ZENITH_TEST_PLUGIN_PLATFORM: "1", ZENITH_PLUGIN_PLATFORM_ORIGIN: plugin.origin, ZENITH_PLUGIN_PLATFORM_MANIFEST_FILE: manifestFile,
      ZENITH_PLUGIN_PLATFORM_BROWSER_COOKIE_FILE: cookieFile, ZENITH_PLUGIN_PLATFORM_WORKSPACE: workspace.id,
      ZENITH_PLUGIN_PLATFORM_PARENT_ID: parent.credentialId, ZENITH_PLUGIN_PLATFORM_PROJECT: created.projectId,
      ZENITH_PLUGIN_PLATFORM_ENVIRONMENT: created.environmentId, ZENITH_PLUGIN_SANDBOX_IMAGE: SANDBOX, ZENITH_PLUGIN_PLATFORM_SERVER: "zenith",
      ZENITH_PLUGIN_TEST_TLS_CERT_FILE: plugin.caFile, ZENITH_PLUGIN_TRUSTED_PUBLISHERS: JSON.stringify(trust) } });
      let stdout = "", stderr = ""; child.stdout.on("data", (d) => { stdout += d; }); child.stderr.on("data", (d) => { stderr += d; });
      child.on("close", (status) => resolve({ status, stdout, stderr })); });
    // Test output names no secret: the fixture inputs are files, and the case prints only its own assertions.
    fs.writeFileSync(path.join(out, "plugin-platform.log"), (r.stdout ?? "") + (r.stderr ?? ""));
    const v = spawnSync(process.execPath, ["scripts/ci/wave6-gates.mjs", "--case", CASE, "--report", report], { encoding: "utf8" });
    lanes.push({ name: "plugin-platform", argv: argv.slice(1), started, finished: new Date().toISOString(), exit: r.status,
      summary: /Tests\s+(.*)/.exec(r.stdout ?? "")?.[1]?.replace(/\x1b\[[0-9;]*m/g, "").trim() ?? null,
      verify: { id: CASE, exit: v.status, output: v.stdout.trim() || v.stderr.trim() } });
  } finally {
    await browser.close(); server?.close();
    for (const id of users) await support.jsonRequest(stack.supabaseUrl + "/auth/v1/admin/users/" + id, { method: "DELETE", headers: support.adminHeaders(stack) }).catch(() => undefined);
  }
  const leftovers = sh("docker", ["ps", "-aq", "--filter", "name=zenith-plugin"]);
  fs.rmSync(dir, { recursive: true, force: true });
  const after = freeze();
  const receipt = { schemaVersion: 1, requirement: "PROD-UX-01", case: CASE, recordedAt: new Date().toISOString(),
    sourceFreeze: { before, after, unchanged: JSON.stringify(before) === JSON.stringify(after) },
    stack: { profile: state.profile, source: state.source, origin: plugin.origin, stoppedForMemory: ["execution-worker", "temporal"] },
    runner: { file: "scripts/ci/ux01-plugin-platform.mjs", sha256: sha(fs.readFileSync(fileURLToPath(import.meta.url))) },
    environment: { host: `${os.type()} ${os.arch()}`, node: process.version, docker: sh("docker", ["version", "--format", "{{.Server.Version}}"]),
      chromium: chromiumVersion, sandboxImage: SANDBOX },
    lanes, reportSha256: Object.fromEntries(fs.readdirSync(out).filter((f) => f.endsWith(".json")).map((f) => [f, sha(fs.readFileSync(path.join(out, f)))])),
    cleanup: { pluginContainers: leftovers, privateDirRemoved: !fs.existsSync(dir), operatorsDeleted: users.length } };
  const body = JSON.stringify(receipt, null, 2) + "\n";
  fs.writeFileSync(path.join(out, "receipt.json"), body); fs.writeFileSync(path.join(out, "receipt.json.sha256"), sha(body) + "\n");
  console.log(JSON.stringify({ unchanged: receipt.sourceFreeze.unchanged, failed: lanes.filter((l) => l.exit !== 0 || l.verify.exit !== 0).map((l) => l.name), leftovers: !!leftovers }));
} else throw new Error("usage: publishers <dir> | run <dir> <stack> <out>");
