import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { load } from 'js-yaml';
import { assertPrivate, privateLocation, composeEnvironment } from '../../deploy/installation.mjs';
import { stagedComposition, stagedPath, stagingArguments } from '../../deploy/private-staging.mjs';
import { cleanupPlan, fail, owns, portOffset, root, installationLabel, projectLabel } from './config.mjs';

export function requireEngineGate() {
  if (process.env.ZENITH_ACCEPTANCE_DEFAULT_STACK !== '1') fail('requires-ZENITH_ACCEPTANCE_DEFAULT_STACK');
  if (Number(process.versions.node.split('.')[0]) !== 22) fail('node22');
  if (process.platform === 'win32') fail('requires-posix-private-permissions');
  if (!process.getuid?.()) fail('requires-unprivileged-host-user');
}
let resourceGuard;
export function setResourceGuard(guard) { resourceGuard = guard; }
// Capture privately in memory. Commands, stderr and bodies may contain credentials;
// errors expose a trusted operation identifier only. Never invoke a shell.
const outstandingShutdownDiagnosticChildren = new Set();
const isShutdownCustodyUncertain = error => error?.message === 'default-stack:shutdown-custody-uncertain';

export function run(command, args, options = {}) {
  const diagnosticCapture = options.captureStderr === true || options.maxOutputBytes !== undefined;
  const maxOutputBytes = options.maxOutputBytes === undefined ? 16 * 1024 * 1024 : options.maxOutputBytes;
  if (diagnosticCapture && (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0 || maxOutputBytes > 16 * 1024 * 1024)) {
    return Promise.reject(new Error('default-stack:diagnostic-output-limit-invalid'));
  }
  if (outstandingShutdownDiagnosticChildren.size > 0) {
    return Promise.reject(new Error('default-stack:shutdown-custody-uncertain'));
  }
  return new Promise((resolve, reject) => {
    resourceGuard?.();
    const child = spawn(command, args, { cwd: options.cwd ?? root,
      env: { ...composeEnvironment(), ...options.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    if (diagnosticCapture) outstandingShutdownDiagnosticChildren.add(child);
    let output = '', stderrOutput = '', size = 0, done = false, aborted = false, closed = false,
      failureId = options.id ?? 'command-failed';
    const captureStderr = options.captureStderr === true;
    let escalationTimer, custodyTimer;
    const abort = () => {
      if (aborted) return;
      aborted = true;
      child.kill('SIGTERM');
      if (diagnosticCapture) {
        escalationTimer = setTimeout(() => { if (!closed) child.kill('SIGKILL'); }, 250);
        custodyTimer = setTimeout(() => {
          if (!closed && !done) {
            done = true;
            clearTimeout(timer); clearTimeout(escalationTimer); clearTimeout(custodyTimer); clearInterval(monitor);
            reject(new Error('default-stack:shutdown-custody-uncertain'));
          }
        }, 1000);
      }
    };
    const timer = setTimeout(abort, options.timeout ?? 300_000);
    const monitor = setInterval(() => { try { resourceGuard?.(); } catch { failureId = 'disk-headroom'; abort(); } }, 5000);
    const settle = ok => {
      if (done) return;
      done = true; clearTimeout(timer); clearTimeout(escalationTimer); clearTimeout(custodyTimer); clearInterval(monitor);
      if (ok && !aborted) resolve(captureStderr ? { stdout: output.trim(), stderr: stderrOutput.trim() } : output.trim());
      else reject(new Error(`default-stack:${failureId}`));
    };
    const collect = (data, stream) => {
      size += data.length;
      if (size > maxOutputBytes) { if (diagnosticCapture) failureId = 'diagnostic-output-limit'; abort(); return; }
      if (stream === 'stderr') stderrOutput += data;
      else output += data;
    };
    child.on('error', () => {
      if (diagnosticCapture) abort();
      else settle(false);
    });
    child.stdout.on('data', data => collect(data, 'stdout'));
    child.stderr.on('data', data => { if (captureStderr) collect(data, 'stderr'); });
    child.on('close', code => {
      closed = true;
      outstandingShutdownDiagnosticChildren.delete(child);
      settle(code === 0);
    });
    child.stdin.end(options.input);
  });
}
export const docker = (args, options = {}) => run('docker', args, options);
export const save = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });

const CLEANUP_STOP_SIGNALS = new Set(['SIGTERM', 'SIGINT', 'SIGQUIT']);
export function cleanupStopDiagnostic({ resource, current, stopped, graceSeconds, elapsedMs, phase, stopResolved, lifecycle = undefined }) {
  const configuredSignal = current.Config?.StopSignal ?? 'SIGTERM';
  const state = stopped?.State;
  const diagnostic = {
    id: resource.id,
    name: typeof current.Name === 'string' ? current.Name : null,
    graceSeconds,
    signal: CLEANUP_STOP_SIGNALS.has(configuredSignal) ? configuredSignal : 'other',
    elapsedMs,
    phase,
    stopResolved,
    wasRunning: current.State?.Running === true,
    postStopInspectionAvailable: Boolean(stopped),
    runningAfter: state ? state.Running === true : null,
    exitCode: Number.isInteger(state?.ExitCode) ? state.ExitCode : null,
    oomKilled: state ? state.OOMKilled === true : null,
  };
  if (lifecycle !== undefined) diagnostic.lifecycle = lifecycle;
  return diagnostic;
}

export function writeCleanupStopDiagnosticFile(directory, filename, value) {
  if (typeof directory !== 'string' || typeof filename !== 'string'
    || !/^cleanup-stop-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.private\.json$/.test(filename)
    || !Number.isInteger(fs.constants.O_EXCL) || !Number.isInteger(fs.constants.O_NOFOLLOW)) return false;
  let target;
  let descriptor;
  try {
    assertPrivate(directory, true);
    const resolvedDirectory = fs.realpathSync(directory);
    if (privateLocation(resolvedDirectory) !== resolvedDirectory) return false;
    target = path.join(resolvedDirectory, filename);
    descriptor = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT
      | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    const opened = fs.fstatSync(descriptor);
    const entry = fs.lstatSync(target);
    if (!opened.isFile() || opened.uid !== process.getuid?.() || opened.nlink !== 1
      || (opened.mode & 0o077) !== 0 || entry.isSymbolicLink()
      || entry.dev !== opened.dev || entry.ino !== opened.ino) return false;
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(descriptor);
    const after = fs.fstatSync(descriptor);
    const afterEntry = fs.lstatSync(target);
    return after.isFile() && after.uid === process.getuid?.() && after.nlink === 1
      && (after.mode & 0o777) === 0o600 && !afterEntry.isSymbolicLink()
      && afterEntry.dev === after.dev && afterEntry.ino === after.ino;
  } catch { return false; }
  finally { if (descriptor !== undefined) { try { fs.closeSync(descriptor); } catch { /* Best effort. */ } } }
}

function persistCleanupStopDiagnostic(directory, diagnostic) {
  try {
    const filename = `cleanup-stop-${randomUUID()}.private.json`;
    writeCleanupStopDiagnosticFile(directory, filename, { schemaVersion: 1, container: diagnostic });
  } catch { /* Diagnostic creation must never change cleanup behavior. */ }
}

const WORKER_COMPOSE_SERVICES = new Set(['execution-worker', 'execution-worker-peer']);
const INFRA_COMPOSE_SERVICES = new Set(['temporal', 'temporal-setup', 'supabase-edge']);
const SUPABASE_INFRA_SERVICES = new Set(['auth', 'db', 'kong', 'pooler', 'rest']);
const INFRA_STOP_GRACE_SECONDS = 60;
const WORKER_STOP_GRACE_SECONDS = 660;
const SHUTDOWN_DIAGNOSTIC_SERVICES = new Set(['db', 'kong']);
const SHUTDOWN_DIAGNOSTIC_MAX_BYTES = 128 * 1024;
const SHUTDOWN_DIAGNOSTIC_TIMEOUT_MS = 3000;

function boundedDiagnosticStrings(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 32).map(item => typeof item === 'string' ? item.slice(0, 2048) : '');
}

function shutdownInspectProjection(item) {
  if (!item || typeof item !== 'object') return null;
  const config = item.Config ?? {};
  const host = item.HostConfig ?? {};
  const state = item.State ?? {};
  const labels = config.Labels ?? item.Labels ?? {};
  return {
    id: typeof item.Id === 'string' ? item.Id : null,
    name: typeof item.Name === 'string' ? item.Name : null,
    imageId: typeof item.Image === 'string' ? item.Image : null,
    config: {
      image: typeof config.Image === 'string' ? config.Image.slice(0, 512) : null,
      entrypoint: boundedDiagnosticStrings(config.Entrypoint),
      command: boundedDiagnosticStrings(config.Cmd),
      stopSignal: typeof config.StopSignal === 'string' ? config.StopSignal.slice(0, 64) : null,
      labels: {
        project: typeof labels[projectLabel] === 'string' ? labels[projectLabel].slice(0, 128) : null,
        service: typeof labels['com.docker.compose.service'] === 'string' ? labels['com.docker.compose.service'].slice(0, 64) : null,
      },
    },
    host: {
      init: typeof host.Init === 'boolean' ? host.Init : null,
      memory: Number.isSafeInteger(host.Memory) ? host.Memory : null,
      nanoCpus: Number.isSafeInteger(host.NanoCpus) ? host.NanoCpus : null,
      pidsLimit: Number.isSafeInteger(host.PidsLimit) ? host.PidsLimit : null,
    },
    state: {
      status: typeof state.Status === 'string' ? state.Status.slice(0, 32) : null,
      running: typeof state.Running === 'boolean' ? state.Running : null,
      restarting: typeof state.Restarting === 'boolean' ? state.Restarting : null,
      oomKilled: typeof state.OOMKilled === 'boolean' ? state.OOMKilled : null,
      exitCode: Number.isInteger(state.ExitCode) ? state.ExitCode : null,
      pid: Number.isSafeInteger(state.Pid) ? state.Pid : null,
      startedAt: typeof state.StartedAt === 'string' ? state.StartedAt.slice(0, 64) : null,
      finishedAt: typeof state.FinishedAt === 'string' ? state.FinishedAt.slice(0, 64) : null,
    },
  };
}

function isShutdownDiagnosticTarget(resource, current, state) {
  if (resource?.kind !== 'container' || !state?.projectId) return null;
  const labels = current?.Config?.Labels ?? current?.Labels ?? {};
  if (labels[projectLabel] !== state.projectId || !owns(labels, state)
    || !/^[a-f0-9]{64}$/.test(resource.id ?? '') || current?.Id !== resource.id) return null;
  for (const service of SHUTDOWN_DIAGNOSTIC_SERVICES) {
    if (current?.Name === `/supabase_${service}_${state.projectId}`) return service;
  }
  return null;
}

async function captureShutdownCommand(dockerCommand, operation, args) {
  try {
    const result = await dockerCommand(args, {
      timeout: SHUTDOWN_DIAGNOSTIC_TIMEOUT_MS,
      maxOutputBytes: SHUTDOWN_DIAGNOSTIC_MAX_BYTES,
      captureStderr: true,
      id: `shutdown-${operation}`,
    });
    if (typeof result === 'string') return { status: 'ok', stdout: result, stderr: '' };
    if (result && typeof result.stdout === 'string' && typeof result.stderr === 'string') {
      return { status: 'ok', stdout: result.stdout, stderr: result.stderr };
    }
    return { status: 'failed', code: `capture-${operation}-result-invalid` };
  } catch (error) {
    if (isShutdownCustodyUncertain(error)) throw error;
    return { status: 'failed', code: `capture-${operation}-failed` };
  }
}

/** Capture raw but strictly bounded lifecycle evidence for exact owned Supabase DB/Kong only. */
export async function captureShutdownLifecycle({ state, resource, current, stopped = undefined, phase, dockerCommand = docker }) {
  const service = isShutdownDiagnosticTarget(resource, current, state);
  if (!service) return null;
  let inspected = phase === 'pre-stop' ? current : stopped;
  let inspectStatus = inspected ? 'available' : 'unavailable';
  if (!inspected) {
    const result = await captureShutdownCommand(dockerCommand, 'inspect', ['container', 'inspect', resource.id]);
    if (result.status === 'ok') {
      try { [inspected] = JSON.parse(result.stdout); inspectStatus = inspected ? 'captured' : 'empty'; }
      catch { inspectStatus = 'parse-failed'; }
    } else inspectStatus = result.code;
  }
  const top = await captureShutdownCommand(dockerCommand, 'top', ['top', resource.id, '-eo', 'pid,ppid,user,stat,comm']);
  const logs = await captureShutdownCommand(dockerCommand, 'logs', ['logs', '--timestamps', '--tail', '100', resource.id]);
  return {
    phase,
    capturedAt: new Date().toISOString(),
    service,
    inspectStatus,
    inspect: shutdownInspectProjection(inspected),
    processTable: top,
    logs,
  };
}

/** Shorten only exact known disposable infrastructure with its expected owner labels. */
export function containerStopGraceSeconds(item, state) {
  const labels = item?.Config?.Labels ?? item?.Labels;
  if (WORKER_COMPOSE_SERVICES.has(labels?.['com.docker.compose.service'])) return WORKER_STOP_GRACE_SECONDS;
  const service = labels?.['com.docker.compose.service'];
  if (state.applicationInstallationId
    && typeof state.applicationProjectName === 'string' && state.applicationProjectName.length > 0
    && labels?.[installationLabel] === state.applicationInstallationId
    && labels?.['com.docker.compose.project'] === state.applicationProjectName
    && INFRA_COMPOSE_SERVICES.has(service)) {
    return INFRA_STOP_GRACE_SECONDS;
  }
  if (labels?.[projectLabel] === state.projectId && typeof item?.Name === 'string'
    && [...SUPABASE_INFRA_SERVICES].some(name => item.Name === `/supabase_${name}_${state.projectId}`)) {
    return INFRA_STOP_GRACE_SECONDS;
  }
  return WORKER_STOP_GRACE_SECONDS;
}

export function readState(directory) {
  const dir = privateLocation(directory); assertPrivate(dir, true);
  const file = path.join(dir, 'state.json'); assertPrivate(file);
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  cleanupPlan([], state);
  if (state.directory !== dir) fail('private-directory-binding');
  // Every later command must address the same owned ports the stack was started on.
  if ((state.portOffset ?? 0) !== portOffset) fail('port-offset-drift');
  return state;
}
export async function compose(state, args) {
  const dir = path.join(state.directory, 'installation');
  const file = path.join(dir, 'stack.compose.json'); assertPrivate(file);
  if (createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== state.compositionSha256) fail('composition-drift');
  // Native Linux only: bind least-privilege copies owned by each container uid (see private-staging.mjs).
  // The hashed composition is unchanged; compose reads a derived file.
  const stageRoot = path.join(state.directory, 'staged');
  const staged = stagedComposition(JSON.parse(fs.readFileSync(file, 'utf8')), { privateRoot: state.directory, stageRoot });
  let composeFile = file;
  if (staged.copies.length) {
    composeFile = path.join(dir, 'stack.compose.staged.json');
    const text = `${JSON.stringify(staged.document, null, 2)}\n`;
    // shortcut: copies are refreshed when the derived composition changes or a copy is missing, not when a source's bytes change; private TLS is written once per stack.
    if (!fs.existsSync(composeFile) || fs.readFileSync(composeFile, 'utf8') !== text || staged.copies.some(copy => !fs.existsSync(copy.staged))) {
      fs.mkdirSync(stageRoot, { mode: 0o700, recursive: true }); assertPrivate(stageRoot, true);
      await docker(stagingArguments(staged.copies, { stageRoot, image: stagingImage(), labels: { [installationLabel]: state.installationId } }), { id: 'private-staging' });
      fs.writeFileSync(composeFile, text, { mode: 0o600 });
    }
  }
  return docker(['compose', '--project-name', state.applicationProjectName, '--env-file', path.join(dir, 'compose.env'), '-f', composeFile, ...args]);
}

/** Stage private files for a container started outside compose (native Linux only; see private-staging.mjs). */
export async function stageFiles(state, uid, sources) {
  if (process.platform !== 'linux') return sources;
  const stageRoot = path.join(state.directory, 'staged');
  const copies = sources.map(source => ({ source: path.resolve(source), staged: stagedPath(stageRoot, uid, source), uid: String(uid), gid: String(uid) }));
  fs.mkdirSync(stageRoot, { mode: 0o700, recursive: true }); assertPrivate(stageRoot, true);
  await docker(stagingArguments(copies, { stageRoot, image: stagingImage(), labels: { [installationLabel]: state.installationId } }), { id: 'private-staging' });
  return copies.map(copy => copy.staged);
}

/** The pinned alpine-based Temporal server image already in the disposable overlay. */
export function stagingImage() {
  return load(fs.readFileSync(path.join(root, 'deploy/self-hosted/compose.disposable.yml'), 'utf8')).services.temporal.image;
}

/** Enumerate only two exact owner labels. Independently inspect before any deletion. */
export async function inventory(state) {
  const resources = [];
  for (const kind of ['container', 'volume', 'network', 'image']) {
    const ids = new Set();
    for (const label of [`${installationLabel}=${state.installationId}`, `${projectLabel}=${state.projectId}`,
      ...(state.applicationInstallationId ? [`${installationLabel}=${state.applicationInstallationId}`] : [])]) {
      const args = kind === 'container' ? ['container', 'ls', '-aq'] : [kind, 'ls', '-q'];
      const result = await docker([...args, '--filter', `label=${label}`]);
      for (const id of result.split(/\s+/).filter(Boolean)) ids.add(id);
    }
    for (const id of ids) {
      const [item] = JSON.parse(await docker([kind, 'inspect', id]));
      const labels = item.Config?.Labels ?? item.Labels;
      if (!owns(labels, state)) fail('resource-ownership');
      resources.push({ kind, id: kind === 'volume' ? item.Name : item.Id, labels, item });
    }
  }
  return resources;
}

function assertJ4Node(target, boundary, top = false) {
  const resolved = path.resolve(target);
  if (resolved !== target || !resolved.startsWith(`${boundary}${path.sep}`)) fail('j4-cleanup-path');
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.mode & 0o022 || stat.nlink > 1 && stat.isFile()) fail('j4-cleanup-owner');
  if (top) assertPrivate(resolved, stat.isDirectory());
  return { dev: stat.dev, ino: stat.ino, uid: stat.uid, mode: stat.mode, directory: stat.isDirectory() };
}

function removeJ4PrivateTree(target, boundary, top = false) {
  const identity = assertJ4Node(target, boundary, top);
  if (identity.directory) {
    for (const entry of fs.readdirSync(target)) {
      if (entry === '.' || entry === '..' || entry.includes(path.sep)) fail('j4-cleanup-path');
      removeJ4PrivateTree(path.join(target, entry), boundary);
    }
  }
  const current = assertJ4Node(target, boundary, top);
  if (current.dev !== identity.dev || current.ino !== identity.ino || current.uid !== identity.uid
    || current.mode !== identity.mode || current.directory !== identity.directory) fail('j4-cleanup-identity');
  if (identity.directory) fs.rmdirSync(target);
  else fs.unlinkSync(target);
}

function cleanupJ4PrivateMaterials(state) {
  const directory = path.join(state.directory, 'j4');
  try { fs.lstatSync(directory); }
  catch (error) { if (error?.code === 'ENOENT') return; throw error; }
  privateLocation(directory); assertPrivate(directory, true);
  const ownershipFile = path.join(directory, 'ownership.json'); assertPrivate(ownershipFile);
  const manifest = JSON.parse(fs.readFileSync(ownershipFile, 'utf8'));
  if (manifest.kind !== 'j4_owned_stack' || manifest.installationId !== state.installationId
    || manifest.applicationInstallationId !== state.applicationInstallationId || manifest.projectId !== state.projectId
    || manifest.applicationProjectName !== state.applicationProjectName || manifest.namespace !== state.j4Namespace
    || manifest.temporalPort !== state.j4TemporalPort || JSON.stringify(manifest.source) !== JSON.stringify(state.source)
    || !manifest.j4PrivatePaths) fail('j4-cleanup-binding');
  const paths = manifest.j4PrivatePaths;
  const expected = { data: path.join(directory, 'data'), home: path.join(directory, 'home'), planDirectory: path.join(directory, 'data/plans') };
  if (JSON.stringify(paths) !== JSON.stringify(expected)) fail('j4-cleanup-path');
  const secretFiles = [
    ['api.env', manifest.j4ApiEnvironmentSha256], ['worker.env', manifest.j4WorkerEnvironmentSha256],
    ['maintenance.env', manifest.maintenanceOverlaySha256], ['cron.secret', manifest.cronSecretSha256],
    ['canonical.stack.compose.json', manifest.canonicalCompositionSha256],
  ];
  for (const [name, digest] of secretFiles) {
    const target = path.join(directory, name);
    try { fs.lstatSync(target); }
    catch (error) { if (error?.code === 'ENOENT') continue; throw error; } // A previously completed cleanup remains retryable.
    assertPrivate(target);
    if (!/^[a-f0-9]{64}$/.test(digest ?? '') || createHash('sha256').update(fs.readFileSync(target)).digest('hex') !== digest) fail('j4-cleanup-content');
    removeJ4PrivateTree(target, directory, true);
  }
  for (const target of [paths.home, paths.data]) {
    try { fs.lstatSync(target); }
    catch (error) { if (error?.code === 'ENOENT') continue; throw error; }
    privateLocation(target); assertPrivate(target, true);
    removeJ4PrivateTree(target, directory, true);
  }
}

export async function cleanup(state) {
  requireEngineGate();
  setResourceGuard(undefined); // Cleanup must be possible below the disk floor.
  let resources = await inventory(state);
  const plan = cleanupPlan(resources, state);
  let forcedStops = 0;
  for (const resource of plan) {
    const [current] = JSON.parse(await docker([resource.kind, 'inspect', resource.id]));
    cleanupPlan([{ ...resource, labels: current.Config?.Labels ?? current.Labels }], state);
    if (!owns(current.Config?.Labels ?? current.Labels, state)) fail('resource-ownership');
    if (resource.kind === 'container') {
      // Preserve the shipped worker drain. Only positively identified disposable
      // infrastructure gets the shorter stop window; unknown roles remain conservative.
      const graceSeconds = containerStopGraceSeconds(current, state);
      const shutdownService = isShutdownDiagnosticTarget(resource, current, state);
      let lifecycle;
      if (shutdownService) {
        try {
          const preStop = await captureShutdownLifecycle({ state, resource, current, phase: 'pre-stop' });
          lifecycle = { schemaVersion: 1, service: shutdownService, preStop };
        } catch (error) {
          if (isShutdownCustodyUncertain(error)) throw error;
          lifecycle = { schemaVersion: 1, service: shutdownService, preStop: { status: 'capture-failed' } };
        }
      }
      const started = process.hrtime.bigint();
      let stopResolved = false;
      let elapsedMs = 0;
      let stopped;
      try {
        await docker(['stop', '--time', String(graceSeconds), resource.id], { timeout: graceSeconds * 1000 + 40_000 });
        stopResolved = true;
        elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
        [stopped] = JSON.parse(await docker(['container', 'inspect', resource.id]));
      } catch (error) {
        if (elapsedMs === 0) elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
        let custodyError;
        if (shutdownService) {
          try { lifecycle.postStop = await captureShutdownLifecycle({ state, resource, current, stopped, phase: 'post-stop' }); }
          catch (captureError) {
            if (isShutdownCustodyUncertain(captureError)) {
              custodyError = captureError;
              lifecycle.postStop = { phase: 'post-stop', status: 'custody-uncertain' };
            } else lifecycle.postStop = { phase: 'post-stop', status: 'capture-failed' };
          }
        }
        if (custodyError) lifecycle.canonicalFailure = 'stop-or-post-stop-inspect-failed';
        persistCleanupStopDiagnostic(state.directory, cleanupStopDiagnostic({ resource, current, stopped, graceSeconds, elapsedMs,
          phase: stopResolved ? 'post-stop-inspect' : 'stop', stopResolved, ...(lifecycle ? { lifecycle } : {}) }));
        if (custodyError) throw new Error('default-stack:shutdown-custody-uncertain', { cause: error });
        throw error;
      }
      let custodyError;
      if (shutdownService) {
        try { lifecycle.postStop = await captureShutdownLifecycle({ state, resource, current, stopped, phase: 'post-stop' }); }
        catch (captureError) {
          if (isShutdownCustodyUncertain(captureError)) {
            custodyError = captureError;
            lifecycle.postStop = { phase: 'post-stop', status: 'custody-uncertain' };
          } else lifecycle.postStop = { phase: 'post-stop', status: 'capture-failed' };
        }
      }
      persistCleanupStopDiagnostic(state.directory, cleanupStopDiagnostic({ resource, current, stopped, graceSeconds, elapsedMs,
        phase: 'observed', stopResolved, ...(lifecycle ? { lifecycle } : {}) }));
      if (custodyError) throw custodyError;
      if (current.State?.Running && (stopped.State?.ExitCode === 137 || stopped.State?.OOMKilled)) forcedStops++;
      await docker(['rm', '-v', resource.id]);
    } else if (resource.kind === 'image') {
      // Removing exact owned references avoids globally pruning shared bases/cache.
      for (const reference of [...(current.RepoTags ?? []), ...(current.RepoDigests ?? [])]) {
        if ((await inventory(state)).some(value => value.kind === 'image' && value.id === resource.id
          && [...(value.item.RepoTags ?? []), ...(value.item.RepoDigests ?? [])].includes(reference))) await docker(['image', 'rm', reference]);
      }
      const left = (await inventory(state)).find(value => value.kind === 'image' && value.id === resource.id);
      if (left) await docker(['image', 'rm', resource.id]);
    } else await docker([resource.kind, 'rm', resource.id]);
  }
  resources = await inventory(state);
  if (resources.length) fail('owned-resources-remain');
  const receipt = { schemaVersion: 1, kind: 'local_engine', ownedResourcesRemaining: 0, removed: plan.length, forcedStops, productionReady: false };
  save(path.join(state.directory, 'cleanup.receipt.json'), receipt);
  cleanupJ4PrivateMaterials(state);
  // Private receipts and digest inventories remain reviewable. Remove owned
  // credentials, scratch configuration and database dumps only after absence.
  for (const name of fs.readdirSync(state.directory)) {
    if (!['tls', 'installation', 'worker-peer', 'supabase-project', 'input.json'].includes(name) && !name.endsWith('.env') && !name.endsWith('.backup.sql')) continue;
    const target = privateLocation(path.join(state.directory, name));
    if (!target.startsWith(`${state.directory}${path.sep}`)) fail('cleanup-private-path');
    fs.rmSync(target, { recursive: true, force: true });
  }
  return receipt;
}

export async function cli(main) {
  try { await main(); }
  catch (error) {
    const id = error instanceof Error && /^default-stack:[A-Za-z0-9._-]+$/.test(error.message) ? error.message : 'default-stack:failed';
    if (id === 'default-stack:requires-ZENITH_ACCEPTANCE_DEFAULT_STACK') {
      process.stdout.write(`${JSON.stringify({ status: 'not-run', reason: id, passed: 0, failed: 0, skipped: 1 })}\n`); process.exitCode = 77;
    } else { process.stderr.write(`${id}\n`); process.exitCode = 1; }
  }
}
