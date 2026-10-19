import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, createPrivateKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

/** @typedef {{mode:'production'|'disposable', apiPort:number, images:{api:string,worker:string,migration:string}, environment:Record<string,string>}} InstallationInput */
/** @typedef {InstallationInput & {schemaVersion:2,installationId:string,projectName:string,workerId?:string,source:{head:string,contentSha256:string,dirty:boolean}}} PreparedInstallation */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const compose = path.join(root, 'deploy/self-hosted/compose.yml');
const overlay = path.join(root, 'deploy/self-hosted/compose.disposable.yml');
const fields = new Set([
  'SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
  'NEXT_PUBLIC_SUPABASE_OAUTH_PROVIDERS', 'NEXT_PUBLIC_SITE_URL', 'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_DB_URL', 'ZENITH_PLATFORM_DB_URL', 'ZENITH_PLATFORM_MIGRATION_URL',
  'ZENITH_TEMPORAL_ADDRESS', 'ZENITH_TEMPORAL_NAMESPACE', 'ZENITH_TEMPORAL_TLS',
  'ZENITH_TEMPORAL_API_KEY', 'ZENITH_AGENT_OAUTH_ISSUER', 'ZENITH_AGENT_OAUTH_JWKS',
  'ZENITH_AGENT_OAUTH_CLIENT_CLAIM', 'ZENITH_AGENT_OAUTH_SUBJECT_CLAIM',
]);
const generated = new Set(['ZENITH_SECRET_KEY', 'ZENITH_PLAN_ARTIFACT_KEY', 'ZENITH_CONTROL_SIGNING_JWK', 'ZENITH_OIDC_SIGNING_JWK']);
const hash = (/** @type {string|Buffer} */ value) => createHash('sha256').update(value).digest('hex');
const refuse = (/** @type {string} */ id) => { throw new Error(`installation:${id}`); };
const loopback = (/** @type {string} */ host) => ['localhost', '127.0.0.1', '[::1]'].includes(host);

/** Only trusted field identifiers enter errors. Credential values never do.
 * @param {unknown} value @param {string} field @returns {string} */
function text(value, field) {
  if (typeof value !== 'string' || !value.trim() || /[\r\n\0]/.test(value)
    || /(?:change[-_ ]?me|replace[-_ ]?me|placeholder|your[-_]|example\.(?:com|org)|<[^>]*>)/i.test(value)) refuse(field);
  return /** @type {string} */ (value);
}
/** @param {string} value @param {string} field @returns {URL} */
function url(value, field) {
  try { return new URL(value); } catch { return refuse(field); }
}
/** @param {string} value @param {string} field @param {boolean} https */
function webUrl(value, field, https = true) {
  const parsed = url(text(value, field), field);
  if (parsed.username || parsed.password || parsed.search || parsed.hash
    || (https ? parsed.protocol !== 'https:' : parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback(parsed.hostname)))) refuse(field);
  return parsed;
}
/** @param {string} value @param {string} field @param {boolean} tls */
function databaseUrl(value, field, tls) {
  const parsed = url(text(value, field), field);
  // URLSearchParams.get() reads the first value; postgres.js uses the last.
  // Reject ambiguity before either driver can reinterpret the TLS setting.
  const sslModes = parsed.searchParams.getAll('sslmode');
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname || !parsed.username
    || !parsed.password || parsed.pathname.length < 2 || parsed.hash
    || sslModes.length > 1
    || (tls && (loopback(parsed.hostname) || sslModes.length !== 1 || sslModes[0] !== 'verify-full'))) refuse(field);
  // Additional URL options can override driver TLS defaults; accept only sslmode.
  if ([...parsed.searchParams.keys()].some(key => key !== 'sslmode')) refuse(field);
  return parsed;
}

/** Structural preflight only: no assertion of network, identity or tool readiness.
 * @param {InstallationInput|PreparedInstallation} input @param {boolean} prepared @returns {InstallationInput|PreparedInstallation} */
export function validateInput(input, prepared = false) {
  if (prepared) assertPreparedVersion(input);
  if (!input || typeof input !== 'object' || Array.isArray(input) || !['production', 'disposable'].includes(input.mode)) refuse('mode');
  const allowed = new Set(['mode', 'apiPort', 'images', 'environment', ...(prepared ? ['schemaVersion', 'installationId', 'projectName', 'source', 'workerId'] : [])]);
  if (Object.keys(input).some(key => !allowed.has(key))) refuse('unknown-installation-field');
  if (!Number.isInteger(input.apiPort) || input.apiPort < 1024 || input.apiPort > 65535) refuse('apiPort');
  if (!input.images || typeof input.images !== 'object' || Array.isArray(input.images)) refuse('images');
  if (Object.keys(input.images).some(key => !['api', 'worker', 'migration'].includes(key))) refuse('unknown-image-field');
  for (const id of /** @type {const} */ (['api', 'worker', 'migration'])) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(text(input.images?.[id], `images.${id}`))) refuse(`images.${id}`);
  }
  const env = input.environment;
  if (!env || typeof env !== 'object' || Array.isArray(env)) refuse('environment');
  for (const key of Object.keys(env)) {
    if (!fields.has(key) && !(prepared && generated.has(key))) refuse('unknown-environment-field');
    text(env[key], fields.has(key) || generated.has(key) ? key : 'environment');
  }
  const site = webUrl(env.NEXT_PUBLIC_SITE_URL, 'NEXT_PUBLIC_SITE_URL', input.mode === 'production');
  if (site.pathname !== '/' || site.origin !== env.NEXT_PUBLIC_SITE_URL) refuse('NEXT_PUBLIC_SITE_URL');
  const supabase = webUrl(env.SUPABASE_URL, 'SUPABASE_URL');
  if (supabase.pathname !== '/' || env.SUPABASE_URL !== env.NEXT_PUBLIC_SUPABASE_URL) refuse('NEXT_PUBLIC_SUPABASE_URL');
  if (text(env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY').length < 20) refuse('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
  if (text(env.SUPABASE_SERVICE_ROLE_KEY, 'SUPABASE_SERVICE_ROLE_KEY').length < 32
    || env.SUPABASE_SERVICE_ROLE_KEY === env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) refuse('SUPABASE_SERVICE_ROLE_KEY');
  const product = databaseUrl(env.SUPABASE_DB_URL, 'SUPABASE_DB_URL', true);
  if (product.port !== '6543') refuse('SUPABASE_DB_URL-transaction-pooler');
  if ((env.ZENITH_PLATFORM_DB_URL !== undefined || prepared) && env.ZENITH_PLATFORM_DB_URL !== env.SUPABASE_DB_URL) refuse('platform-authority-is-product-database');
  const migrationUrl = input.mode === 'disposable' ? localMigrationUrl(product) : env.ZENITH_PLATFORM_MIGRATION_URL;
  const migrator = databaseUrl(env.ZENITH_PLATFORM_MIGRATION_URL ?? migrationUrl, 'ZENITH_PLATFORM_MIGRATION_URL', input.mode === 'production');
  if (input.mode === 'production') {
    const project = /^([a-z0-9]{20})\.supabase\.co$/.exec(supabase.hostname)?.[1];
    const sameProject = (/** @type {URL} */ target) => target.pathname === '/postgres' && (
      target.hostname === `db.${project}.supabase.co` && decodeURIComponent(target.username) === 'postgres'
      || /^[a-z0-9-]+\.pooler\.supabase\.com$/.test(target.hostname) && decodeURIComponent(target.username) === `postgres.${project}`);
    if (!project || supabase.port || !sameProject(product)) refuse('SUPABASE_DB_URL-project');
    if (migrator.port !== '5432' || !sameProject(migrator)) refuse('platform-migration-authority');
  } else {
    if (!/^https:\/\/supabase\.localhost:[1-9][0-9]{3,4}$/.test(supabase.origin) || product.hostname !== 'supabase-pooler'
      || decodeURIComponent(product.username) !== 'postgres.pooler-dev' || product.pathname !== '/postgres') refuse('disposable-engine-binding');
    if (env.ZENITH_PLATFORM_MIGRATION_URL !== undefined && env.ZENITH_PLATFORM_MIGRATION_URL !== migrationUrl) refuse('platform-migration-authority');
  }
  if (input.mode === 'production' || prepared) {
    text(env.ZENITH_TEMPORAL_NAMESPACE, 'ZENITH_TEMPORAL_NAMESPACE');
    const address = url(`http://${text(env.ZENITH_TEMPORAL_ADDRESS, 'ZENITH_TEMPORAL_ADDRESS')}`, 'ZENITH_TEMPORAL_ADDRESS');
    if (!address.port || address.pathname !== '/' || address.username || address.password || address.search || address.hash) refuse('ZENITH_TEMPORAL_ADDRESS');
    if (input.mode === 'production') {
      if (loopback(address.hostname) || env.ZENITH_TEMPORAL_TLS !== 'true') refuse('ZENITH_TEMPORAL_TLS');
      if (text(env.ZENITH_TEMPORAL_API_KEY, 'ZENITH_TEMPORAL_API_KEY').length < 20) refuse('ZENITH_TEMPORAL_API_KEY');
    } else if (address.host !== 'temporal:7233' || env.ZENITH_TEMPORAL_TLS !== 'true'
      || env.ZENITH_TEMPORAL_API_KEY) refuse('disposable-engine-binding');
  } else if (['ZENITH_TEMPORAL_ADDRESS', 'ZENITH_TEMPORAL_NAMESPACE', 'ZENITH_TEMPORAL_TLS', 'ZENITH_TEMPORAL_API_KEY'].some(key => env[key])) {
    refuse('disposable-engine-overrides');
  }
  if (env.ZENITH_AGENT_OAUTH_ISSUER || env.ZENITH_AGENT_OAUTH_JWKS) {
    webUrl(env.ZENITH_AGENT_OAUTH_ISSUER, 'ZENITH_AGENT_OAUTH_ISSUER');
    webUrl(env.ZENITH_AGENT_OAUTH_JWKS, 'ZENITH_AGENT_OAUTH_JWKS');
    if (env.ZENITH_AGENT_OAUTH_CLIENT_CLAIM && !['client_id', 'azp'].includes(env.ZENITH_AGENT_OAUTH_CLIENT_CLAIM)) refuse('ZENITH_AGENT_OAUTH_CLIENT_CLAIM');
    if (env.ZENITH_AGENT_OAUTH_SUBJECT_CLAIM && !/^[A-Za-z][A-Za-z0-9_:/.-]{0,199}$/.test(env.ZENITH_AGENT_OAUTH_SUBJECT_CLAIM)) refuse('ZENITH_AGENT_OAUTH_SUBJECT_CLAIM');
  }
  if (prepared) {
    if ('workerId' in input && !/^[a-f0-9]{24}$/.test(input.workerId)) refuse('worker-identity');
    if (!('source' in input) || !input.source || typeof input.source !== 'object' || Array.isArray(input.source)) refuse('source-binding');
    const binding = input.source;
    if (Object.keys(binding).some(key => !['head', 'contentSha256', 'dirty'].includes(key))) refuse('unknown-source-field');
    if (!/^[a-f0-9]{40}$/.test(binding.head) || !/^[a-f0-9]{64}$/.test(binding.contentSha256) || typeof binding.dirty !== 'boolean') refuse('source-binding');
    if (!/^[a-f0-9]{64}$/.test(env.ZENITH_SECRET_KEY)) refuse('ZENITH_SECRET_KEY');
    if (!/^[a-f0-9]{64}$/.test(env.ZENITH_PLAN_ARTIFACT_KEY) || env.ZENITH_PLAN_ARTIFACT_KEY === env.ZENITH_SECRET_KEY) refuse('ZENITH_PLAN_ARTIFACT_KEY');
    for (const [field, kty] of [['ZENITH_CONTROL_SIGNING_JWK', 'OKP'], ['ZENITH_OIDC_SIGNING_JWK', 'RSA']]) {
      try {
        const key = JSON.parse(env[field]);
        if (key.kty !== kty || !key.d || (kty === 'OKP' && key.crv !== 'Ed25519')) refuse(field);
        const imported = createPrivateKey({ key, format: 'jwk' });
        if (kty === 'RSA' && (imported.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) refuse(field);
      } catch { refuse(field); }
    }
  }
  return input;
}

/** No credential or data transfer from the obsolete separate-server topology.
 * @param {{schemaVersion?:number}} config */
export function assertPreparedVersion(config) {
  if (config?.schemaVersion === 1) refuse('schema-v1-reprepare-required-no-data-copy');
  if (config?.schemaVersion !== 2) refuse('installation-identity');
}
/** @param {URL} product */
function localMigrationUrl(product) {
  return `postgresql://postgres:${product.password}@supabase-db:5432/postgres`;
}
/** Shared by private preparation and pure installation/admission contracts.
 * @param {InstallationInput} input @returns {Record<string,string>} */
export function installationEnvironment(input) {
  validateInput(input);
  const environment = { ...input.environment, ZENITH_PLATFORM_DB_URL: input.environment.SUPABASE_DB_URL };
  if (input.mode === 'disposable') Object.assign(environment, {
    ZENITH_PLATFORM_MIGRATION_URL: localMigrationUrl(new URL(environment.SUPABASE_DB_URL)),
    ZENITH_TEMPORAL_ADDRESS: 'temporal:7233', ZENITH_TEMPORAL_NAMESPACE: 'zenith-disposable', ZENITH_TEMPORAL_TLS: 'true',
  });
  return environment;
}

/** Hash current tracked AND untracked nonignored source contents; no contents emitted. */
export function sourceBinding() {
  const run = (/** @type {string[]} */ args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (result.status !== 0) refuse('source-binding');
    return result.stdout;
  };
  const digest = createHash('sha256');
  const files = run(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean).sort();
  for (const file of files) {
    digest.update(file).update('\0');
    const location = path.join(root, file);
    if (!fs.existsSync(location)) { digest.update('deleted\0'); continue; }
    digest.update(fs.lstatSync(location).isSymbolicLink() ? fs.readlinkSync(location) : fs.readFileSync(location)).update('\0');
  }
  return { head: run(['rev-parse', 'HEAD']).trim(), contentSha256: digest.digest('hex'), dirty: Boolean(run(['status', '--porcelain']).trim()) };
}
/** @param {string} location */
export function privateLocation(location) {
  const resolved = path.resolve(location);
  if (!/^[A-Za-z0-9_./-]+$/.test(resolved) || resolved === root || resolved.startsWith(`${root}${path.sep}`)) refuse('private-directory-outside-source');
  // Check every existing component, including inputs and reopened installations.
  // A lexical outside-source path may otherwise alias a file inside COPY's context.
  for (let component = resolved; component !== path.dirname(component); component = path.dirname(component)) {
    try {
      if (fs.lstatSync(component).isSymbolicLink()) refuse('private-path-symlink');
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }
  return resolved;
}
/** @param {string} location @param {boolean} directory */
export function assertPrivate(location, directory = false) {
  const stat = fs.lstatSync(location);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())
    || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) refuse('private-permissions');
}
/** @param {string} location @param {unknown} value */
export function writeJson(location, value) { fs.writeFileSync(location, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' }); }
/** Raw Compose env_file syntax. Keys trusted, values single-line; $ stays literal.
 * @param {string} location @param {Record<string,string>} env */
function writeEnv(location, env) { fs.writeFileSync(location, Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600, flag: 'wx' }); }

export const TEMPORAL_TLS_FILES = Object.freeze(['ca.crt', 'server.crt', 'server.key', 'client.crt', 'client.key']);
/** Paths inside the API/worker containers; compose.disposable.yml mounts them read-only. */
const disposableTemporalClient = Object.freeze({ ZENITH_TEMPORAL_TLS_CA_FILE: '/run/zenith-temporal/ca.crt',
  ZENITH_TEMPORAL_TLS_CERT_FILE: '/run/zenith-temporal/client.crt', ZENITH_TEMPORAL_TLS_KEY_FILE: '/run/zenith-temporal/client.key',
  ZENITH_TEMPORAL_TLS_SERVER_NAME: 'temporal' });
/** One private CA per disposable installation; its key is discarded once both leaves exist.
 * shortcut: files are 0600 for the preparing user, which Docker Desktop shares with container
 * users; a native Linux engine needs the files owned by the container uids instead.
 * @param {string} dir */
function issueTemporalTls(dir) {
  const tls = path.join(dir, 'temporal-tls'); fs.mkdirSync(tls, { mode: 0o700 });
  const openssl = (/** @type {string[]} */ args) => {
    if (spawnSync('openssl', args, { cwd: tls, stdio: 'ignore', timeout: 30_000 }).status !== 0) refuse('temporal-tls');
  };
  openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '30', '-subj', '/CN=Zenith disposable Temporal CA',
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-keyout', 'ca.key', '-out', 'ca.crt']);
  for (const [name, usage, names] of [['server', 'serverAuth,clientAuth', 'DNS:temporal,DNS:localhost,IP:127.0.0.1'], ['client', 'clientAuth', 'DNS:zenith-client.invalid']]) {
    fs.writeFileSync(path.join(tls, `${name}.ext`), `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=${usage}\nsubjectAltName=${names}\n`, { mode: 0o600, flag: 'wx' });
    openssl(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-subj', `/CN=zenith-temporal-${name}`, '-keyout', `${name}.key`, '-out', `${name}.csr`]);
    openssl(['x509', '-req', '-sha256', '-days', '30', '-in', `${name}.csr`, '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-extfile', `${name}.ext`, '-out', `${name}.crt`]);
    for (const extra of [`${name}.csr`, `${name}.ext`]) fs.rmSync(path.join(tls, extra));
  }
  fs.rmSync(path.join(tls, 'ca.key')); fs.rmSync(path.join(tls, 'ca.srl'), { force: true });
  if (fs.readdirSync(tls).sort().join() !== [...TEMPORAL_TLS_FILES].sort().join()) refuse('temporal-tls');
  for (const name of TEMPORAL_TLS_FILES) fs.chmodSync(path.join(tls, name), 0o600);
}
const TEMPORAL_CLIENT_FILES = Object.freeze(['ca.crt', 'client.crt', 'client.key']);
/** @param {string} dir @param {readonly string[]} names */
function assertTemporalTls(dir, names) {
  assertPrivate(path.join(dir, 'temporal-tls'), true);
  for (const name of names) assertPrivate(path.join(dir, 'temporal-tls', name));
}

/** @param {PreparedInstallation} config @param {string} dir @returns {Record<string,Record<string,string>>} */
export function environmentsFor(config, dir) {
  const { ZENITH_PLATFORM_MIGRATION_URL: migrationUrl, ZENITH_PLAN_ARTIFACT_KEY: artifactKey, ...runtime } = config.environment;
  const common = { ...runtime, NODE_ENV: 'production', ZENITH_STORE: 'postgres', ZENITH_HOSTED_STORE: 'postgres', ZENITH_PLATFORM_DB: 'postgres', ZENITH_PLATFORM_DB_MAX: '5',
    ZENITH_AGENT_CONTROL: '1', ZENITH_AGENT_ORIGIN: runtime.NEXT_PUBLIC_SITE_URL, ZENITH_OIDC_ISSUER: `${runtime.NEXT_PUBLIC_SITE_URL}/api/oidc`,
    ...(config.mode === 'disposable' ? disposableTemporalClient : {}) };
  return {
    'api.env': { ...common, PORT: '3400', HOSTNAME: '0.0.0.0', ZENITH_DATA: '/data' },
    'worker.env': { ...common, ZENITH_PLAN_ARTIFACT_KEY: artifactKey, ZENITH_DATA: '/var/lib/zenith', HOME: '/var/lib/zenith', ZENITH_WORKER_PLAN_DIR: '/var/lib/zenith/plans', ZENITH_WORKER_HEALTH_PORT: '9464', ZENITH_WORKER_TASK_QUEUE: 'zenith-execution',
      // A disposable installation owns its whole engine and namespace; production keeps the operator's observe default.
      ...(config.mode === 'disposable' ? { ZENITH_WORKER_RECONCILE_SCHEDULE_MODE: 'provision' } : {}) },
    'migration.env': { NODE_ENV: 'production', ZENITH_PLATFORM_DB: 'postgres', ZENITH_PLATFORM_DB_URL: migrationUrl, ZENITH_PLATFORM_DB_MAX: '1' },
    'compose.env': { ZENITH_INSTALLATION_ID: config.installationId, ZENITH_PRIVATE_DIR: dir, ZENITH_API_PORT: String(config.apiPort), ZENITH_API_IMAGE: config.images.api, ZENITH_WORKER_IMAGE: config.images.worker, ZENITH_MIGRATION_IMAGE: config.images.migration },
  };
}

/** @param {InstallationInput} input @param {string} directory @returns {PreparedInstallation} */
export function prepare(input, directory) {
  validateInput(input);
  const dir = privateLocation(directory);
  if (fs.existsSync(dir)) refuse('private-directory-already-exists');
  const environment = installationEnvironment(input);
  const id = randomBytes(12).toString('hex');
  environment.ZENITH_SECRET_KEY = randomBytes(32).toString('hex');
  environment.ZENITH_PLAN_ARTIFACT_KEY = randomBytes(32).toString('hex');
  const control = generateKeyPairSync('ed25519');
  const oidc = generateKeyPairSync('rsa', { modulusLength: 2048 });
  environment.ZENITH_CONTROL_SIGNING_JWK = JSON.stringify({ ...control.privateKey.export({ format: 'jwk' }), kid: `control-${id}`, alg: 'EdDSA' });
  environment.ZENITH_OIDC_SIGNING_JWK = JSON.stringify({ ...oidc.privateKey.export({ format: 'jwk' }), kid: `oidc-${id}`, alg: 'RS256' });
  /** @type {PreparedInstallation} */
  const result = { ...input, environment, schemaVersion: 2, installationId: id, projectName: `zenith-${id}`, source: sourceBinding() };
  validateInput(result, true);
  fs.mkdirSync(dir, { mode: 0o700, recursive: true });
  assertPrivate(dir, true);
  if (result.mode === 'disposable') issueTemporalTls(dir);
  writeJson(path.join(dir, 'installation.json'), result);
  writeJson(path.join(dir, 'keyring.json'), result);
  for (const [name, env] of Object.entries(environmentsFor(result, dir))) writeEnv(path.join(dir, name), env);
  writeJson(path.join(dir, 'plan.json'), planFor(result));
  return result;
}

/** A joined worker inherits the exact private authority, never new signing keys.
 * @param {PreparedInstallation} parent @param {string} workerId @returns {PreparedInstallation} */
export function joinedConfiguration(parent, workerId) {
  validateInput(parent, true);
  if (parent.workerId || !/^[a-f0-9]{24}$/.test(workerId) || workerId === parent.installationId) refuse('worker-identity');
  return { ...parent, workerId, images: { ...parent.images }, environment: { ...parent.environment }, source: { ...parent.source } };
}

/** The shared file remains beside its canonical installation and effective env.
 * @param {string} keyringFile @param {string} directory @returns {PreparedInstallation} */
export function prepareJoin(keyringFile, directory) {
  const file = privateLocation(keyringFile), dir = privateLocation(directory);
  if (path.basename(file) !== 'keyring.json') refuse('join-keyring');
  assertPrivate(file);
  const parent = readPrepared(path.dirname(file));
  if (fs.readFileSync(file, 'utf8') !== `${JSON.stringify(parent, null, 2)}\n`) refuse('join-keyring-drift');
  if (fs.existsSync(dir)) refuse('private-directory-already-exists');
  const config = joinedConfiguration(parent, randomBytes(12).toString('hex'));
  fs.mkdirSync(dir, { mode: 0o700, recursive: true });
  assertPrivate(dir, true);
  if (config.mode === 'disposable') {
    fs.mkdirSync(path.join(dir, 'temporal-tls'), { mode: 0o700 });
    for (const name of TEMPORAL_CLIENT_FILES) fs.copyFileSync(path.join(path.dirname(file), 'temporal-tls', name), path.join(dir, 'temporal-tls', name), fs.constants.COPYFILE_EXCL);
    for (const name of TEMPORAL_CLIENT_FILES) fs.chmodSync(path.join(dir, 'temporal-tls', name), 0o600);
  }
  writeJson(path.join(dir, 'installation.json'), config);
  for (const [name, env] of Object.entries(environmentsFor(config, dir))) writeEnv(path.join(dir, name), env);
  writeJson(path.join(dir, 'worker.compose.json'), joinComposition(config, dir));
  writeJson(path.join(dir, 'plan.json'), planFor(config));
  return config;
}

/** Standalone extra worker on the parent's network, with its own named scratch.
 * @param {PreparedInstallation} config @param {string} directory */
export function joinComposition(config, directory) {
  if (!config.workerId) refuse('worker-identity');
  const name = `execution-worker-${config.workerId}`, volume = `worker-${config.workerId}`;
  const labels = { 'io.zenith.installation': config.installationId, 'io.zenith.worker': config.workerId };
  return { services: { [name]: {
    image: config.images.worker, user: '10001:10001', read_only: true, init: true,
    restart: 'unless-stopped', cap_drop: ['ALL'], security_opt: ['no-new-privileges:true'], labels,
    env_file: [{ path: path.join(privateLocation(directory), 'worker.env'), format: 'raw' }],
    volumes: [`${volume}:/var/lib/zenith`, ...(config.mode === 'disposable' ? TEMPORAL_CLIENT_FILES.map(name => `${path.join(privateLocation(directory), 'temporal-tls', name)}:/run/zenith-temporal/${name}:ro`) : [])], networks: ['installation'],
    tmpfs: ['/tmp:rw,nosuid,size=256m,uid=10001,gid=10001,mode=1770'],
    cpus: 1, mem_limit: '1g', pids_limit: 512, stop_grace_period: '11m',
    healthcheck: { test: ['CMD', 'node', '-e', "fetch('http://127.0.0.1:9464/readyz',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"], interval: '15s', timeout: '5s', start_period: '60s', retries: 8 },
  } }, networks: { installation: { external: true, name: `${config.projectName}_installation` } }, volumes: { [volume]: { labels } } };
}

/** @param {PreparedInstallation} config */
export function planFor(config) {
  return { schemaVersion: 1, installationId: config.installationId, projectName: config.projectName, mode: config.mode,
    source: { head: config.source.head, contentSha256: config.source.contentSha256, dirty: config.source.dirty }, configurationSha256: hash(JSON.stringify(config)),
    services: config.workerId ? [`execution-worker-${config.workerId}`] : config.mode === 'production' ? ['api', 'execution-worker'] : ['api', 'execution-worker', 'temporal'],
    maintenance: config.workerId ? [] : ['platform-migrate'], workerReplicasPerProject: 1, additionalWorkerPreparationSupported: true, workerId: config.workerId, apiBinding: `127.0.0.1:${config.apiPort}`, siteOrigin: config.environment.NEXT_PUBLIC_SITE_URL, publishedEnginePorts: [],
    limits: { production: { cpu: 4, memoryGiB: 5 }, disposable: { cpu: 5, memoryGiB: 6 }, maintenanceAdditional: { cpu: 1, memoryGiB: 1 } },
    volumes: config.workerId ? [`worker-${config.workerId}`] : ['api-data', 'worker-data', ...(config.mode === 'disposable' ? ['temporal-data'] : [])],
    images: { api: config.images.api, worker: config.images.worker, migration: config.images.migration }, externalSupabaseRequired: true, fullyLocal: false, apiStartupApprovalRequired: true,
    networkValidated: false, productionReady: false,
    pendingAcceptance: ['image-build-and-baked-public-auth', 'supabase-migrations-and-sign-in', 'pooler-and-platform-tls', 'temporal-auth-and-recovery', 'api-browser-and-mcp-live', 'customer-agent-registration-and-real-execution', 'multiworker-concurrency-and-backup-restore'],
    mcpOAuthConfigured: Boolean(config.environment.ZENITH_AGENT_OAUTH_ISSUER),
  };
}

/** @param {string} directory @returns {PreparedInstallation} */
export function readPrepared(directory) {
  const dir = privateLocation(directory);
  assertPrivate(dir, true);
  assertPrivate(path.join(dir, 'installation.json'));
  const config = JSON.parse(fs.readFileSync(path.join(dir, 'installation.json'), 'utf8'));
  assertPreparedVersion(config);
  if (!/^[a-f0-9]{24}$/.test(config.installationId) || config.projectName !== `zenith-${config.installationId}`) refuse('installation-identity');
  validateInput(config, true);
  if (config.mode === 'disposable') assertTemporalTls(dir, config.workerId ? TEMPORAL_CLIENT_FILES : TEMPORAL_TLS_FILES);
  for (const [name, env] of Object.entries(environmentsFor(config, dir))) {
    const file = path.join(dir, name);
    assertPrivate(file);
    const expected = Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n') + '\n';
    if (fs.readFileSync(file, 'utf8') !== expected) refuse('effective-configuration-drift');
  }
  if (config.workerId) {
    const file = path.join(dir, 'worker.compose.json');
    assertPrivate(file);
    if (fs.readFileSync(file, 'utf8') !== `${JSON.stringify(joinComposition(config, dir), null, 2)}\n`) refuse('effective-configuration-drift');
  }
  return config;
}
/** Safe argv, with no secret values; no startup/cleanup commands.
 * @param {PreparedInstallation} config @param {string} directory */
export function composeArgs(config, directory) {
  if (config.workerId) return ['compose', '--project-name', config.projectName, '--env-file', path.join(privateLocation(directory), 'compose.env'), '-f', path.join(privateLocation(directory), 'worker.compose.json')];
  return ['compose', '--project-name', config.projectName, '--env-file', path.join(privateLocation(directory), 'compose.env'), '-f', compose,
    ...(config.mode === 'disposable' ? ['-f', overlay] : [])];
}
/** Compose interpolation must use validated private settings, not shell overrides.
 * @param {Record<string,string|undefined>} environment @returns {Record<string,string|undefined>} */
export function composeEnvironment(environment = process.env) {
  const result = { ...environment };
  for (const key of ['ZENITH_INSTALLATION_ID', 'ZENITH_PRIVATE_DIR', 'ZENITH_API_PORT', 'ZENITH_API_IMAGE', 'ZENITH_WORKER_IMAGE', 'ZENITH_MIGRATION_IMAGE']) delete result[key];
  return result;
}
/** @param {PreparedInstallation} config @param {string} directory */
export function checkCompose(config, directory) {
  const result = spawnSync('docker', [...composeArgs(config, directory), 'config', '--quiet'], { cwd: root, env: composeEnvironment(), encoding: 'utf8', timeout: 30_000 });
  if (result.status !== 0) refuse('compose-config'); // Never emit stderr; Compose can expand secrets.
  return { schemaVersion: 1, kind: 'configuration-only', configurationSha256: hash(JSON.stringify(config)), composeConfigValid: true, servicesStarted: false };
}

/** Read-only real endpoint checks. Results contain trusted IDs, never bodies/errors.
 * @param {PreparedInstallation} config @param {typeof fetch} fetcher */
export async function probeReadiness(config, fetcher = fetch) {
  const origin = config.environment.NEXT_PUBLIC_SITE_URL;
  /** @type {Record<string,string>} */ const checks = {};
  const probe = async (/** @type {string} */ id, /** @type {string} */ endpoint, /** @type {(response:Response)=>Promise<boolean>} */ accept) => {
    try {
      const response = await fetcher(`${origin}${endpoint}`, { redirect: 'error', signal: AbortSignal.timeout(5000), headers: { accept: 'application/json' } });
      checks[id] = await accept(response) ? 'passed' : 'failed';
    } catch { checks[id] = 'failed'; }
  };
  await probe('api-configured', '/api/me', async r => r.ok && (await r.json()).configured === true);
  await probe('browser-login-http', '/login', async r => r.ok && (r.headers.get('content-type') ?? '').includes('text/html'));
  await probe('mcp-bearer-boundary', '/api/agent/v3/mcp', async r => r.status === 401 && (r.headers.get('www-authenticate') ?? '').includes(`Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/api/agent/v3/mcp"`));
  if (config.environment.ZENITH_AGENT_OAUTH_ISSUER) {
    await probe('mcp-oauth-metadata', '/api/agent/v3/mcp?metadata=oauth-protected-resource', async r => {
      if (!r.ok) return false;
      const body = await r.json();
      return body.resource === `${origin}/api/agent/v3/mcp` && body.authorization_servers?.length === 1 && body.authorization_servers[0] === config.environment.ZENITH_AGENT_OAUTH_ISSUER;
    });
  } else checks['mcp-oauth-metadata'] = 'not-configured';
  return { schemaVersion: 1, kind: 'http-readiness-only', configurationSha256: hash(JSON.stringify(config)), checks,
    ready: Object.values(checks).every(status => status === 'passed' || status === 'not-configured'),
    authenticatedAcceptance: false, browserInteractiveAcceptance: false, productionReady: false };
}

/** @param {string[]} args */
async function main(args) {
  if (args[0] === 'prepare' && args[1] === '--join') {
    if (args.length !== 4) refuse('usage');
    process.stdout.write(`${JSON.stringify(planFor(prepareJoin(args[2], args[3])))}\n`);
    return;
  }
  const [command, directory, inputFile] = args;
  if (!directory || args.length > 3) refuse('usage');
  if (command === 'prepare') {
    if (!inputFile) refuse('input-file');
    privateLocation(inputFile);
    assertPrivate(inputFile);
    const config = prepare(JSON.parse(fs.readFileSync(inputFile, 'utf8')), directory);
    process.stdout.write(`${JSON.stringify(planFor(config))}\n`);
    return;
  }
  const config = readPrepared(directory);
  if (command === 'preflight') process.stdout.write(`${JSON.stringify(planFor(config))}\n`);
  else if (command === 'compose-check') process.stdout.write(`${JSON.stringify(checkCompose(config, directory))}\n`);
  else if (command === 'readiness') {
    const result = await probeReadiness(config);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.ready) process.exitCode = 1;
  } else refuse('usage');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    // Filesystem, JSON and provider failures may contain credentials or paths.
    const id = error instanceof Error && /^installation:[A-Za-z0-9._-]+$/.test(error.message) ? error.message : 'installation:preparation-failed';
    process.stderr.write(`${id}\n`);
    process.exitCode = 1;
  });
}
