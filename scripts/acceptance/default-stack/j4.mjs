import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { Client, Connection } from '@temporalio/client';
import { assertPrivate, environmentsFor, readPrepared, sourceBinding, writeJson } from '../../deploy/installation.mjs';
import { cli, compose, inventory, readState, requireEngineGate, save } from './runtime.mjs';
import { apiProbeRequest, poolerProbe, readiness as ordinaryReadiness, supabaseRequest } from './readiness.mjs';
import { fail, ports } from './config.mjs';
import { hostTemporalTls } from './env.mjs';

/** Loopback client for the owned stack's mTLS Temporal frontend. */
function hostConnection(state, port) {
  const files = hostTemporalTls(state.directory);
  return Connection.connect({ address: `127.0.0.1:${port}`, tls: { serverNameOverride: files.ZENITH_TEMPORAL_TLS_SERVER_NAME,
    serverRootCACertificate: fs.readFileSync(files.ZENITH_TEMPORAL_TLS_CA_FILE),
    clientCertPair: { crt: fs.readFileSync(files.ZENITH_TEMPORAL_TLS_CERT_FILE), key: fs.readFileSync(files.ZENITH_TEMPORAL_TLS_KEY_FILE) } } });
}

const hash = value => createHash('sha256').update(value).digest('hex');
const canonicalEnvironmentFiles = ['api.env', 'worker.env', 'migration.env', 'compose.env', 'installation.json', 'keyring.json'];
const privateFile = (file, text) => fs.writeFileSync(file, text, { mode: 0o600, flag: 'wx' });
const envText = env => `${Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n')}\n`;
const safeEnv = file => { assertPrivate(file); return fs.readFileSync(file, 'utf8'); };
const readOwnership = directory => {
  const file = path.join(directory, 'j4/ownership.json'); assertPrivate(file);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
};

export function j4Mode(state) { return state.j4Mode ?? 'canonical'; }

// Temporal's raw operator protobuf RPC accepts IndexedValueType enum numbers.
// The higher-level SDK SearchAttributeType is a string and is not wire-safe here.
export const temporalKeywordSearchAttributeValue = 2;
export function hasNumericScheduleOwnerKeyword(attributes) {
  return attributes?.ZenithScheduleOwner === temporalKeywordSearchAttributeValue;
}

export function validHostWorkerClosure(closure, namespace) {
  if (!closure || closure.schemaVersion !== 1 || closure.kind !== 'owned_child_closeouts' || closure.graceful !== true
    || typeof closure.runId !== 'string' || !/^[A-Za-z0-9-]{8,80}$/.test(closure.runId) || closure.namespace !== namespace
    || !Array.isArray(closure.children) || closure.children.length !== 2) return false;
  const children = closure.children;
  return children.every((child, index) => child && Number.isSafeInteger(child.pid) && child.pid > 0
    && child.restartOrdinal === index + 1 && typeof child.workerIdentity === 'string'
    && /^j4-maintenance-[a-f0-9-]{36}$/.test(child.workerIdentity) && child.closed === true
    && (child.signal === 'SIGTERM' && child.exitCode === null || child.signal === null && child.exitCode === 0))
    && new Set(children.map(child => child.pid)).size === 2
    && new Set(children.map(child => child.workerIdentity)).size === 2;
}

export function assertDeferredJ4State(state, manifest) {
  if (j4Mode(state) !== 'deferred' || state.profile !== 'lean' || !state.j4Namespace
    || state.j4TemporalPort !== ports.j4Temporal || !manifest || manifest.kind !== 'j4_owned_stack'
    || manifest.installationId !== state.installationId || manifest.applicationInstallationId !== state.applicationInstallationId
    || manifest.projectId !== state.projectId || manifest.applicationProjectName !== state.applicationProjectName
    || JSON.stringify(manifest.source) !== JSON.stringify(state.source)
    || JSON.stringify(manifest.sourceBinding) !== JSON.stringify(state.source)
    || JSON.stringify(manifest.source) !== JSON.stringify(sourceBinding())
    || manifest.namespace !== state.j4Namespace || manifest.temporalPort !== state.j4TemporalPort) fail('j4-ownership-binding');
  if (JSON.stringify(Object.keys(manifest.canonicalEnvironmentSha256 ?? {}).sort()) !== JSON.stringify([...canonicalEnvironmentFiles].sort())
    || [...Object.values(manifest.canonicalEnvironmentSha256), manifest.canonicalCompositionSha256, manifest.deferredCompositionSha256,
      manifest.j4ApiEnvironmentSha256, manifest.j4WorkerEnvironmentSha256, manifest.maintenanceOverlaySha256, manifest.cronSecretSha256]
      .some(value => !/^[a-f0-9]{64}$/.test(value ?? ''))) fail('j4-ownership-hashes');
  const privatePaths = { data: path.join(state.directory, 'j4/data'), home: path.join(state.directory, 'j4/home'), planDirectory: path.join(state.directory, 'j4/data/plans') };
  if (JSON.stringify(manifest.j4PrivatePaths) !== JSON.stringify(privatePaths)) fail('j4-private-path-binding');
  const directory = path.join(state.directory, 'j4');
  assertPrivate(directory, true);
  const canonicalFile = path.join(directory, 'canonical.stack.compose.json'); assertPrivate(canonicalFile);
  if (hash(fs.readFileSync(canonicalFile)) !== manifest.canonicalCompositionSha256) fail('j4-canonical-composition-drift');
  const composeFile = path.join(state.directory, 'installation/stack.compose.json');
  assertPrivate(composeFile);
  if (hash(fs.readFileSync(composeFile)) !== manifest.deferredCompositionSha256
    || state.compositionSha256 !== manifest.deferredCompositionSha256) fail('j4-composition-drift');
  for (const [name, expected] of Object.entries(manifest.canonicalEnvironmentSha256)) {
    if (hash(safeEnv(path.join(state.directory, 'installation', name))) !== expected) fail('j4-canonical-environment-drift');
  }
  if (hash(safeEnv(path.join(directory, 'api.env'))) !== manifest.j4ApiEnvironmentSha256
    || hash(safeEnv(path.join(directory, 'worker.env'))) !== manifest.j4WorkerEnvironmentSha256
    || hash(safeEnv(path.join(directory, 'maintenance.env'))) !== manifest.maintenanceOverlaySha256
    || hash(safeEnv(path.join(directory, 'cron.secret'))) !== manifest.cronSecretSha256) fail('j4-private-environment-drift');
  return manifest;
}

export function j4ResumePlan(state, manifest) {
  const privatePaths = { data: path.join(state.directory, 'j4/data'), home: path.join(state.directory, 'j4/home'), planDirectory: path.join(state.directory, 'j4/data/plans') };
  if (JSON.stringify(manifest?.j4PrivatePaths) !== JSON.stringify(privatePaths)) fail('j4-private-path-binding');
  if (j4Mode(state) === 'deferred') assertDeferredJ4State(state, manifest);
  else if (j4Mode(state) === 'resuming') {
    if (manifest.kind !== 'j4_owned_stack' || manifest.installationId !== state.installationId
      || manifest.applicationInstallationId !== state.applicationInstallationId || manifest.projectId !== state.projectId
      || manifest.applicationProjectName !== state.applicationProjectName || manifest.namespace !== state.j4Namespace
      || manifest.temporalPort !== state.j4TemporalPort || JSON.stringify(manifest.source) !== JSON.stringify(state.source)
      || JSON.stringify(manifest.sourceBinding) !== JSON.stringify(state.source)
      || JSON.stringify(manifest.source) !== JSON.stringify(sourceBinding())) fail('j4-resume-binding');
    if (JSON.stringify(Object.keys(manifest.canonicalEnvironmentSha256 ?? {}).sort()) !== JSON.stringify([...canonicalEnvironmentFiles].sort())
      || [...Object.values(manifest.canonicalEnvironmentSha256), manifest.canonicalCompositionSha256, manifest.deferredCompositionSha256,
        manifest.j4ApiEnvironmentSha256, manifest.j4WorkerEnvironmentSha256, manifest.maintenanceOverlaySha256, manifest.cronSecretSha256]
        .some(value => !/^[a-f0-9]{64}$/.test(value ?? ''))) fail('j4-ownership-hashes');
    const canonicalFile = path.join(state.directory, 'j4/canonical.stack.compose.json');
    const currentFile = path.join(state.directory, 'installation/stack.compose.json');
    assertPrivate(canonicalFile); assertPrivate(currentFile);
    if (hash(fs.readFileSync(canonicalFile)) !== manifest.canonicalCompositionSha256
      || hash(fs.readFileSync(currentFile)) !== manifest.canonicalCompositionSha256
      || state.compositionSha256 !== manifest.canonicalCompositionSha256) fail('j4-resume-composition');
    for (const [name, expected] of Object.entries(manifest.canonicalEnvironmentSha256)) {
      if (hash(safeEnv(path.join(state.directory, 'installation', name))) !== expected) fail('j4-canonical-environment-drift');
    }
    if (hash(safeEnv(path.join(state.directory, 'j4/api.env'))) !== manifest.j4ApiEnvironmentSha256
      || hash(safeEnv(path.join(state.directory, 'j4/worker.env'))) !== manifest.j4WorkerEnvironmentSha256
      || hash(safeEnv(path.join(state.directory, 'j4/maintenance.env'))) !== manifest.maintenanceOverlaySha256
      || hash(safeEnv(path.join(state.directory, 'j4/cron.secret'))) !== manifest.cronSecretSha256) fail('j4-private-environment-drift');
  } else fail('j4-not-resumable');
  if (!manifest.prestartReceiptSha256 || !manifest.completionReceiptSha256) fail('j4-incomplete');
  return { canonicalCompositionSha256: manifest.canonicalCompositionSha256, deferredCompositionSha256: manifest.deferredCompositionSha256,
    canonicalEnvironmentSha256: manifest.canonicalEnvironmentSha256, namespace: manifest.namespace, temporalPort: manifest.temporalPort };
}

export function deferredJ4Composition(document, apiEnvFile, namespace, temporalPort = ports.j4Temporal) {
  if (!/^j4-[a-z0-9-]{1,50}$/.test(namespace ?? '') || temporalPort !== ports.j4Temporal || typeof apiEnvFile !== 'string') fail('j4-namespace');
  const result = structuredClone(document);
  delete result.services['execution-worker'];
  delete result.services['execution-worker-peer'];
  delete result.services['api-peer'];
  result.services.api.env_file = [{ path: apiEnvFile, format: 'raw' }];
  result.services.api.volumes = ['j4-api-data:/data', `${path.dirname(apiEnvFile)}/../tls/ca.crt:/run/zenith-ca.crt:ro`,
    ...(document.services.api.volumes ?? []).filter((/** @type {string} */ mount) => mount.includes(':/run/zenith-temporal/'))];
  result.volumes['j4-api-data'] = { labels: { 'io.zenith.installation': result.services.api.labels['io.zenith.installation'] } };
  result.services.temporal.ports = [`127.0.0.1:${temporalPort}:7233`];
  return result;
}

/** Install the private overlay while keeping every canonical prepared file byte-exact.
 * @param {string | Buffer | undefined} [deferredCompositionBytes]
 */
export function prepareJ4Ownership(state, config, compositionBytes, j4 = {}, deferredCompositionBytes = undefined) {
  if (state.profile !== 'lean' || !/^j4-[a-z0-9-]{1,50}$/.test(j4.namespace ?? '') || j4.temporalPort !== ports.j4Temporal) fail('j4-options');
  const dir = path.join(state.directory, 'j4'); fs.mkdirSync(dir, { mode: 0o700 }); assertPrivate(dir, true);
  const installDir = path.join(state.directory, 'installation');
  const generated = environmentsFor(config, installDir);
  const secret = `${randomBytes(32).toString('base64url')}\n`;
  privateFile(path.join(dir, 'cron.secret'), secret);
  const api = { ...generated['api.env'], ZENITH_SERVERLESS: '1', ZENITH_BILLING: 'managed', ZENITH_PLATFORM_DB_MAX: '2',
    ZENITH_TEMPORAL_NAMESPACE: j4.namespace, CRON_SECRET: secret.trim() };
  if (api.SUPABASE_DB_URL !== api.ZENITH_PLATFORM_DB_URL || api.ZENITH_STORE !== 'postgres' || api.ZENITH_PLATFORM_DB !== 'postgres') fail('j4-database-join');
  const j4Data = path.join(dir, 'data'), j4Home = path.join(dir, 'home'), j4PlanDirectory = path.join(j4Data, 'plans');
  const worker = { ...generated['worker.env'], ZENITH_SERVERLESS: '1', ZENITH_BILLING: 'managed', ZENITH_PLATFORM_DB_MAX: '2',
    ZENITH_TEMPORAL_NAMESPACE: j4.namespace, ZENITH_TEMPORAL_ADDRESS: `127.0.0.1:${j4.temporalPort}`, ...hostTemporalTls(state.directory),
    ZENITH_DATA: j4Data, HOME: j4Home, ZENITH_WORKER_PLAN_DIR: j4PlanDirectory, ZENITH_J4_API_ORIGIN: config.environment.NEXT_PUBLIC_SITE_URL,
    ZENITH_J4_CRON_SECRET_FILE: path.join(dir, 'cron.secret') };
  for (const directory of [worker.ZENITH_DATA, worker.HOME, worker.ZENITH_WORKER_PLAN_DIR]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const directory of [worker.ZENITH_DATA, worker.HOME, worker.ZENITH_WORKER_PLAN_DIR]) assertPrivate(directory, true);
  privateFile(path.join(dir, 'api.env'), envText(api)); privateFile(path.join(dir, 'worker.env'), envText(worker));
  const hostDatabase = new URL(config.environment.SUPABASE_DB_URL); hostDatabase.hostname = 'localhost'; hostDatabase.port = String(ports.pooler); hostDatabase.search = '?sslmode=verify-full';
  const overlayKeys = ['ZENITH_PLATFORM_DB_URL', 'ZENITH_PLATFORM_DB_MAX', 'ZENITH_TEMPORAL_ADDRESS', 'ZENITH_TEMPORAL_NAMESPACE',
    'ZENITH_J4_API_ORIGIN', 'ZENITH_J4_CRON_SECRET_FILE', 'ZENITH_DATA', 'ZENITH_SERVERLESS', 'ZENITH_BILLING'];
  const overlay = Object.fromEntries(overlayKeys.map(key => [key, worker[key]])); overlay.ZENITH_PLATFORM_DB_URL = hostDatabase.href;
  privateFile(path.join(dir, 'maintenance.env'), envText(overlay));
  const canonicalComposition = Buffer.from(compositionBytes);
  const canonicalFile = path.join(dir, 'canonical.stack.compose.json'); privateFile(canonicalFile, canonicalComposition);
  const canonicalEnvironmentSha256 = Object.fromEntries(canonicalEnvironmentFiles
    .map(name => [name, hash(fs.readFileSync(path.join(installDir, name)))]));
  const manifest = { schemaVersion: 1, kind: 'j4_owned_stack', installationId: state.installationId, projectId: state.projectId,
    applicationInstallationId: state.applicationInstallationId, applicationProjectName: state.applicationProjectName, source: state.source,
    canonicalCompositionSha256: hash(canonicalComposition), deferredCompositionSha256: deferredCompositionBytes ? hash(deferredCompositionBytes) : undefined, canonicalEnvironmentSha256,
    j4ApiEnvironmentSha256: hash(safeEnv(path.join(dir, 'api.env'))), j4WorkerEnvironmentSha256: hash(safeEnv(path.join(dir, 'worker.env'))),
    maintenanceOverlaySha256: hash(safeEnv(path.join(dir, 'maintenance.env'))), cronSecretSha256: hash(secret),
    j4PrivatePaths: { data: worker.ZENITH_DATA, home: worker.HOME, planDirectory: worker.ZENITH_WORKER_PLAN_DIR },
    namespace: j4.namespace, temporalPort: j4.temporalPort, sourceBinding: state.source };
  writeJson(path.join(dir, 'ownership.json'), manifest);
  state.j4Mode = 'deferred'; state.j4Namespace = j4.namespace; state.j4TemporalPort = j4.temporalPort;
  return { manifest, canonicalComposition, apiEnvironment: api, workerEnvironment: worker };
}

const namespaceReadinessTimeoutMs = 30_000;
const namespaceReadinessRetryMs = 100;
const temporalGrpcCode = error => Number.isInteger(error?.code) && error.code >= 0 && error.code <= 16 ? error.code : undefined;

async function temporalRpc(label, operation) {
  try { return await operation(); }
  catch (error) {
    const safe = new Error(`default-stack:${label}`);
    const code = temporalGrpcCode(error);
    if (code !== undefined) safe.code = code;
    throw safe;
  }
}

async function temporalReadinessRpc(connection, label, operation, deadline, grpcDeadline) {
  const remaining = deadline - performance.now();
  if (remaining <= 0) fail('j4-namespace-readiness-timeout');
  try {
    return await connection.withDeadline(grpcDeadline, () => temporalRpc(label, operation));
  } catch (error) {
    if (error.code === 4 && performance.now() >= deadline) fail('j4-namespace-readiness-timeout');
    throw error;
  }
}

async function temporalAdmission(state, namespace, port) {
  const connection = await hostConnection(state, port);
  try {
    // A NOT_FOUND before registration is the only admissible absence signal.
    // Do not retry registration: it is the one permitted namespace mutation.
    let initialAbsent = false;
    try { await temporalRpc('j4-namespace-describe-before', () => connection.workflowService.describeNamespace({ namespace })); }
    catch (error) { if (error.code === 5) initialAbsent = true; else throw error; }
    if (!initialAbsent) fail('j4-namespace-already-exists');
    await temporalRpc('j4-namespace-register', () => connection.workflowService.registerNamespace({ namespace, workflowExecutionRetentionPeriod: { seconds: 86400 }, description: `Owned local J4 ${state.installationId}` }));

    const deadline = performance.now() + namespaceReadinessTimeoutMs;
    const grpcDeadline = Date.now() + namespaceReadinessTimeoutMs;
    let before;
    while (before === undefined) {
      try {
        const confirmed = await temporalReadinessRpc(connection, 'j4-namespace-describe-after', () => connection.workflowService.describeNamespace({ namespace }), deadline, grpcDeadline);
        if (confirmed.namespaceInfo?.name !== namespace) fail('j4-namespace-registration');
        const attributes = await temporalReadinessRpc(connection, 'j4-search-attributes-before', () => connection.operatorService.listSearchAttributes({ namespace }), deadline, grpcDeadline);
        if (!attributes || typeof attributes !== 'object' || !attributes.customAttributes || typeof attributes.customAttributes !== 'object') fail('j4-search-attributes-response');
        before = attributes;
      } catch (error) {
        if (error.code !== 5) throw error;
        const remaining = deadline - performance.now();
        if (remaining <= 0) fail('j4-namespace-readiness-timeout');
        await new Promise(resolve => setTimeout(resolve, Math.min(namespaceReadinessRetryMs, remaining)));
      }
    }
    if (before.customAttributes.ZenithScheduleOwner !== undefined) fail('j4-search-attribute-already-exists');
    await temporalRpc('j4-search-attribute-add', () => connection.operatorService.addSearchAttributes({ namespace, searchAttributes: { ZenithScheduleOwner: temporalKeywordSearchAttributeValue } }));
    const after = await temporalRpc('j4-search-attributes-after', () => connection.operatorService.listSearchAttributes({ namespace }));
    if (!after || typeof after !== 'object' || !after.customAttributes || typeof after.customAttributes !== 'object') fail('j4-search-attributes-response');
    if (!hasNumericScheduleOwnerKeyword(after.customAttributes)) fail('j4-search-attribute-registration');
    return { namespaceCreated: true, scheduleOwnerKeywordCreated: true };
  } finally { await connection.close(); }
}

export async function initializeJ4Namespace(state) {
  requireEngineGate();
  const file = path.join(state.directory, 'j4/ownership.json');
  const manifest = readOwnership(state.directory);
  assertDeferredJ4State(state, manifest);
  const admitted = await temporalAdmission(state, state.j4Namespace, state.j4TemporalPort);
  manifest.namespaceAdmission = admitted; save(file, manifest);
  return admitted;
}

async function databaseAdmission(state, epochExpected = undefined) {
  const config = readPrepared(path.join(state.directory, 'installation'));
  const url = new URL(config.environment.SUPABASE_DB_URL);
  url.hostname = 'localhost'; url.port = String(ports.pooler); url.search = '?sslmode=verify-full';
  const db = postgres(url.href, { max: 1, connect_timeout: 5, idle_timeout: 1,
    ssl: { ca: fs.readFileSync(path.join(state.directory, 'tls/ca.crt')), servername: 'localhost', rejectUnauthorized: true } });
  try {
    const [epoch] = await db`select singleton, installed_at::text as installed_at, installed_at <= clock_timestamp() as admitted from platform.cleanup_writer_epoch`;
    if (!epoch || epoch.singleton !== true || epoch.admitted !== true || !Number.isFinite(Date.parse(epoch.installed_at))
      || epochExpected && epoch.installed_at !== epochExpected) fail('j4-cleanup-epoch');
    const [runs] = await db`select count(*)::int as count from platform.scheduled_job_runs`;
    const [connections] = await db`select count(*)::int as count from platform.provider_connections`;
    if (runs.count !== 0 || connections.count !== 0) fail('j4-database-not-fresh');
    const [identity] = await db`select current_database() as database, current_user as role`;
    if (identity.database !== 'postgres' || identity.role !== 'postgres') fail('j4-product-database-authority');
    const publicNames = ['workspaces', 'members', 'projects', 'environments', 'deployments', 'settings'];
    const publicRows = await db`select name, to_regclass('public.' || name) is not null as present from unnest(${db.array(publicNames)}::text[]) as names(name)`;
    if (publicRows.length !== publicNames.length || publicRows.some(row => !row.present)) fail('j4-public-schema');
    return { epoch: epoch.installed_at, scheduledJobRuns: runs.count, providerConnections: connections.count,
      database: identity.database, role: identity.role, publicProductTables: publicNames, sameDatabaseAliases: true };
  } finally { await db.end({ timeout: 1 }); }
}

async function databaseAfterJ4(state, epochExpected) {
  const config = readPrepared(path.join(state.directory, 'installation'));
  const url = new URL(config.environment.SUPABASE_DB_URL); url.hostname = 'localhost'; url.port = String(ports.pooler); url.search = '?sslmode=verify-full';
  const db = postgres(url.href, { max: 1, connect_timeout: 5, idle_timeout: 1,
    ssl: { ca: fs.readFileSync(path.join(state.directory, 'tls/ca.crt')), servername: 'localhost', rejectUnauthorized: true } });
  try {
    const [epoch] = await db`select singleton, installed_at::text as installed_at, installed_at <= clock_timestamp() as admitted from platform.cleanup_writer_epoch`;
    const [runs] = await db`select count(*)::int as count from platform.scheduled_job_runs`;
    const [connections] = await db`select count(*)::int as count from platform.provider_connections`;
    if (!epoch || epoch.singleton !== true || epoch.admitted !== true || epoch.installed_at !== epochExpected
      || runs.count < 1 || connections.count !== 0) fail('j4-completion-database');
    return { epoch: epoch.installed_at, scheduledJobRuns: runs.count, providerConnections: connections.count,
      database: 'postgres', role: 'postgres', sameDatabaseAliases: true };
  } finally { await db.end({ timeout: 1 }); }
}

// Temporal keeps listing an exited worker's poller until its ~5 minute history TTL lapses.
export const J4_POLLER_SETTLE_MS = 360_000;
/** True once the task queue lists no poller; false if one remains after settleMs. */
export async function pollersSettled(describe, settleMs, intervalMs = 5_000) {
  const until = Date.now() + settleMs;
  for (;;) {
    if (!((await describe()).pollers ?? []).length) return true;
    if (Date.now() >= until) return false;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

async function assertTemporalClean(state, phase, pollerSettleMs = 0) {
  const connection = await hostConnection(state, state.j4TemporalPort);
  try {
    const client = new Client({ connection, namespace: state.j4Namespace });
    const workflows = await connection.workflowService.listWorkflowExecutions({ namespace: state.j4Namespace, query: "ExecutionStatus='Running'" });
    if ((workflows.executions ?? []).length || workflows.nextPageToken?.length) fail(`j4-${phase}-active-workflows`);
    for (const type of [1, 2]) {
      const describe = () => connection.workflowService.describeTaskQueue({ namespace: state.j4Namespace, taskQueue: { name: 'zenith-execution' }, taskQueueType: type });
      if (!await pollersSettled(describe, pollerSettleMs)) fail(`j4-${phase}-active-pollers`);
    }
    for await (const item of client.schedule.list()) if (item.scheduleId) fail(`j4-${phase}-active-schedules`);
    return { activeWorkflows: 0, activePollers: 0, activeSchedules: 0 };
  } finally { await connection.close(); }
}

async function j4Services(state, apiExpected) {
  const resources = await inventory(state);
  const services = resources.filter(resource => resource.kind === 'container'
    && resource.item.Config?.Labels?.['com.docker.compose.project'] === state.applicationProjectName)
    .map(resource => ({ name: resource.item.Config.Labels['com.docker.compose.service'], running: resource.item.State?.Running === true,
      healthy: resource.item.State?.Health?.Status === 'healthy', exitCode: resource.item.State?.ExitCode }));
  return checkJ4Services(services, apiExpected);
}

/** Deferred J4 admits only Temporal, the edge, the API when expected and its completed namespace setup.
 * @param {{name?: string, running: boolean, healthy: boolean, exitCode?: number}[]} services @param {boolean} apiExpected */
export function checkJ4Services(services, apiExpected) {
  if (services.some(service => service.name?.includes('execution-worker') || service.name === 'api-peer')) fail('j4-worker-started-before-admission');
  if (services.filter(service => service.name === 'temporal').length !== 1 || !services.find(service => service.name === 'temporal')?.healthy) fail('j4-temporal-service');
  if (services.filter(service => service.name === 'supabase-edge').length !== 1 || !services.find(service => service.name === 'supabase-edge')?.running) fail('j4-supabase-edge-service');
  if (apiExpected && (services.filter(service => service.name === 'api').length !== 1 || !services.find(service => service.name === 'api')?.healthy)) fail('j4-api-service');
  if (!apiExpected && services.some(service => service.name === 'api')) fail('j4-api-started-before-admission');
  // The one-shot namespace setup runs with the API and must have completed successfully.
  const setup = services.filter(service => service.name === 'temporal-setup');
  if ((apiExpected ? setup.length !== 1 : setup.length > 1) || setup.some(service => service.running || service.exitCode !== 0)) fail('j4-temporal-setup-service');
  if (services.length !== (apiExpected ? 3 : 2) + setup.length) fail('j4-unexpected-service');
  return { temporalHealthy: true, supabaseEdgeRunning: true, apiHealthy: apiExpected, executionWorkers: 0, services: services.map(service => service.name).sort() };
}

export async function j4PrestartReadiness(state, { includeApiProbe = true } = {}) {
  requireEngineGate();
  if (j4Mode(state) !== 'deferred') fail('j4-not-deferred');
  const manifest = readOwnership(state.directory);
  assertDeferredJ4State(state, manifest);
  const config = readPrepared(path.join(state.directory, 'installation'));
  const checks = {};
  const api = includeApiProbe ? await (await import('../../deploy/installation.mjs')).probeReadiness(config, async (input, init) => {
    const request = apiProbeRequest(config.environment.NEXT_PUBLIC_SITE_URL, ports.api, input, init);
    return fetch(request.url, request.options);
  }) : undefined;
  if (api) checks.api = api.ready;
  const services = await j4Services(state, includeApiProbe);
  checks.noExecutionWorkers = services.executionWorkers === 0;
  checks.apiOnlyJ4Profile = services.temporalHealthy && services.supabaseEdgeRunning && (!includeApiProbe || services.apiHealthy);
  const headers = { apikey: config.environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY };
  checks.auth = (await supabaseRequest(state, '/auth/v1/health', headers)).status === 200;
  checks.postgrest = (await supabaseRequest(state, '/rest/v1/', headers)).status === 200;
  for (const schema of ['platform', 'agent']) {
    const response = await supabaseRequest(state, '/rest/v1/', { ...headers, 'accept-profile': schema });
    checks[`postgrest-${schema}-not-exposed`] = response.status === 406 && JSON.parse(response.body).code === 'PGRST106';
  }
  const authority = await poolerProbe(state, 'authority');
  checks.fullDatabase = authority.sameDatabase === true && authority.sameSystemIdentifier === true
    && authority.maxMigrationVersion === authority.highestRegisteredVersion && authority.platformTablesRlsEnabled === true;
  const temporal = await assertTemporalClean(state, 'prestart');
  const ownership = JSON.parse(fs.readFileSync(path.join(state.directory, 'j4/ownership.json'), 'utf8'));
  checks.namespaceAdmission = ownership.namespaceAdmission?.namespaceCreated === true && ownership.namespaceAdmission?.scheduleOwnerKeywordCreated === true;
  checks.temporalNamespace = true;
  const database = await databaseAdmission(state);
  checks.immutableEpoch = Boolean(database.epoch);
  checks.zeroScheduledJobRuns = database.scheduledJobRuns === 0;
  checks.zeroProviderConnections = database.providerConnections === 0;
  checks.publicProductTables = database.publicProductTables?.length === 6;
  const receipt = { schemaVersion: 1, kind: includeApiProbe ? 'j4_prestart' : 'j4_preapi_admission', source: state.source, namespace: state.j4Namespace,
    temporalPort: state.j4TemporalPort, database, temporal, api, authority, checks, j1Ready: false,
    productionReady: false, passed: Object.values(checks).filter(Boolean).length,
    failed: Object.values(checks).filter(value => !value).length, skipped: 0 };
  if (receipt.failed) fail('j4-prestart-readiness');
  if (includeApiProbe) {
    const preApiFile = path.join(state.directory, 'j4-preapi.receipt.json');
    if (fs.existsSync(preApiFile)) {
      assertPrivate(preApiFile);
      const preApi = JSON.parse(fs.readFileSync(preApiFile, 'utf8'));
      if (hash(fs.readFileSync(preApiFile)) !== manifest.preApiReceiptSha256 || preApi.database?.epoch !== database.epoch
        || preApi.database?.scheduledJobRuns !== 0 || preApi.database?.providerConnections !== 0) fail('j4-preapi-receipt-drift');
    } else fail('j4-preapi-receipt-missing');
    const file = path.join(state.directory, 'j4-prestart.receipt.json');
    writeJson(file, receipt); manifest.prestartReceiptSha256 = hash(fs.readFileSync(file)); save(path.join(state.directory, 'j4/ownership.json'), manifest);
  }
  return receipt;
}

export async function verifyJ4Prestart(state) {
  requireEngineGate();
  if (j4Mode(state) !== 'deferred') fail('j4-not-deferred');
  const manifest = readOwnership(state.directory);
  assertDeferredJ4State(state, manifest);
  const file = path.join(state.directory, 'j4-prestart.receipt.json'); assertPrivate(file);
  const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (hash(fs.readFileSync(file)) !== manifest.prestartReceiptSha256 || receipt.kind !== 'j4_prestart' || receipt.j1Ready !== false
    || receipt.failed !== 0 || receipt.namespace !== state.j4Namespace || receipt.temporalPort !== state.j4TemporalPort
    || JSON.stringify(receipt.source) !== JSON.stringify(state.source)) fail('j4-prestart-receipt-drift');
  const preApiFile = path.join(state.directory, 'j4-preapi.receipt.json'); assertPrivate(preApiFile);
  const preApi = JSON.parse(fs.readFileSync(preApiFile, 'utf8'));
  if (hash(fs.readFileSync(preApiFile)) !== manifest.preApiReceiptSha256 || preApi.database?.epoch !== receipt.database.epoch
    || preApi.database?.scheduledJobRuns !== 0 || preApi.database?.providerConnections !== 0) fail('j4-preapi-receipt-drift');
  const currentDatabase = await databaseAdmission(state, receipt.database.epoch);
  const currentTemporal = await assertTemporalClean(state, 'prestart-recheck');
  const services = await j4Services(state, true);
  const config = readPrepared(path.join(state.directory, 'installation'));
  const api = await (await import('../../deploy/installation.mjs')).probeReadiness(config, async (input, init) => {
    const request = apiProbeRequest(config.environment.NEXT_PUBLIC_SITE_URL, ports.api, input, init);
    return fetch(request.url, request.options);
  });
  const headers = { apikey: config.environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY };
  if (!api.ready || (await supabaseRequest(state, '/auth/v1/health', headers)).status !== 200
    || (await supabaseRequest(state, '/rest/v1/', headers)).status !== 200) fail('j4-prestart-runtime');
  return { receipt, currentDatabase, currentTemporal, services, api };
}

/** @returns {Record<string, string>} */
export function j4HostEnvironment(state) {
  const config = readPrepared(path.join(state.directory, 'installation'));
  const manifest = readOwnership(state.directory);
  assertDeferredJ4State(state, manifest);
  /** @type {Record<string, string>} */
  const env = { ...environmentsFor(config, path.join(state.directory, 'installation'))['worker.env'], NODE_EXTRA_CA_CERTS: path.join(state.directory, 'tls/ca.crt') };
  const pooler = new URL(config.environment.SUPABASE_DB_URL); pooler.hostname = 'localhost'; pooler.port = String(ports.pooler);
  env.SUPABASE_DB_URL = env.ZENITH_PLATFORM_DB_URL = env.ZENITH_PLATFORM_MIGRATION_URL = pooler.href;
  env.ZENITH_TEMPORAL_ADDRESS = `127.0.0.1:${state.j4TemporalPort}`; Object.assign(env, hostTemporalTls(state.directory));
  env.ZENITH_TEMPORAL_NAMESPACE = state.j4Namespace; env.ZENITH_PLATFORM_DB_MAX = '2'; env.ZENITH_SERVERLESS = '1'; env.ZENITH_BILLING = 'managed';
  env.ZENITH_DATA = path.join(state.directory, 'j4/data'); env.HOME = path.join(state.directory, 'j4/home');
  env.ZENITH_WORKER_PLAN_DIR = path.join(env.ZENITH_DATA, 'plans'); env.ZENITH_J4_API_ORIGIN = config.environment.NEXT_PUBLIC_SITE_URL;
  for (const directory of [env.ZENITH_DATA, env.HOME, env.ZENITH_WORKER_PLAN_DIR]) assertPrivate(directory, true);
  env.ZENITH_J4_CRON_SECRET_FILE = path.join(state.directory, 'j4/cron.secret'); env.ZENITH_DEFAULT_MAILPIT_URL = state.mailpitUrl;
  env.ZENITH_DEFAULT_STACK_DIRECTORY = state.directory; env.ZENITH_LOCAL_STACK_DIRECTORY = state.directory;
  return env;
}

export async function recordJ4Completion(state, evidence) {
  requireEngineGate();
  if (j4Mode(state) !== 'deferred' || evidence?.naturalTimers !== true || evidence?.workerRestart !== true
    || evidence?.fallbackResumed !== true || evidence?.epochPreserved !== true
    || !validHostWorkerClosure(evidence?.hostWorkerClosure, state.j4Namespace)
    || evidence.runId !== evidence.hostWorkerClosure.runId) fail('j4-completion-evidence');
  const manifest = readOwnership(state.directory);
  assertDeferredJ4State(state, manifest);
  const prestartFile = path.join(state.directory, 'j4-prestart.receipt.json'); assertPrivate(prestartFile);
  const db = await databaseAfterJ4(state, JSON.parse(fs.readFileSync(prestartFile, 'utf8')).database.epoch);
  const temporal = await assertTemporalClean(state, 'completion', J4_POLLER_SETTLE_MS);
  const hostWorkerClosure = { ...evidence.hostWorkerClosure, source: state.source };
  const receipt = { schemaVersion: 1, kind: 'j4_completion', source: state.source, runId: evidence.runId, evidence, database: db, temporal,
    hostWorkerClosure, cleanupComplete: true, productionReady: false };
  const file = path.join(state.directory, 'j4-completion.receipt.json'); writeJson(file, receipt);
  manifest.completionReceiptSha256 = hash(fs.readFileSync(file)); save(path.join(state.directory, 'j4/ownership.json'), manifest);
  return receipt;
}

export async function resumeJ4(directory) {
  requireEngineGate();
  const state = readState(directory), manifestFile = path.join(state.directory, 'j4/ownership.json');
  assertPrivate(manifestFile);
  const manifest = readOwnership(state.directory); j4ResumePlan(state, manifest);
  const prestartFile = path.join(state.directory, 'j4-prestart.receipt.json'), completionFile = path.join(state.directory, 'j4-completion.receipt.json');
  assertPrivate(manifestFile); assertPrivate(prestartFile); assertPrivate(completionFile);
  const prestartBytes = fs.readFileSync(prestartFile), completionBytes = fs.readFileSync(completionFile);
  const prestart = JSON.parse(prestartBytes), complete = JSON.parse(completionBytes);
  if (hash(prestartBytes) !== manifest.prestartReceiptSha256 || hash(completionBytes) !== manifest.completionReceiptSha256
    || prestart.kind !== 'j4_prestart' || prestart.namespace !== state.j4Namespace || prestart.temporalPort !== state.j4TemporalPort
    || JSON.stringify(prestart.source) !== JSON.stringify(state.source) || prestart.j1Ready !== false
    || complete.kind !== 'j4_completion' || JSON.stringify(complete.source) !== JSON.stringify(state.source)
    || complete.temporal?.activeSchedules !== 0 || complete.temporal?.activeWorkflows !== 0 || complete.temporal?.activePollers !== 0
    || complete.cleanupComplete !== true || !validHostWorkerClosure(complete.hostWorkerClosure, state.j4Namespace)
    || complete.runId !== complete.hostWorkerClosure.runId || complete.evidence?.runId !== complete.runId
    || JSON.stringify(complete.hostWorkerClosure.source) !== JSON.stringify(state.source)
    || complete.database.epoch !== prestart.database.epoch) fail('j4-resume-receipt-drift');
  const currentDatabase = await databaseAfterJ4(state, prestart.database.epoch);
  if (currentDatabase.providerConnections !== 0 || currentDatabase.scheduledJobRuns < 1) fail('j4-resume-database');
  const retryingCanonicalResume = j4Mode(state) === 'resuming';
  if (!retryingCanonicalResume) {
    const clean = await assertTemporalClean(state, 'resume', J4_POLLER_SETTLE_MS);
    if (clean.activeSchedules || clean.activeWorkflows || clean.activePollers) fail('j4-not-clean');
    await compose(state, ['stop', 'api', 'temporal']);
  }
  const canonicalFile = path.join(state.directory, 'j4/canonical.stack.compose.json');
  if (hash(fs.readFileSync(canonicalFile)) !== manifest.canonicalCompositionSha256) fail('j4-canonical-composition-drift');
  const composeFile = path.join(state.directory, 'installation/stack.compose.json');
  if (!retryingCanonicalResume) {
    fs.writeFileSync(composeFile, fs.readFileSync(canonicalFile), { mode: 0o600 });
    state.compositionSha256 = manifest.canonicalCompositionSha256; state.j4Mode = 'resuming'; save(path.join(state.directory, 'state.json'), state);
  }
  await compose(state, ['config', '--quiet']);
  await compose(state, ['up', '-d', '--wait', '--wait-timeout', '300']);
  const receipt = await ordinaryReadiness(state, { j4Resume: true });
  state.j4Mode = 'canonical'; save(path.join(state.directory, 'state.json'), state);
  save(path.join(state.directory, 'readiness.receipt.json'), receipt);
  return receipt;
}

async function main() {
  requireEngineGate();
  const [command, flag, directory, ...extra] = process.argv.slice(2);
  if (command !== 'resume' || flag !== '--directory' || !directory || extra.length) fail('usage');
  process.stdout.write(`${JSON.stringify(await resumeJ4(directory))}\n`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void cli(main);
