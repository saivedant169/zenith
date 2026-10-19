/**
 * J4 signed registered runbook delivery on an owned canonical default stack.
 *
 * Prepares the documented prerequisites with the existing J2 helpers: a real
 * Auth operator signed in through Chromium, a workspace/project/environment
 * created after the seeded epoch, a one-use machine token from the browser
 * consent route, and the real zenithd (exec disabled) registered from an owned
 * container sharing the API's network namespace. It then runs the unchanged
 * run-runbooks.ts acceptance and removes only resources it labelled.
 *
 * Chromium trusts the stack's own edge certificate through an exact SPKI pin
 * in an isolated profile; no OS trust store or TLS verification is changed.
 *
 * Usage: NODE_EXTRA_CA_CERTS=<stack>/tls/ca.crt ZENITH_ACCEPTANCE_DEFAULT_STACK=1 \
 *   node scripts/acceptance/maintenance/runbook-fixture.mjs <stack-directory> <new-private-fixture-dir> <zenithd-image>
 */
import fs from 'node:fs';
import path from 'node:path';
import { X509Certificate, createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chromium } from '@playwright/test';
import { readState, compose, requireEngineGate } from '../default-stack/runtime.mjs';
import { hostEnvironment } from '../default-stack/env.mjs';
import { readPrepared, privateLocation, assertPrivate } from '../../deploy/installation.mjs';
import { enrollOperator } from '../../../tests/e2e/default/mfa.mjs';
import { browserRequest, ok, action, nonce, ensure, docker, jsonRequest, adminHeaders, until } from '../../../tests/e2e/default/support.mjs';
import { Machine } from '../../../tests/e2e/default/engines.mjs';

class ExecDisabledMachine extends Machine {
  /** Same owned container shape as the J2 Machine, with every exec capability disabled. */
  async startExecDisabled(token, environmentId, address) {
    this.startupUncertain = true;
    for (const volume of this.volumes) {
      this.intents.push({ kind: 'volume', id: volume });
      await docker(['volume', 'create', '--label', 'io.zenith.journey=' + this.runId, volume]);
    }
    const config = { controlPlane: { url: 'http://127.0.0.1:3400' }, name: this.container,
      stateDir: '/var/lib/zenithd', registration: { tokenFile: '/witness/registration-token' },
      exec: { enabled: false }, heartbeatSec: 5, pollWaitSec: 2, maxConcurrent: 1,
      labels: { 'zenith.credentialMode': 'local_only' } };
    this.agentConfig = config;
    await this.seed(token, config);
    this.intents.push({ kind: 'container', id: this.container });
    await docker(['run', '-d', '--name', this.container, '--label', 'io.zenith.journey=' + this.runId,
      '--network', 'container:' + this.stack.api, '--read-only', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges:true', '--memory', '96m', '--pids-limit', '64',
      '--mount', 'type=volume,source=' + this.volumes[0] + ',target=/witness',
      '--mount', 'type=volume,source=' + this.volumes[1] + ',target=/var/lib/zenithd',
      '--entrypoint', '/usr/local/bin/zenithd', this.config.machine.image, 'run', '--config', '/witness/config.json']);
    this.environmentId = environmentId; this.address = address;
    // Docker confirmed the owned container; its label inventory now bounds cleanup.
    this.startupUncertain = false;
  }
}

/** Base64 SHA-256 of the leaf's SubjectPublicKeyInfo, the form Chromium's SPKI allowlist takes. */
export function spkiPin(pem) {
  return createHash('sha256').update(new X509Certificate(pem).publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
}

/** Admin-created, email-confirmed Auth user; sign-in still goes through the real browser login.
 * The J2 operator() also proves recovery mail, which this lane does not need. */
/** The J2 journey's pre-workspace sign-in: real password grant through the browser, no bootstrap yet. */
async function signIn(page, stack, user) {
  await page.goto(stack.apiUrl + '/login?next=/overview');
  await page.getByLabel('Email', { exact: true }).fill(user.email);
  await page.getByLabel('Password', { exact: true }).fill(user.password);
  const signedIn = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.origin === stack.supabaseUrl && url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'password';
  });
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const verified = await signedIn;
  ensure(verified.ok() && (await verified.json()).user?.id === user.id, 'real-auth-identity');
  await page.waitForURL(url => url.origin === stack.apiUrl && url.pathname !== '/login');
}

async function confirmedOperator(stack) {
  const email = 'zenith-j4-rb-' + nonce() + '@journey.local', password = randomBytes(32).toString('base64url');
  const user = ok(await jsonRequest(stack.supabaseUrl + '/auth/v1/admin/users', {
    method: 'POST', headers: adminHeaders(stack), body: { email, password, email_confirm: true } }));
  ensure(typeof user.id === 'string', 'auth-user');
  return { id: user.id, email, password };
}

function privateWrite(file, text) { fs.writeFileSync(file, text, { mode: 0o600, flag: 'wx' }); }

function runChild(argv, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, argv, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { if (stdout.length < 65536) stdout += chunk; });
    child.stderr.on('data', chunk => { if (stderr.length < 65536) stderr += chunk; });
    const timer = setTimeout(() => child.kill('SIGTERM'), 300_000);
    child.on('error', reject);
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

async function main() {
  requireEngineGate();
  const [stackArg, fixtureArg, image, ...extra] = process.argv.slice(2);
  ensure(stackArg && fixtureArg && image && extra.length === 0, 'runbook-fixture-usage');
  ensure(/^[a-z0-9][a-z0-9._/-]*:[a-z0-9._-]+$/.test(image), 'zenithd-image-reference');
  ensure(/^[a-z0-9./_-]+@sha256:[a-f0-9]{64}$/.test(process.env.ZENITH_DEFAULT_STACK_REGISTRY_IMAGE ?? ''), 'pinned-witness-service-image');
  const state = readState(stackArg);
  ensure(state.j4Mode === 'canonical', 'canonical-stack-required');
  const caFile = path.join(state.directory, 'tls/ca.crt');
  ensure(process.env.NODE_EXTRA_CA_CERTS === caFile, 'node-extra-ca-is-stack-ca');
  const fixture = privateLocation(fixtureArg);
  ensure(!fs.existsSync(fixture), 'fixture-directory-must-be-new');
  fs.mkdirSync(fixture, { mode: 0o700 }); assertPrivate(fixture, true);

  const config = readPrepared(path.join(state.directory, 'installation'));
  const host = hostEnvironment(state);
  const stack = { api: (await compose(state, ['ps', '-q', 'api'])).trim(), apiUrl: config.environment.NEXT_PUBLIC_SITE_URL,
    supabaseUrl: config.environment.SUPABASE_URL, adminKey: config.environment.SUPABASE_SERVICE_ROLE_KEY };
  ensure(/^[a-f0-9]{64}$/.test(stack.api), 'owned-api-container');
  const runId = nonce();
  const receipt = { schemaVersion: 1, kind: 'j4-runbook-fixture', runId, source: state.source, image, acceptanceClaim: false, steps: [] };
  const machine = new ExecDisabledMachine({ machine: { image } }, stack, 'j4rb-' + runId);
  const context = await chromium.launchPersistentContext(path.join(fixture, 'browser'), { headless: true,
    args: [`--ignore-certificate-errors-spki-list=${spkiPin(fs.readFileSync(path.join(state.directory, 'tls/edge.crt')))}`] });
  let child;
  try {
    const page = context.pages()[0] ?? await context.newPage();
    const user = await confirmedOperator(stack);
    await signIn(page, stack, user); receipt.steps.push('real-auth-login');
    await enrollOperator(page, stack); receipt.steps.push('real-totp-mfa');
    const workspaceId = ok(await browserRequest(page, '/api/workspace', { name: 'Zenith J4 runbooks ' + runId })).workspace.id;
    ok(await browserRequest(page, '/api/bootstrap'));
    const created = await action(page, 'project.create', { name: 'J4 runbooks ' + runId, withEnvironment: false });
    await action(page, 'project.updateManifest', { projectId: created.projectId, manifest: { version: 2,
      placement: { provider: 'kubernetes', regions: ['in-cluster'] }, providerConfig: { kubernetes: { namespace: 'zenith-j4' } },
      services: [{ id: 'witness', name: 'witness', kind: 'web', source: { type: 'image', image: process.env.ZENITH_DEFAULT_STACK_REGISTRY_IMAGE },
        size: 'small', replicas: 1, port: 8080, healthPath: '/', ownership: 'managed', env: [] }], resources: [], routes: [], bindings: [] } });
    const environmentId = (await action(page, 'env.create', { projectId: created.projectId, name: 'runbooks', class: 'staging', approvalRequired: true }, { workspaceId })).environmentId;
    receipt.steps.push('workspace-project-environment');
    const token = ok(await browserRequest(page, '/api/platform/v1/runners/tokens',
      { kind: 'machine', ttlMinutes: 10, binding: { environmentId, address: 'service/witness' } }, 'POST', workspaceId));
    ensure(token.shownOnce === true && token.workspaceId === workspaceId && typeof token.token === 'string', 'browser-machine-consent');
    receipt.steps.push('browser-machine-consent');
    await machine.startExecDisabled(token.token, environmentId, 'service/witness');
    const listed = await until(async () => ok(await browserRequest(page, '/api/platform/v1/machines', undefined, 'GET', workspaceId)),
      value => value.machines?.some(row => row.name === machine.container && row.connection?.state === 'online'));
    const registered = listed.machines.find(row => row.name === machine.container);
    receipt.registeredMachine = { id: registered.id, transport: registered.transport, status: registered.status,
      environmentId: registered.environmentId, address: registered.address, capabilities: registered.capabilities };
    // The machine list (agentView) carries no transport; run-runbooks.ts asserts transport=zenithd from the database.
    ensure(registered.status === 'active' && registered.environmentId === environmentId
      && registered.address === 'service/witness', 'machine-consent-binding');
    machine.startupUncertain = false;
    ensure(!registered.capabilities?.includes('machine.exec') && !registered.capabilities?.includes('container.exec'), 'exec-disabled-agent');
    receipt.steps.push('signed-agent-registered');
    const cookieFile = path.join(fixture, 'operator.cookie'), targetFile = path.join(fixture, 'target.json');
    privateWrite(cookieFile, (await context.cookies(stack.apiUrl)).map(cookie => `${cookie.name}=${cookie.value}`).join('; ') + '\n');
    privateWrite(targetFile, JSON.stringify({ workspaceId, targetId: registered.id, environmentId, resourceId: 'witness' }) + '\n');
    child = await runChild(['node_modules/tsx/dist/cli.mjs', 'scripts/acceptance/maintenance/run-runbooks.ts'], {
      ...process.env, ...host, ZENITH_TEST_RUNBOOK_DELIVERY: '1', ZENITH_J4_BROWSER_COOKIE_FILE: cookieFile, ZENITH_J4_TARGET_FILE: targetFile });
    receipt.acceptanceExit = child.code;
    if (child.code === 0) receipt.acceptance = JSON.parse(child.stdout.trim().split('\n').at(-1));
    else receipt.acceptanceStderr = child.stderr.slice(-2000);
  } finally {
    await context.close().catch(() => undefined);
    try { await machine.cleanup(); receipt.machineCleanup = 'removed'; } catch (error) { receipt.machineCleanup = `retained:${error.message}`; }
    privateWrite(path.join(fixture, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
    process.stdout.write(JSON.stringify({ acceptanceExit: receipt.acceptanceExit ?? null, steps: receipt.steps, machineCleanup: receipt.machineCleanup, receipt: path.join(fixture, 'receipt.json') }) + '\n');
  }
  if (child?.code !== 0) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) await main();
