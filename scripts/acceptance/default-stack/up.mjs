import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { prepareJoin, privateLocation, assertPrivate, writeJson, readPrepared, sourceBinding } from '../../deploy/installation.mjs';
import { root, cliVersion, ports, topology, supabaseConfig, mailpitEnvironment, digestImage, excludedSupabaseServices, installationLabel, projectLabel, stackComposition, fail, assertHeadroom } from './config.mjs';
import { cli, run, docker, compose, requireEngineGate, save, cleanup, setResourceGuard } from './runtime.mjs';
import { readiness } from './readiness.mjs';
import { deferredJ4Composition, initializeJ4Namespace, j4PrestartReadiness, prepareJ4Ownership } from './j4.mjs';
import { envValues } from '../../deploy/pin-digests.mjs';
import { startLeanCliServices } from './start-cli-services.mjs';
import { cliServiceCommand } from './cli-command.mjs';

const nodeImage = 'node:22.23.3-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402';
const privateFile = (file, text) => fs.writeFileSync(file, text, { mode: 0o600, flag: 'wx' });

async function certificates(directory) {
  fs.mkdirSync(directory, { mode: 0o700 });
  await run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=Zenith disposable CA', '-addext', 'basicConstraints=critical,CA:TRUE', '-keyout', path.join(directory, 'ca.key'), '-out', path.join(directory, 'ca.crt')]);
  for (const name of ['edge', 'pooler']) {
    privateFile(path.join(directory, `${name}.ext`), `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:supabase.localhost,DNS:supabase-pooler,DNS:localhost,IP:127.0.0.1\n`);
    await run('openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=${name}`, '-keyout', path.join(directory, `${name}.key`), '-out', path.join(directory, `${name}.csr`)]);
    await run('openssl', ['x509', '-req', '-in', path.join(directory, `${name}.csr`), '-CA', path.join(directory, 'ca.crt'), '-CAkey', path.join(directory, 'ca.key'), '-CAcreateserial', '-days', '2', '-extfile', path.join(directory, `${name}.ext`), '-out', path.join(directory, `${name}.crt`)]);
  }
  for (const file of fs.readdirSync(directory)) fs.chmodSync(path.join(directory, file), file.endsWith('.crt') ? 0o644 : 0o600);
}

function nativeArch(architecture) {
  const normalized = { aarch64: 'arm64', arm64: 'arm64', x86_64: 'amd64', amd64: 'amd64' }[architecture];
  if (normalized !== { arm64: 'arm64', x64: 'amd64' }[process.arch]) fail('native-architecture');
  return normalized;
}

/** Recreate only the positively labelled CLI container, pinned to its opened image ID.
 * Keep the CLI's actual environment, mounts and health check. Replace the
 * known DB/Kong setup shell with its service so stop signals reach PID 1.
 * Other changes are ownership, bounded resources, loopback and pooler TLS.
 */
async function boundCliService(state, role) {
  const name = `supabase_${role}_${state.projectId}`;
  const [item] = JSON.parse(await docker(['inspect', name]));
  if (item.Config.Labels?.[projectLabel] !== state.projectId || !/^sha256:[a-f0-9]{64}$/.test(item.Image)) fail('cli-ownership');
  const [image] = JSON.parse(await docker(['image', 'inspect', item.Image]));
  nativeArch(image.Architecture);
  const snapshot = { role, imageId: item.Image, references: image.RepoDigests ?? [], architecture: image.Architecture };
  if (state.imageLock && JSON.stringify(state.imageLock.find(value => value.role === role)) !== JSON.stringify(snapshot)) fail('cli-image-lock');
  const { entrypoint, command } = cliServiceCommand(role, item.Config.Entrypoint ?? [], item.Config.Cmd ?? []);
  const envFile = path.join(state.directory, `${role}.env`);
  const env = item.Config.Env.map(value => role === 'auth' && value.startsWith('API_EXTERNAL_URL=') ? `API_EXTERNAL_URL=https://supabase.localhost:${ports.supabase}` : value);
  if (role === 'pooler') {
    for (let i = env.length - 1; i >= 0; i--) if (env[i].startsWith('DB_POOL_SIZE=')) env.splice(i, 1);
    env.push('GLOBAL_DOWNSTREAM_CERT_PATH=/run/zenith/pooler.crt', 'GLOBAL_DOWNSTREAM_KEY_PATH=/run/zenith/pooler.key', `DB_POOL_SIZE=${topology(state.profile).poolSize}`, 'ERL_FLAGS=+S 2:2 +SDcpu 1 +SDio 1');
  }
  if (env.some(value => /[\r\n\0]/.test(value))) fail('cli-environment');
  privateFile(envFile, env.join('\n') + '\n');
  const args = ['create', '--name', name, '--network', state.supabaseNetwork,
    '--label', `${installationLabel}=${state.installationId}`, '--label', `${projectLabel}=${state.projectId}`,
    '--env-file', envFile, '--memory', `${topology(state.profile).supabaseMiB[role]}m`, '--cpus', '1', '--pids-limit', '256'];
  if (item.Config.User) args.push('--user', item.Config.User);
  for (const mount of item.Mounts) {
    if (!['volume', 'bind'].includes(mount.Type)) fail('cli-mount');
    if (mount.Type === 'bind') privateLocation(mount.Source);
    else {
      const [volume] = JSON.parse(await docker(['volume', 'inspect', mount.Name]));
      if (volume.Labels?.[projectLabel] !== state.projectId) fail('cli-volume-ownership');
    }
    args.push('--mount', `type=${mount.Type},source=${mount.Type === 'volume' ? mount.Name : mount.Source},target=${mount.Destination}${mount.RW ? '' : ',readonly'}`);
  }
  if (role === 'pooler') {
    args.push('-p', `127.0.0.1:${ports.pooler}:6543`);
    for (const file of ['pooler.crt', 'pooler.key']) args.push('--mount', `type=bind,source=${path.join(state.directory, 'tls', file)},target=/run/zenith/${file},readonly`);
  } else {
    for (const [port, bindings] of Object.entries(item.HostConfig.PortBindings ?? {})) for (const binding of bindings ?? []) args.push('-p', `127.0.0.1:${binding.HostPort}:${port}`);
  }
  const health = item.Config.Healthcheck?.Test;
  if (health?.[0] === 'CMD') args.push('--health-cmd', health.slice(1).map(value => `'${value.replaceAll("'", "'\\''")}'`).join(' '));
  else if (health?.[0] === 'CMD-SHELL') args.push('--health-cmd', health[1]);
  if (health) args.push('--health-interval', '5s', '--health-retries', '20', '--health-start-period', '60s');
  if (entrypoint.length) args.push('--entrypoint', entrypoint[0]);
  args.push(item.Image, ...entrypoint.slice(1), ...command);
  await docker(['stop', name]); await docker(['rm', name]);
  await docker(args); await docker(['start', name]);
  return snapshot;
}

async function build(state, kind, file, publicEnvironment) {
  const tag = `localhost:${ports.registry}/zenith-${state.installationId}/${kind}:local`;
  const args = ['build', '--platform', `linux/${state.architecture}`, '--label', `${installationLabel}=${state.installationId}`, '-f', file, '-t', tag];
  if (kind === 'api') for (const [key, value] of Object.entries(publicEnvironment)) args.push('--build-arg', `${key}=${value}`);
  await docker([...args, root], { timeout: 1_800_000, id: `build-${kind}` });
  await docker(['push', tag], { id: `push-${kind}` });
  const [image] = JSON.parse(await docker(['image', 'inspect', tag])); nativeArch(image.Architecture);
  const reference = image.RepoDigests.find(value => value.startsWith(tag.split(':local')[0] + '@'));
  return digestImage(reference);
}

export function parseJ4UpOptions(args) {
  let profile = 'default', directory, imageLock, deferWorkers = false, namespace, temporalPort;
  while (args.length) {
    const flag = args.shift();
    if (flag === '--j4-defer-workers') { if (deferWorkers) fail('usage'); deferWorkers = true; continue; }
    const value = args.shift(); if (!value) fail('usage');
    if (flag === '--profile') profile = value;
    else if (flag === '--directory') directory = value;
    else if (flag === '--supabase-image-lock') imageLock = value;
    else if (flag === '--j4-namespace') { if (namespace !== undefined) fail('usage'); namespace = value; }
    else if (flag === '--j4-temporal-port') { if (temporalPort !== undefined) fail('usage'); temporalPort = value === String(ports.j4Temporal) ? ports.j4Temporal : Number.NaN; }
    else fail('usage');
  }
  const hasJ4 = deferWorkers || namespace !== undefined || temporalPort !== undefined;
  if (hasJ4 && (!deferWorkers || profile !== 'lean' || !/^j4-[a-z0-9-]{1,50}$/.test(namespace ?? '') || temporalPort !== ports.j4Temporal)) fail('j4-options');
  return { profile, directory, imageLock, j4: hasJ4 ? { namespace, temporalPort } : undefined };
}

export async function up(directory, profile = 'default', imageLockFile, j4Options = undefined) {
  requireEngineGate(); topology(profile);
  if (j4Options && (profile !== 'lean' || !/^j4-[a-z0-9-]{1,50}$/.test(j4Options.namespace ?? '') || j4Options.temporalPort !== ports.j4Temporal)) fail('j4-options');
  const registryPin = digestImage(process.env.ZENITH_DEFAULT_STACK_REGISTRY_IMAGE);
  if (await run('supabase', ['--version']) !== cliVersion) fail('supabase-cli-version');
  const dir = privateLocation(directory);
  if (fs.existsSync(dir)) fail('directory-already-exists');
  const installationId = randomBytes(12).toString('hex');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); assertPrivate(dir, true);
  const state = { schemaVersion: 1, directory: dir, installationId, projectId: `zenith-local-${installationId}`, profile,
    architecture: nativeArch(await docker(['info', '--format', '{{.Architecture}}'])), supabaseNetwork: `zenith-local-${installationId}-supabase`, imageLock: undefined };
  if (imageLockFile) {
    const file = privateLocation(imageLockFile); assertPrivate(file); state.imageLock = JSON.parse(fs.readFileSync(file, 'utf8'));
    const roles = Object.keys(topology(profile).supabaseMiB).sort();
    if (!Array.isArray(state.imageLock) || JSON.stringify(state.imageLock.map(value => value.role).sort()) !== JSON.stringify(roles)) fail('cli-image-lock');
  }
  save(path.join(dir, 'state.json'), state); // Makes every subsequent partial failure cleanable.
  setResourceGuard(() => {
    const space = fs.statfsSync(fs.realpathSync(os.homedir()));
    const available = space.bavail * space.bsize;
    state.minimumObservedFreeBytes = Math.min(state.minimumObservedFreeBytes ?? available, available);
    assertHeadroom(available);
  });
  let operationStage = 'certificates';
  try {
    await certificates(path.join(dir, 'tls'));
    const cliDir = path.join(dir, 'supabase-project'); fs.mkdirSync(path.join(cliDir, 'supabase'), { recursive: true, mode: 0o700 });
    privateFile(path.join(cliDir, 'supabase/config.toml'), supabaseConfig(state.projectId, profile));
    operationStage = 'supabase-network-create';
    await docker(['network', 'create', '--label', `${installationLabel}=${installationId}`, '--opt', 'com.docker.network.bridge.host_binding_ipv4=127.0.0.1', state.supabaseNetwork]);
    const smtpPassword = randomBytes(32).toString('hex');
    const smtpEnv = Object.freeze({ ZENITH_MAILPIT_SMTP_PASS: smtpPassword });
    const mailpitEnvFile = path.join(dir, 'mailpit.env');
    privateFile(mailpitEnvFile, mailpitEnvironment(state.projectId, smtpPassword));
    const mailpitImage = digestImage(envValues(fs.readFileSync(path.join(root, 'deploy/observability/images.env'), 'utf8')).ZENITH_MAILPIT_IMAGE);
    await docker(['pull', mailpitImage]);
    const [mailImage] = JSON.parse(await docker(['image', 'inspect', mailpitImage])); nativeArch(mailImage.Architecture);
    await docker(['run', '-d', '--name', `zenith-local-${installationId}-mailpit`, '--network', state.supabaseNetwork, '--network-alias', 'mailpit',
      '--label', `${installationLabel}=${installationId}`, '--memory', '64m', '--cpus', '0.25', '--pids-limit', '64', '--user', '1000:1000',
      '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--tmpfs', '/tmp:rw,noexec,nosuid,size=32m,uid=1000,gid=1000,mode=1770',
      '--env-file', mailpitEnvFile, '-p', `127.0.0.1:${ports.mail}:8025`, mailpitImage]);
    state.mailpitUrl = `http://127.0.0.1:${ports.mail}`;
    state.mailpitImage = { reference: mailpitImage, imageId: mailImage.Id, architecture: mailImage.Architecture };
    operationStage = 'supabase-start';
    await run('supabase', ['start', '--workdir', cliDir, '--network-id', state.supabaseNetwork, '--exclude', excludedSupabaseServices], {
      timeout: 600_000, id: 'supabase-start', env: smtpEnv,
    });
    operationStage = 'supabase-status';
    const status = JSON.parse(await run('supabase', ['status', '--workdir', cliDir, '--output', 'json'], { id: 'supabase-status', env: smtpEnv }));
    // Never assume or print the CLI's credentials; use its actual status output.
    if (!status.ANON_KEY || !status.SERVICE_ROLE_KEY || !status.DB_URL) fail('supabase-status');
    state.supabaseImages = [];
    for (const role of Object.keys(topology(profile).supabaseMiB)) state.supabaseImages.push(await boundCliService(state, role));
    save(path.join(dir, 'supabase.images.json'), state.supabaseImages);
    // Apply every immutable committed snapshot, in order, with actual Supabase roles.
    const dbContainer = `supabase_db_${state.projectId}`;
    operationStage = 'supabase-migrations';
    for (const file of fs.readdirSync(path.join(root, 'supabase/migrations')).filter(file => /^\d+.*\.sql$/.test(file)).sort()) {
      await docker(['exec', '-i', dbContainer, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], { input: fs.readFileSync(path.join(root, 'supabase/migrations', file)), id: 'supabase-migrations' });
    }
    await docker(['pull', digestImage(registryPin)]);
    const [registryImage] = JSON.parse(await docker(['image', 'inspect', registryPin])); nativeArch(registryImage.Architecture);
    const registryVolume = `zenith-local-${installationId}-registry`;
    await docker(['volume', 'create', '--label', `${installationLabel}=${installationId}`, registryVolume]);
    await docker(['run', '-d', '--name', `zenith-local-${installationId}-registry`, '--label', `${installationLabel}=${installationId}`, '-p', '127.0.0.1:5000:5000', '--memory', '64m', '--mount', `type=volume,source=${registryVolume},target=/var/lib/registry`, registryPin]);
    const publicEnv = { NEXT_PUBLIC_SUPABASE_URL: `https://supabase.localhost:${ports.supabase}`, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: status.ANON_KEY, NEXT_PUBLIC_SITE_URL: `http://127.0.0.1:${ports.api}` };
    const images = {};
    const buildSource = sourceBinding();
    operationStage = 'application-image-build';
    // Image compilation is serialized. Free the CLI engines' memory during a
    // lean build, rather than fitting a compiler beside the running stack.
    const cliContainers = Object.keys(topology(profile).supabaseMiB).map(role => `supabase_${role}_${state.projectId}`);
    if (profile === 'lean') await docker(['stop', ...cliContainers]);
    for (const [kind, file] of [['api', 'Dockerfile'], ['worker', 'docker/worker.Dockerfile'], ['migration', 'deploy/self-hosted/migrations.Dockerfile']]) images[kind] = await build(state, kind, file, publicEnv);
    if (JSON.stringify(sourceBinding()) !== JSON.stringify(buildSource)) fail('source-changed-during-build');
    if (profile === 'lean') {
      operationStage = 'supabase-restart';
      await startLeanCliServices({ projectId: state.projectId, serviceNames: cliContainers, docker });
    }
    const db = new URL(status.DB_URL);
    const input = { mode: 'disposable', apiPort: ports.api, images, environment: { ...publicEnv,
      SUPABASE_URL: publicEnv.NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
      SUPABASE_DB_URL: `postgresql://postgres.pooler-dev:${db.password}@supabase-pooler:6543/postgres?sslmode=verify-full` } };
    const inputFile = path.join(dir, 'input.json'); writeJson(inputFile, input);
    // Invoke the real prepare CLI; its original authority and binding guards stay intact.
    operationStage = 'application-prepare';
    await run(process.execPath, [path.join(root, 'scripts/deploy/installation.mjs'), 'prepare', path.join(dir, 'installation'), inputFile], { id: 'installation-prepare' });
    const config = readPrepared(path.join(dir, 'installation'));
    if (JSON.stringify(config.source) !== JSON.stringify(buildSource)) fail('source-changed-during-prepare');
    state.applicationInstallationId = config.installationId; state.applicationProjectName = config.projectName; state.source = config.source;
    save(path.join(dir, 'state.json'), state);
    let peer;
    if (topology(profile).workers === 2) peer = prepareJoin(path.join(dir, 'installation/keyring.json'), path.join(dir, 'worker-peer'));
    await docker(['pull', nodeImage]);
    const canonicalDocument = stackComposition({ ...config, supabaseKong: `supabase_kong_${state.projectId}` }, path.join(dir, 'installation'), profile, nodeImage, peer);
    const document = structuredClone(canonicalDocument);
    document.services['supabase-edge'].user = `${process.getuid()}:${process.getgid()}`;
    document.networks.installation.driver_opts = { 'com.docker.network.bridge.host_binding_ipv4': '127.0.0.1' };
    const canonicalComposition = `${JSON.stringify(document, null, 2)}\n`;
    operationStage = 'composition-write';
    if (j4Options) {
      const deferred = deferredJ4Composition(document, path.join(dir, 'j4/api.env'), j4Options.namespace, j4Options.temporalPort);
      const deferredComposition = `${JSON.stringify(deferred, null, 2)}\n`;
      const prepared = prepareJ4Ownership(state, config, canonicalComposition, j4Options, deferredComposition);
      writeJson(path.join(dir, 'installation/stack.compose.json'), deferred);
      state.j4Mode = 'deferred'; state.j4Namespace = j4Options.namespace; state.j4TemporalPort = j4Options.temporalPort;
      state.canonicalCompositionSha256 = prepared.manifest.canonicalCompositionSha256;
    } else writeJson(path.join(dir, 'installation/stack.compose.json'), document);
    state.compositionSha256 = createHash('sha256').update(fs.readFileSync(path.join(dir, 'installation/stack.compose.json'))).digest('hex');
    save(path.join(dir, 'state.json'), state);
    operationStage = 'composition-validate';
    await compose(state, ['config', '--quiet']);
    operationStage = 'temporal-start';
    await compose(state, ['up', '-d', '--wait', '--wait-timeout', '180', 'temporal']);
    operationStage = 'network-attach';
    const network = `${config.projectName}_installation`;
    await docker(['network', 'connect', network, `supabase_kong_${state.projectId}`]);
    await docker(['network', 'connect', '--alias', 'supabase-pooler', network, `supabase_pooler_${state.projectId}`]);
    await docker(['network', 'connect', '--alias', 'supabase-db', network, dbContainer]);
    // Committed Supabase snapshots already install platform. Refuse a stale
    // ledger instead of silently installing missing platform migrations here.
    operationStage = 'platform-migration-status';
    await compose(state, ['run', '--rm', '--no-deps', 'platform-migrate', '--status']);
    operationStage = 'platform-migration';
    const migration = await compose(state, ['run', '--rm', '--no-deps', 'platform-migrate']);
    if (!migration.endsWith('Already up to date.')) fail('platform-migration-not-noop');
    if (j4Options) {
      operationStage = 'j4-edge-start';
      await compose(state, ['up', '-d', '--wait', '--wait-timeout', '180', 'supabase-edge']);
      operationStage = 'j4-namespace-admission';
      await initializeJ4Namespace(state);
      operationStage = 'j4-pre-api-readiness';
      const preApiDatabase = await j4PrestartReadiness(state, { includeApiProbe: false });
      const preApiFile = path.join(dir, 'j4-preapi.receipt.json'); writeJson(preApiFile, preApiDatabase);
      const ownershipFile = path.join(dir, 'j4/ownership.json');
      const ownership = JSON.parse(fs.readFileSync(ownershipFile, 'utf8'));
      ownership.preApiReceiptSha256 = createHash('sha256').update(fs.readFileSync(preApiFile)).digest('hex');
      save(ownershipFile, ownership);
      save(path.join(dir, 'state.json'), state);
      operationStage = 'j4-application-start';
      await compose(state, ['up', '-d', '--wait', '--wait-timeout', '300', 'supabase-edge', 'api']);
    } else { operationStage = 'application-start'; await compose(state, ['up', '-d', '--wait', '--wait-timeout', '300']); }
    save(path.join(dir, 'state.json'), state);
    operationStage = 'stack-readiness';
    const receipt = j4Options ? await j4PrestartReadiness(state) : await readiness(state);
    save(path.join(dir, 'state.json'), state);
    setResourceGuard(undefined);
    process.stdout.write(`${JSON.stringify({ ...receipt, directory: dir })}\n`);
    return state;
  } catch (error) {
    save(path.join(dir, 'state.json'), state);
    const reason = error instanceof Error && /^(default-stack|installation):[A-Za-z0-9._-]+$/.test(error.message) ? error.message : 'default-stack:failed';
    const grpcCode = Number.isInteger(error?.code) && error.code >= 0 && error.code <= 16 ? error.code : undefined;
    save(path.join(dir, 'failure.receipt.json'), { schemaVersion: 1, kind: 'harness_operation', status: 'failed', reason, stage: operationStage, ...(grpcCode === undefined ? {} : { grpcCode }), productionReady: false });
    if (j4Options) save(path.join(dir, 'j4-retain.receipt.json'), { schemaVersion: 1, kind: 'j4_owned_stack', status: 'retained_after_failure', j1Ready: false, productionReady: false });
    else try { await cleanup(state); } catch { save(path.join(dir, 'cleanup.pending.json'), { reason: 'owned-cleanup-requires-retry' }); }
    throw error;
  } finally { setResourceGuard(undefined); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await cli(async () => {
  const { profile, directory: suppliedDirectory, imageLock, j4 } = parseJ4UpOptions(process.argv.slice(2));
  let directory = suppliedDirectory;
  if (!directory) directory = path.join(fs.realpathSync(os.tmpdir()), `zenith-default-${randomBytes(12).toString('hex')}`);
  await up(directory, profile, imageLock, j4);
});
