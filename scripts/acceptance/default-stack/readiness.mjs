import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import { assertPrivate, readPrepared, probeReadiness, sourceBinding } from '../../deploy/installation.mjs';
import { cli, requireEngineGate, inventory, compose, docker, readState, save } from './runtime.mjs';
import { fail, topology, ports, root } from './config.mjs';
import { createHash } from 'node:crypto';
import { stagedPath } from '../../deploy/private-staging.mjs';

/** Explicit private CA and hostname verification, without changing machine trust. */
export function supabaseRequest(state, endpoint, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = https.request({ host: '127.0.0.1', port: ports.supabase, servername: 'supabase.localhost',
      path: endpoint, method: 'GET', ca: fs.readFileSync(path.join(state.directory, 'tls/ca.crt')), rejectUnauthorized: true, headers, timeout: 5000 }, response => {
      let body = '', size = 0;
      response.on('data', chunk => { size += chunk.length; if (size > 1024 * 1024) request.destroy(); else body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    request.on('timeout', () => request.destroy()); request.on('error', () => reject(new Error('default-stack:supabase-https'))); request.end();
  });
}

// On native Linux the probe runs as 1001 and binds the copy compose() staged for the 1001 API.
const caSource = (state, platform = process.platform) => {
  const source = path.join(state.directory, 'tls/ca.crt');
  return platform === 'linux' ? stagedPath(path.join(state.directory, 'staged'), 1001, source) : source;
};

export function poolerProbeArguments(state, mode = 'tls', migrationImage) {
  if (typeof migrationImage !== 'string' || !migrationImage) fail('pooler-probe-image');
  return ['run', '--rm', '--network', `${state.applicationProjectName}_installation`,
    '--label', `io.zenith.installation=${state.installationId}`, '--user', '1001:1001', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=16m,uid=1001,gid=1001,mode=1777',
    '--memory', '192m', '--env-file', path.join(state.directory, 'installation/worker.env'), '-e', 'NODE_EXTRA_CA_CERTS=/run/zenith-ca.crt',
    '--mount', `type=bind,source=${caSource(state)},target=/run/zenith-ca.crt,readonly`,
    '--mount', `type=bind,source=${path.join(root, 'scripts/acceptance/default-stack/pooler-probe.mjs')},target=/app/pooler-probe.mjs,readonly`,
    '--entrypoint', 'node', migrationImage, '--import', 'tsx', '/app/pooler-probe.mjs', mode];
}

export async function poolerProbe(state, mode = 'tls') {
  const migrationImage = readPrepared(path.join(state.directory, 'installation')).images.migration;
  return JSON.parse(await docker(poolerProbeArguments(state, mode, migrationImage), { id: 'pooler-probe' }));
}

/** Both API processes serve the same origin on distinct declared transport ports. */
export function apiProbeRequest(origin, port, input, init) {
  const canonical = new URL(origin), transport = new URL(input);
  if (transport.origin !== canonical.origin || ![ports.api, ports.peerApi].includes(port)) fail('api-probe-origin');
  transport.hostname = '127.0.0.1'; transport.port = String(port);
  const headers = new Headers(init?.headers); headers.set('host', canonical.host);
  return { url: transport, options: { ...init, headers } };
}

/** fetch() drops a caller-supplied Host header, so a probe on the peer port would reach the API as a foreign host.
 * node:http sends it; the response is returned as a standard Response. */
export function apiFetch(origin, port, input, init) {
  const { url, options } = apiProbeRequest(origin, port, input, init);
  if (url.protocol !== 'http:') fail('api-probe-transport');
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method: options.method ?? 'GET', headers: Object.fromEntries(options.headers), signal: options.signal ?? undefined }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(response.headers)) for (const one of [value].flat()) if (one !== undefined) headers.append(name, one);
        const status = response.statusCode ?? 0;
        resolve(new Response([101, 204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers }));
      });
    });
    request.on('error', reject);
    request.end();
  });
}

export async function readiness(state, { j4Resume = false } = {}) {
  requireEngineGate();
  if (state.j4Mode === 'deferred') fail('j4-deferred-not-j1-ready');
  if (state.j4Mode === 'resuming' && !j4Resume) fail('j4-resume-incomplete');
  if (state.j4Mode === 'resuming') {
    const hash = value => createHash('sha256').update(value).digest('hex');
    const dir = path.join(state.directory, 'j4'), manifestFile = path.join(dir, 'ownership.json');
    if (!fs.existsSync(manifestFile)) fail('j4-resume-ownership');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    const canonicalFile = path.join(dir, 'canonical.stack.compose.json');
    const composeFile = path.join(state.directory, 'installation/stack.compose.json');
    assertPrivate(canonicalFile); assertPrivate(composeFile);
    if (manifest.schemaVersion !== 1 || manifest.kind !== 'j4_owned_stack'
      || manifest.installationId !== state.installationId || manifest.applicationInstallationId !== state.applicationInstallationId
      || manifest.projectId !== state.projectId || manifest.applicationProjectName !== state.applicationProjectName
      || manifest.namespace !== state.j4Namespace || manifest.temporalPort !== state.j4TemporalPort
      || JSON.stringify(manifest.source) !== JSON.stringify(state.source) || JSON.stringify(manifest.sourceBinding) !== JSON.stringify(state.source)
      || hash(fs.readFileSync(canonicalFile)) !== manifest.canonicalCompositionSha256
      || hash(fs.readFileSync(composeFile)) !== manifest.canonicalCompositionSha256
      || state.compositionSha256 !== manifest.canonicalCompositionSha256
      || state.canonicalCompositionSha256 !== manifest.canonicalCompositionSha256) fail('j4-resume-composition');
    for (const [name, expected] of Object.entries(manifest.canonicalEnvironmentSha256 ?? {})) {
      const file = path.join(state.directory, 'installation', name);
      if (!fs.existsSync(file) || (fs.statSync(file).mode & 0o077) !== 0 || hash(fs.readFileSync(file)) !== expected) fail('j4-resume-environment');
    }
  }
  if (JSON.stringify(sourceBinding()) !== JSON.stringify(state.source)) fail('source-drift');
  const sizing = topology(state.profile), resources = await inventory(state);
  const checks = {};
  const mailpit = resources.filter(resource => resource.kind === 'container' && resource.id && resource.item.Name === `/zenith-local-${state.installationId}-mailpit`);
  checks['mailpit-owned-running'] = mailpit.length === 1 && mailpit[0].item.State?.Running === true && mailpit[0].item.Image === state.mailpitImage?.imageId;
  const mail = await fetch(`http://127.0.0.1:${ports.mail}/api/v1/messages`, { redirect: 'error', signal: AbortSignal.timeout(5000) });
  checks['mailpit-api'] = mail.ok && Array.isArray((await mail.json()).messages);
  const expected = ['api', 'execution-worker', 'temporal', ...(sizing.apis === 2 ? ['api-peer', 'execution-worker-peer'] : [])];
  for (const name of expected) {
    const containers = resources.filter(resource => resource.kind === 'container' && resource.item.Config.Labels?.['com.docker.compose.project'] === state.applicationProjectName && resource.item.Config.Labels?.['com.docker.compose.service'] === name);
    checks[name] = containers.length === 1 && containers[0].item.State?.Health?.Status === 'healthy';
  }
  const config = readPrepared(path.join(state.directory, 'installation'));
  if (sizing.workers === 2) {
    const peer = readPrepared(path.join(state.directory, 'worker-peer'));
    if (peer.installationId !== config.installationId || !peer.workerId
      || JSON.stringify(peer.environment) !== JSON.stringify(config.environment)) fail('worker-keyring-drift');
  }
  /** @type {Record<string, string>[]} */ const apiProbes = [];
  for (let i = 0; i < sizing.apis; i++) {
    const result = await probeReadiness(config, (input, init) => apiFetch(config.environment.NEXT_PUBLIC_SITE_URL, ports.api + i, input, init));
    checks[`http-api-${i + 1}`] = result.ready; apiProbes.push(result.checks);
    if (result.checks['mcp-bearer-boundary'] !== 'passed') {
      // Diagnostic only: the unauthenticated MCP answer's status and challenge header (public origin, no credential).
      try {
        const response = await apiFetch(config.environment.NEXT_PUBLIC_SITE_URL, ports.api + i, `${config.environment.NEXT_PUBLIC_SITE_URL}/api/agent/v3/mcp`, { redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { accept: 'application/json' } });
        result.checks['mcp-bearer-boundary-observed'] = `${response.status} ${(response.headers.get('www-authenticate') ?? 'none').slice(0, 200)}`;
      } catch (error) { result.checks['mcp-bearer-boundary-observed'] = `error ${error instanceof Error ? error.name : 'unknown'}`; }
    }
  }
  const headers = { apikey: config.environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY };
  checks['supabase-auth-https'] = (await supabaseRequest(state, '/auth/v1/health', headers)).status === 200;
  checks['supabase-postgrest-https'] = (await supabaseRequest(state, '/rest/v1/', headers)).status === 200;
  for (const schema of ['platform', 'agent']) {
    const response = await supabaseRequest(state, '/rest/v1/', { ...headers, 'accept-profile': schema });
    checks[`postgrest-${schema}-not-exposed`] = response.status === 406 && JSON.parse(response.body).code === 'PGRST106';
  }
  const tls = await poolerProbe(state);
  checks['pooler-verify-full'] = tls.verifiedTls === true && tls.wrongCaRefused === true && tls.wrongHostnameRefused === true;
  const authority = await poolerProbe(state, 'authority');
  checks['single-database-authority'] = authority.sameDatabase === true && authority.sameSystemIdentifier === true;
  checks['native-role-boundary'] = authority.privateSchemaUsageRefused === true;
  checks['platform-rls'] = authority.platformTablesRlsEnabled === true && authority.platformTableCount > 0;
  checks['registered-migration-version'] = authority.maxMigrationVersion === authority.highestRegisteredVersion;
  await compose(state, ['run', '--rm', '--no-deps', 'platform-migrate', '--status']);
  checks['platform-schema-current'] = true;
  const receipt = { schemaVersion: 1, kind: 'local_engine', source: state.source, architecture: state.architecture,
    minimumObservedFreeBytes: state.minimumObservedFreeBytes,
    profile: state.profile, apis: sizing.apis, workers: sizing.workers, authority, checks, apiProbes,
    passed: Object.values(checks).filter(Boolean).length, failed: Object.values(checks).filter(value => !value).length, skipped: 0,
    authenticatedJourney: false, crossWorkerExecution: false, hostedProductionAcceptance: false, productionReady: false };
  save(path.join(state.directory, 'readiness.receipt.json'), receipt);
  if (receipt.failed) fail('readiness');
  return receipt;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void cli(async () => {
  if (process.argv.length !== 3) fail('usage');
  process.stdout.write(`${JSON.stringify(await readiness(readState(process.argv[2])))}\n`);
});
