#!/usr/bin/env node
/** Native disposable setup around the existing acceptance engine. Node built-ins only. */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, open, readFile, readdir, realpath, rm, statfs, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packagedWorkerManifest } from "./gate-manifest.mjs";
import { assertOwnedPackagedBuilder, command as acceptanceCommand, createPrivateScratch, packagedSourceDigest, sanitizeClientEvidence, sanitizePackagedReadiness, sanitizePackagedSweepEvidence, sanitizePgWaiterEvidence, sanitizeRuntimeFilesystemEvidence, sanitizeTemporalControlEvidence, sanitizePackagedBuildFailure } from "../acceptance/packaged-worker.mjs";

const BUILDKIT_IMAGE = "moby/buildkit:buildx-stable-1@sha256:cec9f139f45e93c5c69c60f8b07cfad9f43f4ef6b6a6cd917527fea5ff2e3dea";
const REFUSALS = ["missing-schema", "invalid-secret", "invalid-signer", "plaintext-temporal", "missing-namespace", "wrong-queue"];
const MIN_DISK = 18, MIN_TOTAL_RAM = 12, MIN_AVAILABLE_RAM = 8;
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const sha256 = value => createHash("sha256").update(value).digest("hex");
const fail = () => { throw new Error("Native packaged-worker evidence is incomplete or mismatched."); };
const round = value => Math.floor(value * 100) / 100;

/** Linux-only process identity. The live session leader reserves its own PID/PGID. */
async function processIdentity(pid) {
  if (process.platform !== "linux" || !Number.isSafeInteger(pid) || pid < 1) fail();
  const value = await readFile(`/proc/${pid}/stat`, "utf8"), end = value.lastIndexOf(") "), fields = value.slice(end + 2).trim().split(/\s+/);
  if (end < 0 || Number(value.slice(0, value.indexOf(" "))) !== pid || fields.length < 20
    || ![fields[1], fields[2], fields[3], fields[19]].every(field => /^[0-9]+$/.test(field))) fail();
  return { pid, parent: Number(fields[1]), group: Number(fields[2]), session: Number(fields[3]), start: fields[19] };
}
async function ownedLeader(owner) {
  const actual = await processIdentity(owner.pid);
  if (actual.group !== owner.pid || actual.session !== owner.pid || actual.start !== owner.start) fail();
  return actual;
}
async function groupMembers(owner) {
  await ownedLeader(owner);
  const entries = await readdir("/proc"), members = [];
  for (const entry of entries) {
    if (!/^[1-9][0-9]*$/.test(entry)) continue;
    let actual;
    try { actual = await processIdentity(Number(entry)); }
    catch (error) { if (error.code === "ENOENT" || error.code === "ESRCH") continue; throw error; }
    if (actual.pid !== owner.pid && actual.group === owner.pid) {
      if (actual.session !== owner.pid) fail();
      members.push(actual);
    }
  }
  await ownedLeader(owner);
  return members;
}
export class NativeProcessSettlementError extends Error {
  constructor() { super("Native owned process settlement is unconfirmed."); this.code = "native_process_unsettled"; }
}
/** Fixed IPC facts only. A message is accepted while its original leader is still alive. */
export function assertOwnedProcessProof(value, expected, state) {
  if (!["reserved", "settled"].includes(state) || !Number.isSafeInteger(expected.pid) || expected.pid < 2
    || !record(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify((state === "reserved"
    ? ["state", "nonce", "pid", "group", "session", "start"] : ["state", "nonce", "pid", "group", "session", "start", "code", "interrupted"]).sort())
    || value.state !== state || value.nonce !== expected.nonce || !/^[a-f0-9]{32}$/.test(value.nonce ?? "")
    || value.pid !== expected.pid || value.group !== expected.pid || value.session !== expected.pid
    || !/^[0-9]+$/.test(value.start ?? "") || (expected.start && value.start !== expected.start)
    || (state === "settled" && (!Number.isInteger(value.code) || value.code < 0 || value.code > 255 || typeof value.interrupted !== "boolean" || value.interrupted && value.code === 0))) fail();
  return value;
}

/** Internal stock-Node supervisor; no CLI mode, worker controller or caller authority. */
export async function nativeProcessSupervisor() {
  if (process.platform !== "linux" || typeof process.send !== "function") throw new NativeProcessSettlementError();
  const reservation = new Promise(resolve => process.once("message", resolve));
  process.send({ state: "waiting", pid: process.pid });
  const identity = await processIdentity(process.pid);
  if (process.pid < 2 || identity.group !== process.pid || identity.session !== process.pid) throw new NativeProcessSettlementError();
  let nonce, child, started = false, finishing = false, interrupted = false, sweeping = false, timer, force, graceMs = 30_000;
  const owner = { ...identity }, wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const send = value => new Promise((resolve, reject) => process.send(value, error => error ? reject(error) : resolve()));
  const signalGroup = async signal => {
    await ownedLeader(owner); sweeping = true;
    // This leader remains live through TERM/settlement. KILL includes it and
    // deliberately supplies no settlement receipt; outer cleanup must refuse.
    process.kill(-process.pid, signal);
  };
  const cancel = () => {
    interrupted = true;
    if (child) {
      void signalGroup("SIGTERM").catch(() => { process.kill(-process.pid, "SIGKILL"); });
      force ??= setTimeout(() => { void signalGroup("SIGKILL").catch(() => { process.kill(-process.pid, "SIGKILL"); }); }, graceMs);
    }
  };
  process.on("SIGINT", () => { if (!sweeping) cancel(); });
  process.on("SIGTERM", () => { if (!sweeping) cancel(); });
  process.on("disconnect", () => { if (!finishing) cancel(); });
  try {
    const request = await reservation;
    if (!record(request) || request.state !== "reserve" || !/^[a-f0-9]{32}$/.test(request.nonce ?? "")) fail();
    nonce = request.nonce;
    const facts = { nonce, pid: owner.pid, group: owner.group, session: owner.session, start: owner.start };
    const launching = new Promise(resolve => {
      const timeout = setTimeout(() => resolve(undefined), 10_000);
      process.once("message", message => { clearTimeout(timeout); resolve(message); });
    });
    await send({ state: "reserved", ...facts });
    const config = await launching;
    if (!record(config) || config.state !== "launch" || config.nonce !== nonce || typeof config.binary !== "string" || !path.isAbsolute(config.binary)
      || !Array.isArray(config.args) || !config.args.every(arg => typeof arg === "string") || !record(config.env)
      || !Number.isInteger(config.timeout) || config.timeout < 1 || !Number.isInteger(config.grace) || config.grace < 1) fail();
    graceMs = config.grace;
    process.on("message", message => { if (message?.state === "cancel" && message.nonce === nonce) cancel(); });
    await ownedLeader(owner);
    started = true;
    child = spawn(config.binary, config.args, { cwd: config.cwd, env: config.env, stdio: "inherit" });
    timer = setTimeout(cancel, config.timeout);
    if (interrupted) cancel();
    const code = await new Promise(resolve => { child.once("error", () => resolve(1)); child.once("exit", code => resolve(code ?? 1)); });
    if ((await groupMembers(owner)).length) interrupted = true;
    // Sweep even when the first inventory is empty, then require repeated empty
    // inventories. No member can be signalled via a recycled numeric PID.
    await signalGroup("SIGTERM");
    const deadline = Date.now() + config.grace; let empty = 0;
    while (empty < 2) {
      empty = (await groupMembers(owner)).length ? 0 : empty + 1;
      if (Date.now() >= deadline) await signalGroup("SIGKILL");
      if (empty < 2) await wait(50);
    }
    clearTimeout(timer); clearTimeout(force);
    const result = { state: "settled", ...facts, code: interrupted ? 1 : code, interrupted };
    const acknowledgement = new Promise(resolve => { const timeout = setTimeout(() => resolve(undefined), 10_000); process.on("message", message => {
      if (message?.state === "finish" && message.nonce === nonce) { clearTimeout(timeout); resolve(message); }
    }); });
    await send(result);
    const ack = await acknowledgement;
    if (!ack || (await groupMembers(owner)).length) fail();
    finishing = true; process.disconnect(); process.exit(result.code);
  } catch {
    clearTimeout(timer); clearTimeout(force);
    if (started) await signalGroup("SIGKILL");
    process.exit(1);
  }
}

/** One invocation-created leader, one program, and explicit descendant settlement.
 * @param {string} binary
 * @param {string[]} args
 * @param {{ env?: NodeJS.ProcessEnv, timeout?: number, grace?: number, signal?: AbortSignal, stdout?: number, stderr?: number, onReserved?: (owner: { state: string, nonce: string, pid: number, group: number, session: number, start: string }) => Promise<void> }} [options]
 * @returns {Promise<{ code: number, out: string, err: string, interrupted: boolean, settled: true }>}
 */
export async function runOwnedProcess(binary, args, { env = process.env, timeout = 120_000, grace = 30_000, signal, stdout, stderr, onReserved } = {}) {
  if (process.platform !== "linux" || !path.isAbsolute(binary)) throw new NativeProcessSettlementError();
  const nonce = randomBytes(16).toString("hex"), source = `import { nativeProcessSupervisor } from ${JSON.stringify(import.meta.url)}; await nativeProcessSupervisor();`;
  const supervisor = spawn(process.execPath, ["--input-type=module", "-e", source], { detached: true, stdio: ["ignore", stdout ?? "pipe", stderr ?? "pipe", "ipc"] });
  const expected = { nonce, pid: supervisor.pid };
  let owner, settled, out = "", err = "", refused = false, cancelled = false, waiting = false, launched = false, completed = false, outputBytes = 0;
  const cancel = () => { cancelled = true; if (launched && supervisor.connected) supervisor.send({ state: "cancel", nonce }); };
  process.on("SIGINT", cancel); process.on("SIGTERM", cancel); signal?.addEventListener("abort", cancel, { once: true });
  const capture = (key, chunk) => { outputBytes += chunk.length; if (outputBytes > 2 * 1024 * 1024) { refused = true; cancel(); }
    else if (key === "out") out += chunk; else err += chunk; };
  supervisor.stdout?.on("data", chunk => capture("out", chunk)); supervisor.stderr?.on("data", chunk => capture("err", chunk));
  let chain = Promise.resolve();
  const completion = new Promise((resolve, reject) => {
    supervisor.on("message", message => { chain = chain.then(async () => {
      if (message?.state === "waiting") {
        if (waiting || owner || message.pid !== expected.pid || JSON.stringify(Object.keys(message).sort()) !== JSON.stringify(["pid", "state"])) fail();
        waiting = true; supervisor.send({ state: "reserve", nonce }); return;
      }
      if (!owner) {
        if (!waiting) fail();
        owner = assertOwnedProcessProof(message, expected, "reserved"); await ownedLeader(owner);
        if (onReserved) await onReserved(owner);
        if (signal?.aborted || cancelled) { refused = true; launched = true; supervisor.send({ state: "launch", nonce, binary: process.execPath, args: ["-e", "process.exit(1)"], env: {}, cwd: process.cwd(), timeout: 1000, grace }); return; }
        launched = true;
        supervisor.send({ state: "launch", nonce, binary, args, env, cwd: process.cwd(), timeout, grace });
      } else {
        if (settled) fail();
        const proof = assertOwnedProcessProof(message, owner, "settled"); await ownedLeader(owner);
        if ((await groupMembers(owner)).length) fail();
        settled = proof;
        supervisor.send({ state: "finish", nonce });
      }
    }).catch(() => { refused = true; cancel(); }); });
    supervisor.once("error", reject);
    supervisor.once("close", code => { completed = true; void chain.then(() => {
      if (!settled || code !== settled.code) reject(new NativeProcessSettlementError());
      else resolve({ code: refused || cancelled ? 1 : code, out, err, interrupted: cancelled || settled.interrupted, settled: true });
    }, reject); });
  });
  // Reservation/setup is bounded separately; signal the live child handle only,
  // never a numeric group after its leader has exited. A missing receipt refuses.
  const startup = setTimeout(() => { if (!owner && !completed) supervisor.kill("SIGTERM"); }, 10_000);
  if (signal?.aborted) cancel();
  try { return await completion; }
  catch { throw new NativeProcessSettlementError(); }
  finally { clearTimeout(startup); process.off("SIGINT", cancel); process.off("SIGTERM", cancel); signal?.removeEventListener("abort", cancel); }
}

let inheritedOwner, mainCancellation;
async function command(binary, args, phase, options = {}) {
  if (mainCancellation?.aborted) fail();
  if (path.basename(binary) !== "docker") return acceptanceCommand(binary, args, phase, options);
  if (inheritedOwner) {
    const current = await processIdentity(process.pid); await ownedLeader(inheritedOwner);
    if (current.group !== inheritedOwner.pid || current.session !== inheritedOwner.pid) throw new NativeProcessSettlementError();
    return acceptanceCommand(binary, args, phase, options); // Whole enclosing group is retained by the parent.
  }
  const result = await runOwnedProcess(binary, args, { timeout: options.timeout, signal: mainCancellation });
  if (result.code !== 0 && !options.allowFailure) fail();
  return { code: result.code, out: result.out, err: result.err };
}

/** @param {string[]} args @param {Record<string, string | undefined>} [env] */
export function parseNativeArgs(args, env = process.env) {
  if (args.length !== 5 || !["--run", "--validate", "--validate-artifact"].includes(args[0]) || args[1] !== "--platform" || args[3] !== "--evidence"
    || !["linux/amd64", "linux/arm64"].includes(args[2]) || !args[4] || args[4].startsWith("--")) fail();
  if (env.ZENITH_PACKAGED_WORKER_ACCEPTANCE !== "1") fail();
  return { mode: args[0], platform: args[2], evidence: path.resolve(args[4]) };
}

/** Public hosted-only admission is a resource restriction, never a skip. */
/** @param {string} platform @param {object} observation @param {Record<string, string | undefined>} [env] */
export function assertNativePrerequisites(platform, observation, env = process.env) {
  const arch = platform.split("/")[1], processArch = arch === "amd64" ? "x64" : "arm64";
  if (!record(observation) || observation.os !== "linux" || observation.processArch !== processArch
    || observation.dockerOS !== "linux" || observation.dockerArch !== arch
    || !/^unix:\/\//.test(observation.endpoint) || !/^22\.23\.3$/.test(observation.node)
    || observation.totalRamGiB < MIN_TOTAL_RAM || observation.availableRamGiB < MIN_AVAILABLE_RAM
    || observation.dockerRamGiB < MIN_TOTAL_RAM
    || [observation.sourceFreeGiB, observation.temporaryFreeGiB, observation.dockerFreeGiB].some(value => !Number.isFinite(value) || value < MIN_DISK)
    || [observation.totalRamGiB, observation.availableRamGiB, observation.dockerRamGiB].some(value => !Number.isFinite(value))) fail();
  if (env.GITHUB_ACTIONS === "true") {
    const runner = arch === "amd64" ? "ubuntu-24.04" : "ubuntu-24.04-arm";
    if (env.ZENITH_PACKAGED_REPOSITORY_VISIBILITY !== "public" || env.RUNNER_ENVIRONMENT !== "github-hosted"
      || env.ZENITH_PACKAGED_RUNNER_LABEL !== runner || env.RUNNER_OS !== "Linux"
      || env.RUNNER_ARCH !== (arch === "amd64" ? "X64" : "ARM64") || !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? "")) fail();
  }
  return { os: "linux", processArch, dockerOS: "linux", dockerArch: arch, emulated: false,
    node: observation.node, totalRamGiB: round(observation.totalRamGiB), availableRamGiB: round(observation.availableRamGiB),
    dockerRamGiB: round(observation.dockerRamGiB), sourceFreeGiB: round(observation.sourceFreeGiB),
    temporaryFreeGiB: round(observation.temporaryFreeGiB), dockerFreeGiB: round(observation.dockerFreeGiB) };
}

/** Reuse the acceptance engine's bounded native result validators; publish no original payloads. */
export function executedChecks(value, platform, childExitCode) {
  if (childExitCode !== 0 || !record(value) || value.status !== "passed" || value.platform !== platform
    || !new RegExp(`^zenith-pkg-${platform.split("/")[1]}-[a-f0-9]{12}$`).test(value.runId ?? "")) fail();
  const c = value.checks;
  if (!record(c)) fail();
  /** @type {Record<string, string>} */
  const result = {};
  const put = (id, condition) => { if (!condition) fail(); result[id] = "passed"; };
  const current = observation => {
    const parsed = sanitizeTemporalControlEvidence("observe", observation);
    return parsed.status === "completed" && parsed.current === true && parsed.paused === false;
  };
  put("native-architecture", value.environment?.dockerServerOS === "linux" && value.environment.dockerServerArch === platform.split("/")[1] && value.environment.emulated === false);
  put("fresh-source-image", digest(value.sourceInputSha256) && digest(value.acceptanceHarnessSha256) && value.dirty === false
    && value.sourceBinding?.inventoryComplete === true && value.sourceBinding.unchangedAcrossBuild === true && value.sourceBinding.immutableBuildContext === false);
  put("actual-entrypoint", value.image?.platform === platform && value.image.user === "zenith" && value.image.acceptanceDerivative === true
    && /^sha256:[a-f0-9]{64}$/.test(value.image.id ?? "") && JSON.stringify(value.image.entrypoint) === JSON.stringify(["/usr/bin/tini", "--", "node", "dist/execution/worker.cjs"]));
  put("private-tls-custody", c.tlsCustody?.generatedPrivateFiles === true && c.tlsCustody.caPrivateKeysHostOnly === true
    && c.tlsCustody.privateDirectories === true && c.tlsCustody.privateLeafFiles === true && c.tlsCustody.workerUid === 10001
    && c.tlsCustody.serverUid === 1000 && c.tlsCustody.hostMounts === false
    && ["ca", "server", "client", "rogue-client"].every(key => digest(c.tlsCustody.certificateSha256?.[key])));
  put("temporal-mtls-positive-and-negative", ["validClientAccepted", "noClientRefused", "untrustedClientRefused", "incorrectServerNameRefused", "realServerTls"].every(key => c.temporalAuthentication?.[key] === true)
    && c.temporalAuthentication.namespaceAuthorizationProven === false);
  put("owned-namespace", sanitizeTemporalControlEvidence("namespace", c.namespace).namespaceConfirmed === true);
  put("startup-refusals", REFUSALS.every(key => c[key] === "refused-without-secret-output" && value.refusalExits?.[key]?.status === "exited"
    && value.refusalExits[key].running === false && value.refusalExits[key].oomKilled === false
    && Number.isSafeInteger(value.refusalExits[key].exitCode) && value.refusalExits[key].exitCode > 0 && value.refusalExits[key].exitCode <= 255
    && value.refusalExits[key].failureCategory === (key === "missing-schema" ? "platform-store" : "configuration")));
  put("readiness-and-liveness", sanitizePackagedReadiness(c.readiness).ready === true && c.liveness?.alive === true);
  put("owned-reconcile-schedule", current(c.ownedSchedule));
  put("permitted-read-operation", sanitizeClientEvidence("operations", value.operations).operation.signedReadGrantVerified === true);
  const assets = sanitizeClientEvidence("assets", value.assets);
  // Runtime filesystem and nonroot uid are folded here: this check owns the worker's filesystem and uid contract.
  const runtime = sanitizeRuntimeFilesystemEvidence(value.runtimeFilesystem);
  put("packaged-assets-and-plan-retention", assets.arch === (platform === "linux/amd64" ? "x64" : "arm64") && assets.tofu[1] === `on linux_${platform.split("/")[1]}`
    && Object.entries(assets.dependencies).every(([name, version]) => value.lockedDependencies?.[name] === version)
    && assets.ssmDocuments.count === value.hostSsmDocuments?.count && assets.ssmDocuments.sha256 === value.hostSsmDocuments?.sha256
    && runtime.readonlyRootfs === true && runtime.capDropAll === true && runtime.noNewPrivileges === true && runtime.user === 10001
    && runtime.rootWriteRefused === true && runtime.tmpWritable === true);
  sanitizePgWaiterEvidence([c.sqlPrerequisiteOutage?.actualPgWaiter]);
  const deferred = sanitizeTemporalControlEvidence("observe", c.sqlPrerequisiteOutage?.deferred);
  put("sql-prerequisite-outage-and-recovery", c.sqlPrerequisiteOutage?.readinessRevoked === true && c.sqlPrerequisiteOutage.automaticPause === false
    && deferred.status === "deferred" && deferred.current === false && current(c.sqlPrerequisiteRecovery));
  for (const [id, key] of [["store-outage-and-recovery", "store-readiness-outage"], ["temporal-outage-and-recovery", "temporal-readiness-outage"]]) {
    put(id, c[key]?.readyStatus === 503 && c[key].liveStatus === 200 && c[`${key}-recovery`]?.freshRunConfirmed === true && current(c[`${key}-recovery`]));
  }
  put("durable-temporal-restart", c.temporalRestart?.sameOwnedDatabase === true && c.temporalRestart.ownedScheduleRetained === true && current(c.temporalRestart.freshPass));
  put("operator-pause-and-resume", c.operatorPause?.readinessRevoked === true && c.operatorPause.livenessRetained === true && c.operatorPause.resumedOnlyByOperator === true && current(c.operatorPause.freshPass));
  const drain = c.inFlightShutdown;
  sanitizePackagedSweepEvidence("activity", drain?.entered, value.runId);
  sanitizePackagedSweepEvidence("activity", drain?.afterSignal, value.runId);
  sanitizePackagedSweepEvidence("history", drain?.retainedHistory, value.runId);
  sanitizePgWaiterEvidence([drain?.actualPgWaiter]);
  sanitizePgWaiterEvidence([drain?.waiterDuringDrain]);
  put("actual-inflight-drain-and-fresh-worker", drain?.signal === "SIGTERM" && drain.exitCode === 0 && drain.drained === true && drain.inFlightActivity === true
    && drain.freshWorkerIdentity === `${value.runId}-recovery` && current(drain.freshPass) && drain.authorityReadback?.existingReadRefusalUnchanged === true
    && drain.sqlActivityAttributionProven === false && drain.providerMutationAccepted === false && drain.consumedApprovalPreservationProven === false && drain.receiptRecoveryProven === false);
  put("idle-drain", c.shutdown?.signal === "SIGTERM" && c.shutdown.exitCode === 0 && c.shutdown.drained === true && c.shutdown.inFlightActivity === false);
  put("private-files-and-owned-services-cleanup", value.cleanup?.privateFilesRemoved === true && value.cleanup.allCreatedResourcesRemoved === true
    && Array.isArray(value.cleanup.resources) && value.cleanup.resources.length > 0 && value.cleanup.resources.every(item => item.removed === true));
  return result;
}

export function parseHarnessOutput(output) {
  if (typeof output !== "string" || Buffer.byteLength(output) > 4 * 1024 * 1024) fail();
  const lines = output.split(/\r?\n/).filter(line => line.startsWith("{"));
  if (lines.length !== 1) fail();
  return JSON.parse(lines[0]);
}

const CHILD_FAILURE_PHASES = ["prerequisites", "fresh-image-build", "isolated-services", "private-temporal-tls", "owned-temporal-schema", "authenticated-temporal-server", "temporal-ready", "startup-refusals", "prepare-real-stores", "actual-worker-entrypoint", "real-temporal-operations", "filesystem-plan-maintenance", "bounded-sql-prerequisite-outage", "store-readiness-outage", "temporal-readiness-outage", "temporal-durable-restart", "operator-pause", "inflight-schema-shutdown", "inflight-fresh-worker-recovery", "graceful-shutdown"];
const CHILD_WORKER_CATEGORIES = ["module-load", "configuration", "health-listener", "platform-store", "platform-composition", "policy-assets", "plan-directory", "activity-composition", "reconcile-composition", "reconcile-client", "reconcile-pollers", "reconcile-schedule", "temporal-runtime", "workflow-bundle", "temporal-connect", "temporal-worker", "worker-lifecycle", "worker-run", "resource-close"];
const CHILD_INFLIGHT_GUARD_CATEGORIES = [
  "shutdown-authority-unconfirmed",
  "owned-worker-unconfirmed",
  "owned-control-unconfirmed",
  "control-session-request-invalid",
  "control-session-evidence-unconfirmed",
  "owned-worker-address-invalid",
  "schema-observer-identity-invalid",
  "shutdown-blocker-unconfirmed",
  "inflight-schema-waiter-unconfirmed",
  "schema-waiter-evidence-unconfirmed",
  "temporal-control-evidence-unconfirmed",
  "inflight-sweep-evidence-unconfirmed",
  "fresh-started-sweep-unconfirmed",
  "worker-drain-not-started",
  "held-drain-boundary-changed",
  "inflight-worker-drain-unconfirmed",
  "worker-lifecycle-output-refused",
  "shutdown-authority-changed",
  "fresh-worker-readiness-unconfirmed",
  "worker-readiness-evidence-incomplete",
  "fresh-schedule-result-unconfirmed",
  "fresh-worker-sweep-reused",
  "recovery-authority-changed"
];
const CHILD_COMMAND_CATEGORIES = [
  "command-launch",
  "command-timeout",
  "command-output-limit",
  "command-input",
  "command-exit",
  "command-signal"
];
const CHILD_INFLIGHT_COMMAND_PHASES = [
  "shutdown-authority-readback",
  "inflight-worker-address",
  "inflight-schema-blocker",
  "inflight-schema-held",
  "inflight-schema-waiter",
  "temporal-control-observe",
  "temporal-control-trigger",
  "temporal-control-activity",
  "inflight-sigterm",
  "inflight-drain-started",
  "inflight-drain-waiter",
  "inflight-worker-exit",
  "inflight-stopped-worker",
  "inflight-worker-lifecycle-logs",
  "fresh-recovery-entrypoint",
  "probe-readyz",
  "temporal-control-history",
  "inflight-control-session",
  "inflight-control-owner"
];
/** Fixed child categories only; optional in-flight facts never copy an error/payload.
 * @param {unknown} phase
 * @param {unknown} workerCategory
 * @param {unknown} [guardCategory]
 * @param {unknown} [commandCategory]
 * @param {unknown} [commandPhase]
 * @param {unknown} [buildFailure]
 */
export function sanitizeChildFailure(phase, workerCategory, guardCategory, commandCategory, commandPhase, buildFailure) {
  const inFlight = typeof phase === "string" && ["inflight-schema-shutdown", "inflight-fresh-worker-recovery"].includes(phase);
  const guard = inFlight && typeof guardCategory === "string" && CHILD_INFLIGHT_GUARD_CATEGORIES.includes(guardCategory);
  const command = inFlight && typeof commandCategory === "string" && CHILD_COMMAND_CATEGORIES.includes(commandCategory);
  const build = phase === "fresh-image-build" ? sanitizePackagedBuildFailure(buildFailure) : undefined;
  return { phase: typeof phase === "string" && CHILD_FAILURE_PHASES.includes(phase) ? phase : "unavailable",
    workerCategory: typeof workerCategory === "string" && CHILD_WORKER_CATEGORIES.includes(workerCategory) ? workerCategory : "unavailable",
    ...(guard ? { guardCategory } : {}), ...(command ? { commandCategory } : {}), ...(build ? { buildFailure: build } : {}),
    ...(command && typeof commandPhase === "string" && CHILD_INFLIGHT_COMMAND_PHASES.includes(commandPhase) ? { commandPhase } : {}) };
}

/** Artifact admission is distinct from a passing execution verdict, including failed prerequisites. */
export function assertArtifactShape(value, platform) {
  const manifest = packagedWorkerManifest(platform);
  const keys = ["schemaVersion", "lane", "kind", "status", "platform", "commit", "sourceInputSha256", "acceptanceHarnessSha256", "wrapperSha256", "manifestSha256", "workflowSha256", "github", "environment", "startedAt", "finishedAt", "childExitCode", "minimumObservedFreeGiB", "checks", "cleanup", "limitations", "failurePhase", "childFailure"];
  const iso = text => typeof text === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(text) && Number.isFinite(Date.parse(text));
  const phases = ["native-prerequisites", "owned-context-creation", "owned-builder-creation", "actual-packaged-worker", "final-owned-cleanup", "final-source-binding"];
  if (!record(value) || Object.keys(value).some(key => !keys.includes(key)) || value.schemaVersion !== 1 || value.lane !== "packaged-worker"
    || value.kind !== "native-packaged-worker" || !["passed", "failed"].includes(value.status) || value.platform !== platform
    || !iso(value.startedAt) || !iso(value.finishedAt) || Date.parse(value.finishedAt) < Date.parse(value.startedAt)
    || (value.status === "failed" ? !phases.includes(value.failurePhase) : value.failurePhase !== undefined)
    || (value.childExitCode !== null && (!Number.isSafeInteger(value.childExitCode) || value.childExitCode < 0 || value.childExitCode > 255))
    || (value.minimumObservedFreeGiB !== null && (!Number.isFinite(value.minimumObservedFreeGiB) || value.minimumObservedFreeGiB < 0))
    || (value.commit !== undefined && !/^[a-f0-9]{40}$/.test(value.commit))
    || ["sourceInputSha256", "acceptanceHarnessSha256", "wrapperSha256", "manifestSha256", "workflowSha256"].some(key => value[key] !== undefined && !digest(value[key]))
    || !record(value.checks) || Object.entries(value.checks).some(([key, status]) => !manifest.requiredChecks.includes(key) || status !== "passed")
    || !record(value.cleanup) || JSON.stringify(Object.keys(value.cleanup).sort()) !== JSON.stringify(["builderAbsent", "builderContainerAbsent", "cacheVolumeAbsent", "baselinePreserved", "wrapperPrivateFilesRemoved", "ownedContextAbsent"].sort())
    || Object.values(value.cleanup).some(flag => typeof flag !== "boolean") || JSON.stringify(value.limitations) !== JSON.stringify(manifest.limitations)) fail();
  if (value.childFailure !== undefined) {
    if (value.status !== "failed" || value.failurePhase !== "actual-packaged-worker" || !Number.isInteger(value.childExitCode) || value.childExitCode < 1
      || !record(value.childFailure)) fail();
    const diagnostic = sanitizeChildFailure(value.childFailure.phase, value.childFailure.workerCategory,
      value.childFailure.guardCategory, value.childFailure.commandCategory, value.childFailure.commandPhase, value.childFailure.buildFailure);
    if (JSON.stringify(Object.keys(value.childFailure).sort()) !== JSON.stringify(Object.keys(diagnostic).sort())
      || Object.entries(diagnostic).some(([key, field]) => JSON.stringify(value.childFailure[key]) !== JSON.stringify(field))) fail();
  }
  if (value.environment !== undefined) {
    const allowed = ["os", "processArch", "dockerOS", "dockerArch", "emulated", "node", "totalRamGiB", "availableRamGiB", "dockerRamGiB", "sourceFreeGiB", "temporaryFreeGiB", "dockerFreeGiB"];
    if (!record(value.environment) || Object.keys(value.environment).some(key => !allowed.includes(key))) fail();
    for (const [key, field] of Object.entries(value.environment)) {
      if (key.endsWith("GiB")) { if (field !== null && (!Number.isFinite(field) || field < 0)) fail(); }
      else if (key === "emulated") { if (field !== false) fail(); }
      else if (key === "node") { if (!["22.23.3", "unavailable"].includes(field)) fail(); }
      else if (["os", "dockerOS"].includes(key)) { if (!["linux", "unavailable"].includes(field)) fail(); }
      else if (!["x64", "amd64", "arm64", "unavailable"].includes(field)) fail();
    }
  }
  if (value.github !== undefined && (!record(value.github) || JSON.stringify(Object.keys(value.github).sort()) !== JSON.stringify(["runId", "runAttempt", "runnerLabel", "sha"].sort())
    || !/^[1-9][0-9]{0,15}$/.test(value.github.runId) || !/^[1-9][0-9]{0,5}$/.test(value.github.runAttempt)
    || !["ubuntu-24.04", "ubuntu-24.04-arm"].includes(value.github.runnerLabel) || value.github.sha !== value.commit)) fail();
  return true;
}

export function assertPublishedEvidence(value, expected) {
  assertArtifactShape(value, expected.platform);
  const required = packagedWorkerManifest(expected.platform).requiredChecks;
  const keys = ["schemaVersion", "lane", "kind", "status", "platform", "commit", "sourceInputSha256", "acceptanceHarnessSha256", "wrapperSha256", "manifestSha256", "workflowSha256", "github", "environment", "startedAt", "finishedAt", "childExitCode", "minimumObservedFreeGiB", "checks", "cleanup", "limitations"];
  const envKeys = ["os", "processArch", "dockerOS", "dockerArch", "emulated", "node", "totalRamGiB", "availableRamGiB", "dockerRamGiB", "sourceFreeGiB", "temporaryFreeGiB", "dockerFreeGiB"];
  const iso = text => typeof text === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(text) && Number.isFinite(Date.parse(text));
  if (!record(value) || Object.keys(value).some(key => !keys.includes(key)) || !record(value.environment)
    || Object.keys(value.environment).length !== envKeys.length || envKeys.some(key => !Object.hasOwn(value.environment, key))
    || !record(value.cleanup) || JSON.stringify(Object.keys(value.cleanup).sort()) !== JSON.stringify(["builderAbsent", "builderContainerAbsent", "cacheVolumeAbsent", "baselinePreserved", "wrapperPrivateFilesRemoved", "ownedContextAbsent"].sort())
    || !iso(value.startedAt) || !iso(value.finishedAt) || Date.parse(value.finishedAt) < Date.parse(value.startedAt)
    || !Number.isFinite(value.minimumObservedFreeGiB) || value.minimumObservedFreeGiB < 8
    || JSON.stringify(value.limitations) !== JSON.stringify(packagedWorkerManifest(expected.platform).limitations)
    || (!expected.github && value.github !== undefined)) fail();
  assertNativePrerequisites(expected.platform, { ...value.environment, endpoint: "unix:///verified-local-socket" }, {});
  if (!record(value) || value.schemaVersion !== 1 || value.lane !== "packaged-worker" || value.kind !== "native-packaged-worker"
    || value.status !== "passed" || value.platform !== expected.platform || value.commit !== expected.commit
    || value.childExitCode !== 0 || value.environment?.emulated !== false || value.environment.dockerOS !== "linux"
    || value.environment.dockerArch !== expected.platform.split("/")[1] || value.sourceInputSha256 !== expected.sourceInputSha256
    || value.acceptanceHarnessSha256 !== expected.acceptanceHarnessSha256 || value.wrapperSha256 !== expected.wrapperSha256
    || value.manifestSha256 !== expected.manifestSha256 || value.workflowSha256 !== expected.workflowSha256
    || !record(value.checks) || Object.keys(value.checks).length !== required.length || required.some(id => value.checks[id] !== "passed")
    || value.cleanup?.builderAbsent !== true || value.cleanup.cacheVolumeAbsent !== true || value.cleanup.builderContainerAbsent !== true
    || value.cleanup.baselinePreserved !== true || value.cleanup.wrapperPrivateFilesRemoved !== true || value.cleanup.ownedContextAbsent !== true) fail();
  if (expected.github && (value.github?.runId !== expected.github.runId || value.github.runAttempt !== expected.github.runAttempt
    || value.github.runnerLabel !== expected.github.runnerLabel || value.github.sha !== expected.commit
    || JSON.stringify(Object.keys(value.github).sort()) !== JSON.stringify(["runId", "runAttempt", "runnerLabel", "sha"].sort()))) fail();
  return true;
}

async function binary(name) {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    try { const candidate = await realpath(path.join(directory, name)); await access(candidate, constants.X_OK); return candidate; } catch { /* Continue exact PATH search. */ }
  }
  fail();
}
async function sourceFrame(platform) {
  const commit = (await command("git", ["rev-parse", "HEAD"], "native-source")).out.trim();
  if (!/^[a-f0-9]{40}$/.test(commit) || (await command("git", ["status", "--porcelain"], "native-source-clean")).out.trim()) fail();
  const frame = { platform, commit, sourceInputSha256: await packagedSourceDigest(process.cwd()),
    acceptanceHarnessSha256: sha256(await readFile("scripts/acceptance/packaged-worker.mjs")), wrapperSha256: sha256(await readFile("scripts/ci/packaged-worker-native.mjs")),
    manifestSha256: sha256(JSON.stringify(packagedWorkerManifest(platform))), workflowSha256: sha256(await readFile(".github/workflows/packaged-workers.yml")) };
  if (process.env.GITHUB_ACTIONS === "true") {
    if (commit !== process.env.GITHUB_SHA || !/^[1-9][0-9]{0,15}$/.test(process.env.GITHUB_RUN_ID ?? "") || !/^[1-9][0-9]{0,5}$/.test(process.env.GITHUB_RUN_ATTEMPT ?? "")
      || process.env.ZENITH_PACKAGED_RUNNER_LABEL !== (platform === "linux/amd64" ? "ubuntu-24.04" : "ubuntu-24.04-arm")) fail();
    frame.github = { runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT, runnerLabel: process.env.ZENITH_PACKAGED_RUNNER_LABEL, sha: commit };
  }
  return frame;
}

export function builderDescriptors(value) {
  if (typeof value !== "string") fail();
  const descriptors = new Map();
  for (const row of [...new Set(value.trim().split(/\r?\n/).filter(Boolean))]) {
    const fields = row.split("\t");
    if (fields.length !== 4 || !/^[A-Za-z0-9._-]{1,64}$/.test(fields[0]) || !/^[a-z-]{1,32}$/.test(fields[1])) fail();
    const nodes = fields[2].trim().split(/\s+/).filter(Boolean);
    if (!nodes.length || nodes.some(name => !/^[A-Za-z0-9._-]{1,64}$/.test(name)) || new Set(nodes).size !== nodes.length) fail();
    const endpoint = fields[3].trim();
    if (!endpoint || endpoint.length > 256 || /[\s\x00-\x1f]/.test(endpoint)) fail();
    const descriptor = { name: fields[0], driver: fields[1], nodes, endpoint };
    if (descriptors.has(descriptor.name) && JSON.stringify(descriptors.get(descriptor.name)) !== JSON.stringify(descriptor)) fail();
    descriptors.set(descriptor.name, descriptor);
  }
  return [...descriptors.values()].sort((a, b) => a.name.localeCompare(b.name));
}
async function nativeBuilders(docker) {
  return builderDescriptors((await command(docker, ["buildx", "ls", "--format", "{{.Builder.Name}}\t{{.Builder.Driver}}\t{{range .Builder.Nodes}}{{.Name}}\t{{.Endpoint}} {{end}}"], "native-builder-descriptors")).out);
}
const lines = value => [...new Set(value.trim().split(/\r?\n/).filter(Boolean))].sort();
async function inventory(docker) {
  const read = async args => lines((await command(docker, args, "native-baseline")).out);
  const builders = await nativeBuilders(docker);
  const result = { containers: await read(["ps", "-aq", "--no-trunc"]), images: await read(["image", "ls", "-q", "--no-trunc"]),
    networks: await read(["network", "ls", "-q", "--no-trunc"]), contexts: await read(["context", "ls", "--format", "{{.Name}}"]), volumes: await read(["volume", "ls", "-q"]),
    builders: builders.map(item => item.name), builderDescriptors: builders.map(item => JSON.stringify(item)),
    selectedBuilder: /^Name:\s+(\S+)\s*$/m.exec((await command(docker, ["buildx", "inspect"], "native-selected-builder")).out)?.[1] ?? "unavailable" };
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(result.selectedBuilder) || result.selectedBuilder === "unavailable") fail();
  return result;
}
export function baselinePreserved(before, after) {
  return ["containers", "images", "networks", "contexts", "volumes", "builders", "builderDescriptors"].every(kind => Array.isArray(before?.[kind]) && Array.isArray(after?.[kind])
    && before[kind].every(identity => after[kind].includes(identity))) && before?.selectedBuilder === after?.selectedBuilder;
}
async function disk(paths) {
  const free = async target => { const value = await statfs(target); return value.bavail * value.bsize / 1024 ** 3; };
  return { sourceFreeGiB: await free(paths.source), temporaryFreeGiB: await free(paths.temporary), dockerFreeGiB: await free(paths.dockerRoot) };
}
async function capturePrerequisites(docker) {
  const context = (await command(docker, ["context", "show"], "native-context")).out.trim();
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(context)) fail();
  const originalContext = JSON.parse((await command(docker, ["context", "inspect", context], "native-endpoint")).out)[0];
  const endpoint = originalContext?.Endpoints?.docker?.Host;
  const server = JSON.parse((await command(docker, ["version", "--format", "{{json .Server}}"], "native-engine")).out);
  const info = JSON.parse((await command(docker, ["info", "--format", "{{json .}}"], "native-engine-resources")).out);
  const paths = { source: await realpath(process.cwd()), temporary: await realpath(os.tmpdir()), dockerRoot: await realpath(info.DockerRootDir) };
  const memory = await readFile("/proc/meminfo", "utf8"), available = /^MemAvailable:\s+(\d+) kB$/m.exec(memory);
  if (!available || process.env.DOCKER_HOST || process.env.DOCKER_CONTEXT || process.env.DOCKER_TLS_VERIFY || process.env.DOCKER_CERT_PATH) fail();
  const observation = { os: process.platform, processArch: process.arch, node: process.versions.node,
    dockerOS: server.Os, dockerArch: server.Arch, endpoint, totalRamGiB: os.totalmem() / 1024 ** 3,
    availableRamGiB: Number(available[1]) / 1024 ** 2, dockerRamGiB: info.MemTotal / 1024 ** 3, ...await disk(paths) };
  return { context, endpoint, originalContextFingerprint: sha256(JSON.stringify(originalContext)), paths, observation };
}
/** Only a new named context bound to the already-verified local socket is admitted. */
export function assertOwnedContext(value, expected) {
  if (!record(value) || value.Name !== expected.name || !/^zenith-owned-context-[a-f0-9]{12}$/.test(value.Name)
    || value.Metadata?.Description !== expected.description || value.Endpoints?.docker?.Host !== expected.endpoint
    || !/^unix:\/\/\//.test(expected.endpoint) || value.Endpoints.docker.SkipTLSVerify !== false
    || JSON.stringify(Object.keys(value.Endpoints)) !== JSON.stringify(["docker"])
    || !record(value.TLSMaterial) || Object.keys(value.TLSMaterial).length !== 0) fail();
  const fingerprint = sha256(JSON.stringify(value));
  if (expected.fingerprint && fingerprint !== expected.fingerprint) fail();
  return { name: expected.name, endpoint: expected.endpoint, description: expected.description, fingerprint };
}
async function ownedContext(docker, expected) {
  return assertOwnedContext(JSON.parse((await command(docker, ["context", "inspect", expected.name], "native-owned-context")).out)[0], expected);
}
export function assertOriginalContextSnapshot(selected, actual, expected) {
  if (selected !== expected.name || sha256(JSON.stringify(actual)) !== expected.fingerprint) fail();
}
async function assertOriginalContext(docker, expected) {
  const selected = (await command(docker, ["context", "show"], "native-original-selection")).out.trim();
  const actual = JSON.parse((await command(docker, ["context", "inspect", expected.name], "native-original-context")).out)[0];
  assertOriginalContextSnapshot(selected, actual, expected);
}
/** Restore only this invocation's override, never Docker's stored default.
 * @param {string | undefined} original
 * @param {Record<string, string | undefined>} [env]
 */
export function restoreContextOverride(original, env = process.env) {
  if (original === undefined) delete env.DOCKER_CONTEXT;
  else env.DOCKER_CONTEXT = original;
}
async function removeContext(docker, expected) {
  await ownedContext(docker, expected);
  await command(docker, ["context", "rm", expected.name], "native-owned-context-release");
  if (lines((await command(docker, ["context", "ls", "--format", "{{.Name}}"], "native-context-absence")).out).includes(expected.name)) fail();
}

async function builderNames(docker) {
  return (await nativeBuilders(docker)).map(item => item.name);
}
async function scopeAbsent(docker, scope) {
  const containers = lines((await command(docker, ["ps", "-a", "--format", "{{.Names}}"], "native-builder-absence")).out);
  const volumes = lines((await command(docker, ["volume", "ls", "-q"], "native-cache-absence")).out);
  return !(await builderNames(docker)).includes(scope.builder) && !containers.includes(scope.containerName) && !volumes.includes(scope.volumeName);
}

/** Exact native driver facts captured from this invocation, not a caller-owned name. */
export function assertBuilderScope(value, expected) {
  if (!record(value) || value.builder !== expected.builder || value.context !== expected.context
    || value.endpoint !== expected.context || (expected.endpoint && value.endpoint !== expected.endpoint)
    || value.containerName !== `buildx_buildkit_${expected.builder}0` || value.volumeName !== `buildx_buildkit_${expected.builder}0_state`
    || !/^zenith-owned-[a-f0-9]{12}$/.test(value.builder) || !/^[a-f0-9]{64}$/.test(value.containerId ?? "")
    || value.image !== BUILDKIT_IMAGE || !/^sha256:[a-f0-9]{64}$/.test(value.imageId ?? "") || (expected.imageId && value.imageId !== expected.imageId) || value.memory !== 4 * 1024 ** 3 || value.volumeDriver !== "local" || value.volumeScope !== "local"
    || !digest(value.volumeFingerprint) || (expected.containerId && value.containerId !== expected.containerId)
    || (expected.volumeFingerprint && value.volumeFingerprint !== expected.volumeFingerprint)) fail();
  return value;
}
/** Bootstrap failure is not removal authority. Require the pre-attempt scope and native capture. */
export function assertAttemptedBuilderCapture(value, attempt, baseline) {
  if (!record(attempt) || attempt.createAttempted !== true || attempt.absentBefore !== true
    || !record(attempt.scope) || !record(attempt.ownedContext)
    || attempt.scope.context !== attempt.ownedContext.name || !/^zenith-owned-context-[a-f0-9]{12}$/.test(attempt.scope.context)
    || !digest(attempt.ownedContext.fingerprint) || !Array.isArray(baseline?.builders) || !Array.isArray(baseline?.containers)
    || !Array.isArray(baseline?.volumes) || !Array.isArray(baseline?.contexts)
    || baseline.builders.includes(attempt.scope.builder) || baseline.volumes.includes(attempt.scope.volumeName)
    || baseline.contexts.includes(attempt.scope.context) || baseline.containers.includes(value?.containerId)) fail();
  return assertBuilderScope(value, attempt.scope);
}
async function captureBuilder(docker, expected) {
  const descriptor = (await nativeBuilders(docker)).find(item => item.name === expected.builder);
  if (!descriptor || descriptor.driver !== "docker-container" || descriptor.endpoint !== expected.context || JSON.stringify(descriptor.nodes) !== JSON.stringify([`${expected.builder}0`])) fail();
  const inspect = (await command(docker, ["buildx", "inspect", expected.builder], "native-builder-proof")).out;
  assertOwnedPackagedBuilder(expected.builder, inspect, expected.context);
  const nodes = inspect.split(/^Nodes:\s*$/m)[1];
  if (!nodes || (nodes.match(/^Name:\s*/gm) ?? []).length !== 1 || !new RegExp(`^Name:\\s+${expected.builder}0\\s*$`, "m").test(nodes)) fail();
  const containerName = `buildx_buildkit_${expected.builder}0`, volumeName = `${containerName}_state`;
  const container = JSON.parse((await command(docker, ["container", "inspect", containerName], "native-buildkit-container")).out)[0];
  const volume = JSON.parse((await command(docker, ["volume", "inspect", volumeName], "native-buildkit-cache")).out)[0];
  if (container.Name !== `/${containerName}` || container.Mounts?.length !== 1 || container.Mounts[0].Type !== "volume"
    || container.Mounts[0].Name !== volumeName || container.Mounts[0].Destination !== "/var/lib/buildkit" || container.Mounts[0].RW !== true
    || volume.Name !== volumeName || (volume.Options && Object.keys(volume.Options).length)) fail();
  return assertBuilderScope({ builder: expected.builder, context: expected.context, endpoint: /^Endpoint:\s+(\S+)\s*$/m.exec(nodes)?.[1], containerName, volumeName,
    containerId: container.Id, image: container.Config?.Image, imageId: container.Image, memory: container.HostConfig?.Memory,
    volumeDriver: volume.Driver, volumeScope: volume.Scope,
    volumeFingerprint: sha256(JSON.stringify({ Name: volume.Name, Driver: volume.Driver, Scope: volume.Scope, CreatedAt: volume.CreatedAt, Mountpoint: volume.Mountpoint, Labels: volume.Labels, Options: volume.Options })) }, expected);
}

/** The only intercepted build is the committed acceptance command, in original order. */
export function boundBuild(args, config) {
  const labels = args.filter((arg, index) => args[index - 1] === "--label");
  const run = labels.find(label => label.startsWith("io.zenith.acceptance.run="))?.slice("io.zenith.acceptance.run=".length);
  const source = labels.find(label => label.startsWith("io.zenith.acceptance.source-sha256="))?.slice("io.zenith.acceptance.source-sha256=".length);
  const image = `${run}:acceptance`;
  const expected = ["build", "--builder", config.scope.builder, "--pull", "--no-cache", "--target", "acceptance", "--platform", config.platform,
    "--label", `org.opencontainers.image.revision=${config.commit}`, "--label", `io.zenith.acceptance.run=${run}`,
    "--label", `io.zenith.acceptance.source-sha256=${source}`, "-f", "docker/worker.Dockerfile", "-t", image, "."];
  if (!new RegExp(`^zenith-pkg-${config.platform.split("/")[1]}-[a-f0-9]{12}$`).test(run ?? "") || source !== config.sourceInputSha256
    || JSON.stringify(args) !== JSON.stringify(expected)) fail();
  return { runId: run, image, sourceInputSha256: source };
}
export function assertLoadedImage(image, binding, config, expectedId) {
  if (!record(image) || !/^sha256:[a-f0-9]{64}$/.test(image.Id ?? "") || (expectedId && image.Id !== expectedId)
    || image.Os !== "linux" || image.Architecture !== config.platform.split("/")[1] || image.Config?.User !== "zenith"
    || JSON.stringify(image.Config?.Entrypoint) !== JSON.stringify(["/usr/bin/tini", "--", "node", "dist/execution/worker.cjs"])
    || image.Config?.Labels?.["org.opencontainers.image.revision"] !== config.commit
    || image.Config?.Labels?.["io.zenith.acceptance.run"] !== binding.runId
    || image.Config?.Labels?.["io.zenith.acceptance.source-sha256"] !== config.sourceInputSha256) fail();
  return image.Id;
}
async function loadedImage(docker, binding, config, expectedId) {
  const image = JSON.parse((await command(docker, ["image", "inspect", binding.image], "native-loaded-image")).out)[0];
  return assertLoadedImage(image, binding, config, expectedId);
}
async function releaseBuilder(docker, scope) {
  await captureBuilder(docker, scope);
  // No keep-state, prune or unnamed cleanup. This exact builder owns the sole cache volume.
  await command(docker, ["buildx", "rm", scope.builder], "native-owned-builder-release", { timeout: 120_000 });
  if (!await scopeAbsent(docker, scope)) fail();
}
async function privateJson(filename) {
  const directory = await lstat(path.dirname(filename)), file = await lstat(filename);
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid() || (directory.mode & 0o777) !== 0o700
    || !file.isFile() || file.isSymbolicLink() || file.uid !== directory.uid || (file.mode & 0o777) !== 0o600 || file.size > 128 * 1024) fail();
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const opened = await handle.stat(); if (opened.dev !== file.dev || opened.ino !== file.ino) fail(); return JSON.parse(await handle.readFile("utf8")); }
  finally { await handle.close(); }
}
export function assertReleaseMarker(marker, config) {
  if (!record(marker) || JSON.stringify(Object.keys(marker).sort()) !== JSON.stringify(["builder", "buildkitImageId", "cacheVolumeAbsent", "commit", "containerId", "endpoint", "imageId", "nonce", "platform", "runId", "sourceInputSha256", "volumeFingerprint"].sort())
    || marker.endpoint !== config.scope.endpoint || !/^[A-Za-z0-9._-]{1,64}$/.test(marker.endpoint ?? "") || marker.nonce !== config.nonce || !/^[a-f0-9]{32}$/.test(marker.nonce ?? "") || marker.builder !== config.scope.builder || marker.buildkitImageId !== config.scope.imageId || marker.containerId !== config.scope.containerId || marker.volumeFingerprint !== config.scope.volumeFingerprint
    || marker.commit !== config.commit || marker.platform !== config.platform || marker.sourceInputSha256 !== config.sourceInputSha256
    || marker.cacheVolumeAbsent !== true || !/^sha256:[a-f0-9]{64}$/.test(marker.imageId ?? "")
    || !new RegExp(`^zenith-pkg-${config.platform.split("/")[1]}-[a-f0-9]{12}$`).test(marker.runId ?? "")) fail();
  return marker;
}

async function delegated(docker, args) {
  const child = spawn(docker, args, { stdio: "inherit" });
  let interrupted = false;
  const forward = signal => { interrupted = true; child.kill(signal); };
  const interrupt = () => forward("SIGINT"), terminate = () => forward("SIGTERM");
  process.on("SIGINT", interrupt); process.on("SIGTERM", terminate);
  try { return await new Promise(resolve => { child.once("error", () => resolve(1)); child.once("close", code => resolve(interrupted ? 1 : code ?? 1)); }); }
  finally { process.off("SIGINT", interrupt); process.off("SIGTERM", terminate); }
}

/** Transparent real-Docker delegation; release happens before successful build return. */
export async function nativeDockerShim(configPath, args) {
  const config = await privateJson(configPath);
  if (config.wrapperSha256 !== sha256(await readFile(fileURLToPath(import.meta.url)))) fail();
  const current = await processIdentity(process.pid);
  await ownedLeader(config.supervisorOwner);
  if (current.group !== config.supervisorOwner.pid || current.session !== config.supervisorOwner.pid) throw new NativeProcessSettlementError();
  inheritedOwner = config.supervisorOwner;
  if (args[0] !== "build") return delegated(config.docker, args);
  const binding = boundBuild(args, config);
  if (process.env.DOCKER_CONTEXT !== config.ownedContext.name) fail();
  await ownedContext(config.docker, config.ownedContext);
  if ((await command("git", ["rev-parse", "HEAD"], "native-build-source")).out.trim() !== config.commit
    || (await command("git", ["status", "--porcelain"], "native-build-clean")).out.trim() || await packagedSourceDigest(process.cwd()) !== config.sourceInputSha256) fail();
  const code = await delegated(config.docker, args);
  if (code !== 0) return code; // A failed build never gets a positive release marker.
  const imageId = await loadedImage(config.docker, binding, config);
  await ownedContext(config.docker, config.ownedContext);
  await releaseBuilder(config.docker, config.scope);
  await loadedImage(config.docker, binding, config, imageId);
  await ownedContext(config.docker, config.ownedContext);
  const marker = { nonce: config.nonce, endpoint: config.scope.endpoint, builder: config.scope.builder, buildkitImageId: config.scope.imageId, containerId: config.scope.containerId, volumeFingerprint: config.scope.volumeFingerprint,
    commit: config.commit, platform: config.platform, sourceInputSha256: config.sourceInputSha256, runId: binding.runId, imageId, cacheVolumeAbsent: true };
  assertReleaseMarker(marker, config);
  await writeFile(config.marker, JSON.stringify(marker) + "\n", { mode: 0o600, flag: "wx" });
  for (let attempt = 0; ; attempt++) {
    if (Object.values(await disk(config.paths)).every(value => value >= MIN_DISK)) break;
    if (attempt >= 60) fail();
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  return 0;
}

async function publicTarget(filename) {
  const root = await realpath(process.cwd());
  if (path.basename(filename) !== "sanitized.json" || filename === root || filename.startsWith(root + path.sep)) fail();
  // Only an absent result in an explicit outside-source directory may be created.
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const parent = await realpath(path.dirname(filename));
  if (parent === root || parent.startsWith(root + path.sep) || parent !== path.dirname(filename)) fail();
  try { await lstat(filename); fail(); } catch (error) { if (error.code !== "ENOENT") throw error; }
}
async function childAcceptance(config, scratch) {
  const output = await open(path.join(scratch, "private-stdout"), "wx", 0o600), errors = await open(path.join(scratch, "private-stderr"), "wx", 0o600);
  const env = { PATH: `${path.join(scratch, "bin")}${path.delimiter}${process.env.PATH}`, HOME: process.env.HOME, DOCKER_CONTEXT: config.ownedContext.name,
    LANG: "C.UTF-8", TZ: "UTC", TMPDIR: config.paths.temporary,
    ZENITH_PACKAGED_WORKER_ACCEPTANCE: "1", BUILDX_BUILDER: config.scope.builder };
  const stop = new AbortController(), signal = mainCancellation ? AbortSignal.any([stop.signal, mainCancellation]) : stop.signal;
  let finished = false, reserve = false, minimumObservedFreeGiB = Infinity;
  const completion = runOwnedProcess(process.execPath, ["scripts/acceptance/packaged-worker.mjs", "--platform", config.platform], {
    env, stdout: output.fd, stderr: errors.fd, signal, timeout: 75 * 60_000, grace: 10 * 60_000,
    onReserved: async owner => {
      config.supervisorOwner = owner;
      await writeFile(path.join(scratch, "configuration.json"), JSON.stringify(config) + "\n", { mode: 0o600, flag: "wx" });
    },
  }).finally(() => { finished = true; });
  try {
    while (!finished) {
      try {
        const minimum = Math.min(...Object.values(await disk(config.paths)));
        minimumObservedFreeGiB = Math.min(minimumObservedFreeGiB, minimum);
        if (minimum < 8) { reserve = true; stop.abort(); }
      } catch { reserve = true; stop.abort(); }
      await Promise.race([completion.catch(() => undefined), new Promise(resolve => setTimeout(resolve, 5000))]);
    }
    const result = await completion;
    return { code: reserve ? 1 : result.code, minimumObservedFreeGiB: round(minimumObservedFreeGiB),
      output: await readFile(path.join(scratch, "private-stdout"), "utf8") };
  } finally { await output.close(); await errors.close(); }
}

async function dependencyImages(docker, baseline) {
  // Only pinned references invoked by this harness and this builder may be removed.
  const { POSTGRES_IMAGE, TEMPORAL_IMAGE, TEMPORAL_ADMIN_IMAGE } = await import("../acceptance/packaged-worker.mjs");
  for (const reference of [BUILDKIT_IMAGE, POSTGRES_IMAGE, TEMPORAL_IMAGE, TEMPORAL_ADMIN_IMAGE]) {
    const read = await command(docker, ["image", "inspect", reference], "native-dependency-image", { allowFailure: true });
    if (read.code !== 0) continue;
    const image = JSON.parse(read.out)[0];
    if (!/^sha256:[a-f0-9]{64}$/.test(image?.Id ?? "")) fail();
    if (baseline.images.includes(image.Id)) continue;
    if ((await command(docker, ["ps", "-aq", "--filter", `ancestor=${image.Id}`], "native-dependency-use")).out.trim()) fail();
    await command(docker, ["image", "rm", "--no-prune", reference], "native-owned-dependency-image-release", { timeout: 120_000 });
    if ((await inventory(docker)).images.includes(image.Id)) fail();
  }
}

export async function nativeMain(args = process.argv.slice(2)) {
  const parsed = parseNativeArgs(args), manifest = packagedWorkerManifest(parsed.platform);
  if (["--validate", "--validate-artifact"].includes(parsed.mode)) {
    const value = JSON.parse(await readFile(parsed.evidence, "utf8"));
    if (parsed.mode === "--validate-artifact") {
      assertArtifactShape(value, parsed.platform);
      console.log(`packaged-worker ${parsed.platform}: sanitized artifact schema admitted; execution verdict unchanged.`);
      return 0;
    }
    assertPublishedEvidence(value, await sourceFrame(parsed.platform));
    console.log(`packaged-worker ${parsed.platform}: passed executed native checks; sanitized evidence validated.`);
    return 0;
  }
  await publicTarget(parsed.evidence);
  let phase = "native-prerequisites", scratch, config, docker, before, child, checks = {}, frame, contextCapture, originalContext, builderAttempt, capturedScope, childFailure;
  let processSettlementUnconfirmed = false, interruptedMain = false;
  const cancellation = new AbortController(); mainCancellation = cancellation.signal;
  const stopMain = () => { interruptedMain = true; cancellation.abort(); };
  process.on("SIGINT", stopMain); process.on("SIGTERM", stopMain);
  const originalContextOverride = process.env.DOCKER_CONTEXT;
  const restoreContext = () => restoreContextOverride(originalContextOverride);
  let cleanup = { builderAbsent: false, builderContainerAbsent: false, cacheVolumeAbsent: false, baselinePreserved: false, wrapperPrivateFilesRemoved: false, ownedContextAbsent: false };
  let status = "failed";
  const startedAt = new Date().toISOString();
  let environment;
  try {
    frame = await sourceFrame(parsed.platform);
    docker = await binary("docker");
    const prerequisites = await capturePrerequisites(docker);
    originalContext = { name: prerequisites.context, fingerprint: prerequisites.originalContextFingerprint };
    // Fixed measured numbers remain visible even when admission refuses scarce resources.
    environment = Object.fromEntries(Object.entries(prerequisites.observation).filter(([key]) => key !== "endpoint").map(([key, value]) => [key,
      ["os", "dockerOS"].includes(key) ? value === "linux" ? "linux" : "unavailable"
        : ["processArch", "dockerArch"].includes(key) ? ["x64", "amd64", "arm64"].includes(value) ? value : "unavailable"
          : key === "node" ? value === "22.23.3" ? value : "unavailable" : Number.isFinite(value) ? round(value) : null]));
    environment = assertNativePrerequisites(parsed.platform, prerequisites.observation);
    before = await inventory(docker);
    const builder = `zenith-owned-${randomBytes(6).toString("hex")}`;
    const contextName = `zenith-owned-context-${randomBytes(6).toString("hex")}`;
    if (before.contexts.includes(contextName)) fail();
    phase = "owned-context-creation";
    const contextExpected = { name: contextName, endpoint: prerequisites.endpoint, description: `Zenith disposable native ${randomBytes(16).toString("hex")}` };
    await command(docker, ["context", "create", contextName, "--docker", `host=${prerequisites.endpoint}`, "--description", contextExpected.description], phase);
    contextCapture = await ownedContext(docker, contextExpected);
    process.env.DOCKER_CONTEXT = contextName; // Invocation-scoped only; never docker context use.
    const scope = { builder, context: contextName, containerName: `buildx_buildkit_${builder}0`, volumeName: `buildx_buildkit_${builder}0_state` };
    if (!await scopeAbsent(docker, scope)) fail();
    scratch = await createPrivateScratch(process.cwd(), os.tmpdir(), "zenith-native-packaged-");
    phase = "owned-builder-creation";
    // Record the already-absent requested scope before create can fail or time out after creation.
    builderAttempt = { scope, ownedContext: contextCapture, absentBefore: true, createAttempted: true };
    await command(docker, ["buildx", "create", "--name", builder, "--driver", "docker-container", "--driver-opt", `default-load=true,image=${BUILDKIT_IMAGE},memory=4g`, "--bootstrap", contextName], phase, { timeout: 180_000 });
    capturedScope = assertAttemptedBuilderCapture(await captureBuilder(docker, scope), builderAttempt, before);
    config = { ...frame, nonce: randomBytes(16).toString("hex"), docker, ownedContext: contextCapture, paths: prerequisites.paths, scope: capturedScope, marker: path.join(scratch, "release.json") };
    const configPath = path.join(scratch, "configuration.json");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path.join(scratch, "bin"), { mode: 0o700 });
    const shim = path.join(scratch, "bin", "docker");
    await writeFile(shim, `#!/usr/bin/env node\n(async()=>{const {nativeDockerShim}=await import(${JSON.stringify(import.meta.url)});process.exitCode=await nativeDockerShim(${JSON.stringify(configPath)},process.argv.slice(2));})().catch(()=>{console.error("Native owned builder transition refused.");process.exitCode=1;});\n`, { mode: 0o700, flag: "wx" });
    if (!Object.values(await disk(config.paths)).every(value => value >= MIN_DISK)) fail();
    phase = "actual-packaged-worker";
    child = await childAcceptance(config, scratch);
    const raw = parseHarnessOutput(child.output);
    if (raw.commit !== frame.commit || raw.sourceInputSha256 !== frame.sourceInputSha256 || raw.acceptanceHarnessSha256 !== frame.acceptanceHarnessSha256) fail();
    if (child.code > 0 && raw.status === "failed" && raw.platform === parsed.platform
      && new RegExp(`^zenith-pkg-${parsed.platform.split("/")[1]}-[a-f0-9]{12}$`).test(raw.runId ?? "")) {
      childFailure = sanitizeChildFailure(raw.failurePhase,
        raw.failurePhase === "inflight-fresh-worker-recovery" ? raw.recoveryWorkerFailureCategory : raw.workerFailureCategory,
        raw.failureReason?.category, raw.failureCommand?.category, raw.failureCommand?.phase, raw.buildFailure);
    }
    checks = executedChecks(raw, parsed.platform, child.code);
    const marker = assertReleaseMarker(await privateJson(config.marker), config);
    if (marker.runId !== raw.runId || marker.imageId !== raw.image.id || !await scopeAbsent(docker, config.scope)) fail();
    checks["owned-builder-cache-cleanup"] = "passed";
    phase = "final-owned-cleanup";
    restoreContext();
    await assertOriginalContext(docker, originalContext);
    await ownedContext(docker, contextCapture);
    await removeContext(docker, contextCapture);
    cleanup.ownedContextAbsent = true;
    checks["owned-context-cleanup"] = "passed";
    restoreContext();
    await assertOriginalContext(docker, originalContext);
    await dependencyImages(docker, before);
    const after = await inventory(docker);
    if (!baselinePreserved(before, after)) fail();
    checks["baseline-preserved"] = "passed";
    status = "passed";
  } catch (error) {
    processSettlementUnconfirmed = error instanceof NativeProcessSettlementError;
    // Publish only a fixed phase, never raw Docker output or private configuration.
  }
  finally {
    mainCancellation = undefined;
    if (interruptedMain) status = "failed";
    try {
      if (processSettlementUnconfirmed) fail(); // No absence promotion while descendants may still act.
      if (builderAttempt && docker) {
        if (!await scopeAbsent(docker, builderAttempt.scope)) {
          await ownedContext(docker, builderAttempt.ownedContext);
          // A complete fresh native capture is mandatory even after nonzero/timeout bootstrap.
          // Partial or reconfigured ownership leaves cleanup false and retains the context.
          capturedScope = assertAttemptedBuilderCapture(await captureBuilder(docker, capturedScope ?? builderAttempt.scope), builderAttempt, before);
          await releaseBuilder(docker, capturedScope);
        }
        if (!await scopeAbsent(docker, builderAttempt.scope)) fail();
        cleanup.builderAbsent = true; cleanup.builderContainerAbsent = true; cleanup.cacheVolumeAbsent = true;
      }
      if (contextCapture && docker && !cleanup.ownedContextAbsent) {
        restoreContext();
        await assertOriginalContext(docker, originalContext);
        await removeContext(docker, contextCapture);
        cleanup.ownedContextAbsent = true;
      }
      restoreContext();
      if (before && docker) {
        await assertOriginalContext(docker, originalContext);
        await dependencyImages(docker, before);
        cleanup.baselinePreserved = baselinePreserved(before, await inventory(docker));
        if (!cleanup.baselinePreserved) fail();
      }
    } catch { status = "failed"; }
    restoreContext();
    if (scratch) {
      try { await rm(scratch, { recursive: true, force: true }); cleanup.wrapperPrivateFilesRemoved = true; }
      catch { status = "failed"; }
    }
    const evidence = { schemaVersion: 1, lane: "packaged-worker", kind: "native-packaged-worker", status, platform: parsed.platform,
      ...frame, environment, startedAt, finishedAt: new Date().toISOString(), childExitCode: child?.code ?? null,
      minimumObservedFreeGiB: child?.minimumObservedFreeGiB ?? null, checks, cleanup, limitations: manifest.limitations,
      ...(status === "failed" ? { failurePhase: phase, ...(childFailure ? { childFailure } : {}) } : {}) };
    if (status === "passed") {
      try { assertPublishedEvidence(evidence, await sourceFrame(parsed.platform)); } catch { evidence.status = status = "failed"; evidence.failurePhase = "final-source-binding"; }
    }
    assertArtifactShape(evidence, parsed.platform);
    await writeFile(parsed.evidence, JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    console.log(`packaged-worker ${parsed.platform}: ${status}; fixed native evidence only.`);
    process.off("SIGINT", stopMain); process.off("SIGTERM", stopMain);
  }
  return status === "passed" ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  nativeMain().then(code => { process.exitCode = code; }).catch(() => {
    console.error("Native packaged-worker gate requires explicit opt-in, supported arguments and complete evidence."); process.exitCode = 1;
  });
}
