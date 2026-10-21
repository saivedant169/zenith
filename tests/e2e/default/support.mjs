import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { load as yamlLoad } from 'js-yaml';

export const fail = id => { throw new Error('journey:' + id); };
export const ensure = (condition, id) => { if (!condition) fail(id); };
export const sha256 = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const nonce = () => randomBytes(12).toString('hex');
export const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const root = path.resolve('tests/e2e/default/../../..');

export function localUrl(value, tls = false) {
  const url = new URL(value);
  ensure(!url.username && !url.password && !url.search && !url.hash &&
    ['127.0.0.1', 'localhost', 'supabase.localhost'].includes(url.hostname) &&
    (tls ? url.protocol === 'https:' : ['http:', 'https:'].includes(url.protocol)), 'local-url-required');
  return url.origin;
}
export function privateFile(file) {
  const resolved = path.resolve(file);
  ensure(resolved !== root && !resolved.startsWith(root + path.sep), 'private-file-outside-source');
  for (let current = resolved; current !== path.dirname(current); current = path.dirname(current)) {
    ensure(!fs.lstatSync(current).isSymbolicLink(), 'private-file-symlink');
  }
  const stat = fs.statSync(resolved);
  ensure(stat.isFile() && stat.size <= 512 * 1024 && (stat.mode & 0o077) === 0, 'private-file-permissions');
  return fs.readFileSync(resolved, 'utf8').trim();
}
const digestImage = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9./:_-]*@sha256:[a-f0-9]{64}$/);
export const Config = z.object({
  schemaVersion: z.literal(1), stackDirectory: z.string().min(1), mailpitUrl: z.string().min(1),
  kind: z.object({
    context: z.literal('kind-zenith-j2'), namespace: z.literal('zenith-j2'),
    server: z.literal('https://zenith-j2-control-plane:6443'),
    kubeconfigFile: z.string().min(1), rotationKubeconfigFile: z.string().min(1),
    observerKubeconfigFile: z.string().min(1), image: digestImage,
  }).strict(),
  machine: z.object({ image: digestImage }).strict(),
}).strict();

export async function command(binary, args, { input, timeout = 60_000, maxBytes = 8 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let bytes = 0, output = '';
    const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('journey:command-timeout')); }, timeout);
    child.once('error', () => { clearTimeout(timer); reject(new Error('journey:command-start')); });
    child.stdout.on('data', data => {
      bytes += data.length;
      if (bytes > maxBytes) { child.kill('SIGKILL'); reject(new Error('journey:command-output-bound')); }
      else output += data.toString('utf8');
    });
    // No error text, stdout or command argument is ever forwarded to receipts.
    child.stderr.resume();
    child.once('close', code => { clearTimeout(timer); if (code === 0) resolve(output.trim()); else reject(new Error('journey:command-failed')); });
    child.stdin.end(input);
  });
}
export const docker = (args, options) => command('docker', args, options);

export async function jsonRequest(url, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(url, { method, redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  ensure(Buffer.byteLength(text) <= 512 * 1024, 'response-bound');
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { fail('response-json'); }
  return { status: response.status, data };
}
export async function browserRequest(page, endpoint, body, method = body === undefined ? 'GET' : 'POST', workspaceId) {
  ensure(endpoint.startsWith('/api/'), 'browser-path');
  return page.evaluate(async ({ endpoint, body, method, workspaceId }) => {
    const response = await fetch(endpoint, { method, credentials: 'same-origin', redirect: 'error',
      headers: { ...(workspaceId ? { 'x-zenith-workspace': workspaceId } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
  }, { endpoint, body, method, workspaceId });
}
export function ok(response) {
  if (process.env.ZENITH_OPERATED_DIAGNOSTICS === '1' && !(response.status >= 200 && response.status < 300 && response.data?.ok !== false)) {
    // Opt-in CI diagnosis: the status and the API's own fixed-vocabulary error code only.
    const code = response.data?.error?.code;
    process.stderr.write(`http-refused status=${Number(response.status)} code=${typeof code === 'string' && /^[a-z0-9_.:-]{1,64}$/.test(code) ? code : 'none'}\n`);
  }
  ensure(response.status >= 200 && response.status < 300 && response.data?.ok !== false, 'http-refused');
  return response.data;
}
export async function action(page, actionId, input, scope = {}) {
  const data = ok(await browserRequest(page, '/api/actions/' + actionId, { mode: 'execute', input, scope, idempotencyKey: nonce() }));
  const result = data.result;
  ensure(result?.ok === true, 'action-refused');
  return result.data;
}
export async function until(read, predicate, timeout = 180_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const data = await read();
    if (predicate(data)) return data;
    await pause(1000);
  }
  fail('readback-timeout');
}
export function kubeconfig(file, config) {
  const text = privateFile(file), value = yamlLoad(text);
  const context = value.contexts?.find(item => item.name === value['current-context'])?.context;
  const cluster = value.clusters?.find(item => item.name === context?.cluster)?.cluster;
  const user = value.users?.find(item => item.name === context?.user)?.user;
  ensure(cluster?.server === config.kind.server && typeof cluster['certificate-authority-data'] === 'string' &&
    typeof user?.token === 'string' && Object.keys(user).length === 1 &&
    !cluster['insecure-skip-tls-verify'], 'kubeconfig-local-binding');
  return { text, caData: cluster['certificate-authority-data'] };
}
/** Supported native hosts: macOS ARM64 and Linux on its own architecture. Images and the engine must match it. */
export const NATIVE = Object.freeze({ arm64: { image: 'arm64', engine: 'aarch64' }, x64: { image: 'amd64', engine: 'x86_64' } }[process.arch]);
export const nativeHost = () => Boolean(NATIVE) && (process.platform === 'linux' || (process.platform === 'darwin' && process.arch === 'arm64'));
export async function prerequisites(config, source) {
  ensure(nativeHost() && process.versions.node.startsWith('22.'), 'native-host-node22');
  localUrl(config.mailpitUrl);
  const modules = await import(pathToFileURL(path.join(root, 'scripts/acceptance/default-stack/runtime.mjs')).href);
  const state = modules.readState(config.stackDirectory);
  ensure(['lean', 'default'].includes(state.profile) && state.source?.head === source.commit &&
    state.source?.contentSha256 === source.sourceDigest && state.source?.dirty === source.dirty, 'j1-source-join');
  // Reuse J1's actual runtime and readiness, rather than interpreting a stale success file.
  const ready = await import(pathToFileURL(path.join(root, 'scripts/acceptance/default-stack/readiness.mjs')).href);
  await ready.readiness(state);
  const input = JSON.parse(privateFile(path.join(config.stackDirectory, 'input.json')));
  const apiUrl = localUrl(input.environment.NEXT_PUBLIC_SITE_URL);
  const supabaseUrl = localUrl(input.environment.SUPABASE_URL, true);
  ensure(typeof input.environment.SUPABASE_SERVICE_ROLE_KEY === 'string', 'auth-admin-key');
  const [info, machineImage, appImage, kind] = await Promise.all([
    docker(['info', '--format', '{{json .}}']), docker(['image', 'inspect', config.machine.image]),
    docker(['image', 'inspect', config.kind.image]), docker(['inspect', 'zenith-j2-control-plane']),
  ]);
  const engine = JSON.parse(info), machine = JSON.parse(machineImage)[0], app = JSON.parse(appImage)[0], node = JSON.parse(kind)[0];
  ensure(engine.Architecture === NATIVE.engine && machine.Architecture === NATIVE.image && app.Architecture === NATIVE.image &&
    node.Config.Labels?.['io.x-k8s.kind.cluster'] === 'zenith-j2', 'native-owned-targets');
  const [kindImage] = JSON.parse(await docker(['image', 'inspect', node.Image]));
  ensure(kindImage.Architecture === NATIVE.image, 'kind-native-architecture');
  const api = await modules.compose(state, ['ps', '-q', 'api']);
  const worker = await modules.compose(state, ['ps', '-q', 'execution-worker']);
  ensure(/^[a-f0-9]{64}$/.test(api.trim()) && /^[a-f0-9]{64}$/.test(worker.trim()), 'j1-containers');
  return { state, modules, api: api.trim(), worker: worker.trim(), apiUrl, supabaseUrl,
    adminKey: input.environment.SUPABASE_SERVICE_ROLE_KEY, dockerArch: engine.Architecture, docker: engine.ServerVersion, profile: state.profile };
}
export const adminHeaders = stack => ({ apikey: stack.adminKey, authorization: 'Bearer ' + stack.adminKey });
export async function operator(stack, mailpitUrl, letter, users) {
  const email = 'zenith-j2-' + letter + '-' + nonce() + '@journey.local', password = randomBytes(32).toString('base64url');
  const user = ok(await jsonRequest(stack.supabaseUrl + '/auth/v1/admin/users', {
    method: 'POST', headers: adminHeaders(stack), body: { email, password, email_confirm: true },
  }));
  ensure(typeof user.id === 'string', 'auth-user'); users.push(user.id);
  ok(await jsonRequest(stack.supabaseUrl + '/auth/v1/recover', {
    method: 'POST', headers: adminHeaders(stack), body: { email },
  }));
  const mail = await until(async () => ok(await jsonRequest(localUrl(mailpitUrl) + '/api/v1/messages')),
    data => data.messages?.some(message => message.To?.some(recipient => recipient.Address === email)));
  const message = mail.messages.find(message => message.To?.some(recipient => recipient.Address === email));
  const body = ok(await jsonRequest(localUrl(mailpitUrl) + '/api/v1/message/' + encodeURIComponent(message.ID)));
  ensure((body.HTML ?? body.Text ?? '').includes('/auth/v1/verify'), 'mailpit-auth-link');
  return { id: user.id, email, password };
}
export async function login(page, stack, user) {
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
  ok(await browserRequest(page, '/api/bootstrap'));
}
export async function mcp(stack, token, method, params, allowError = false) {
  const response = await jsonRequest(stack.apiUrl + '/api/agent/v3/mcp', { method: 'POST',
    headers: { authorization: 'Bearer ' + token, accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-03-26' },
    body: { jsonrpc: '2.0', id: nonce(), method, ...(params ? { params } : {}) } });
  if (allowError) return response;
  const result = ok(response);
  ensure(!result.error, 'mcp-jsonrpc-error');
  if (method !== 'tools/call') return result.result;
  const envelope = result.result?.structuredContent;
  ensure(envelope?.ok === true && envelope.simulated === false && envelope.truncated === false &&
    Array.isArray(envelope.unavailable) && envelope.unavailable.length === 0, 'mcp-evidence-unavailable');
  return envelope;
}
export async function linkedAgent(page, stack, project, workspaceId) {
  const link = ok(await jsonRequest(stack.apiUrl + '/api/agent/link/start', {
    method: 'POST', body: { clientName: 'Zenith J2 acceptance', clientVersion: '1.0.0' },
  }));
  await page.goto(stack.apiUrl + '/agent/link?code=' + encodeURIComponent(link.userCode));
  // Role name, not label text: the required marker is aria-hidden but still in the label's text.
  await page.getByRole('combobox', { name: 'Workspace', exact: true }).selectOption(workspaceId);
  await page.getByLabel(project.name, { exact: true }).check();
  // Use the real browser consent endpoint. Exact bounded scope, no OAuth fallback.
  ok(await browserRequest(page, '/api/integrations/agent/link/approve', {
    userCode: link.userCode, approve: true, workspaceId, projectIds: [project.id], scopes: ['read', 'plan', 'write', 'logs'], days: 1,
  }));
  const issued = ok(await jsonRequest(stack.apiUrl + '/api/agent/link/token', { method: 'POST', body: { deviceCode: link.deviceCode } }));
  ensure(typeof issued.token === 'string' && issued.token.startsWith('za_'), 'linked-agent-token');
  await mcp(stack, issued.token, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'zenith-j2', version: '1.0.0' } });
  return issued;
}
export async function kindReadback(config, expectedReplicas, expectedNonce) {
  const base = ['--kubeconfig', config.kind.observerKubeconfigFile, '--context', config.kind.context, '-n', config.kind.namespace];
  const deployment = await until(async () => JSON.parse(await command('kubectl', [...base, 'get', 'deployment', 'witness', '-o', 'json'])),
    value => value.spec?.replicas === expectedReplicas && value.status?.availableReplicas === expectedReplicas &&
      value.status?.observedGeneration >= value.metadata?.generation);
  ensure(deployment.spec.template.spec.containers[0].image === config.kind.image, 'kind-image-readback');
  // Call the deployed application independently through a fresh kubectl process.
  const served = await command('kubectl', [...base, 'exec', 'deployment/witness', '--', '/usr/local/bin/witness', 'probe']);
  const data = JSON.parse(served);
  ensure(data.nonce === expectedNonce && data.kind === 'zenith-default-journey', 'kind-application-readback');
  return sha256({ replicas: deployment.spec.replicas, generation: deployment.metadata.generation, served: data });
}
