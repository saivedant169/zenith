import fs from 'node:fs';
import path from 'node:path';
import { load } from 'js-yaml';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const cliVersion = '2.75.0';
export const installationLabel = 'io.zenith.installation';
export const projectLabel = 'com.supabase.cli.project';
export const fail = id => { throw new Error(`default-stack:${id}`); };
/** One validated offset moves every owned host port so a stack can run beside an existing local Supabase.
 * The registry stays on 5000: owned image references pin that address. */
export function portsFor(offset) {
  if (!Number.isInteger(offset) || offset < 0 || offset > 10000) fail('port-offset');
  return Object.freeze({ api: 36400 + offset, peerApi: 36401 + offset, supabase: 54321 + offset, cliApi: 54326 + offset, db: 54322 + offset,
    shadow: 54320 + offset, mail: 8025 + offset, pooler: 6543 + offset, cliPooler: 54329 + offset, j4Temporal: 17233 + offset, registry: 5000 });
}
const offsetText = process.env.ZENITH_DEFAULT_STACK_PORT_OFFSET ?? '0';
if (!/^(0|[1-9][0-9]{0,4})$/.test(offsetText)) fail('port-offset');
export const portOffset = Number(offsetText);
export const ports = portsFor(portOffset);
export const excludedSupabaseServices = 'mailpit,storage-api,imgproxy,realtime,studio,postgres-meta,logflare,vector,edge-runtime';
export const minimumFreeBytes = 22 * 1024 ** 3;
export function mailpitEnvironment(projectId, password) {
  if (!/^zenith-local-[a-f0-9]{24}$/.test(projectId) || !/^[a-f0-9]{64}$/.test(password)) fail('mailpit-smtp-identity');
  // Auth's Go SMTP client never sends credentials over plaintext to a non-loopback host,
  // so the owned Mailpit requires STARTTLS with a leaf from the stack's private CA.
  return `MP_DATABASE=/tmp/mailpit.db\nMP_SMTP_AUTH=${projectId}:${password}\nMP_SMTP_TLS_CERT=/run/zenith/mailpit.crt\nMP_SMTP_TLS_KEY=/run/zenith/mailpit.key\nMP_SMTP_REQUIRE_STARTTLS=true\n`;
}
export function assertHeadroom(availableBytes) {
  if (!Number.isSafeInteger(availableBytes) || availableBytes < minimumFreeBytes) fail('disk-headroom');
}
export const digestImage = value => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(value)) fail('image-digest');
  return value;
};

export function topology(profile = 'default') {
  if (!['default', 'lean'].includes(profile)) fail('profile');
  return { profile, apis: profile === 'lean' ? 1 : 2, workers: profile === 'lean' ? 1 : 2,
    // Limits are a plan, not measured headroom or an HA claim.
    apiMiB: profile === 'lean' ? 512 : 768, workerMiB: profile === 'lean' ? 768 : 1024, registryMiB: 256,
    // Measured: at 96 MiB PostgREST hit memory.max ~1M times and spun at 98% CPU, timing out readiness.
    // Measured: at 128 MiB Kong (idle ~110 MiB) was OOM-killed by the API's periodic full-table read burst.
    supabaseMiB: { db: 512, auth: 192, rest: 192, kong: 256, pooler: 256 },
    poolSize: profile === 'lean' ? 5 : 15, nativeArchOnly: true, productionReady: false };
}

/** Generate only the isolated CLI project's settings; never copy secrets into source. */
export function supabaseConfig(projectId, profile = 'default') {
  if (!/^zenith-local-[a-f0-9]{24}$/.test(projectId)) fail('project-identity');
  return `project_id = "${projectId}"
[api]
enabled = true
port = ${ports.cliApi}
schemas = ["public", "graphql_public"]
extra_search_path = ["public", "extensions"]
[api.tls]
enabled = false
[db]
port = ${ports.db}
shadow_port = ${ports.shadow}
major_version = 17
[db.pooler]
enabled = true
port = ${ports.cliPooler}
pool_mode = "transaction"
default_pool_size = ${topology(profile).poolSize}
max_client_conn = 40
[db.migrations]
enabled = false
[db.seed]
enabled = false
[db.settings]
max_connections = 60
shared_buffers = "64MB"
work_mem = "4MB"
[studio]
enabled = false
[inbucket]
enabled = false
[storage]
enabled = false
[realtime]
enabled = false
[analytics]
enabled = false
[edge_runtime]
enabled = false
[auth]
enabled = true
jwt_issuer = "https://supabase.localhost:${ports.supabase}/auth/v1"
site_url = "http://127.0.0.1:${ports.api}"
additional_redirect_urls = ["http://127.0.0.1:${ports.api}/auth/callback"]
enable_signup = true
[auth.email]
enable_signup = true
enable_confirmations = true
max_frequency = "1s"
[auth.email.smtp]
enabled = true
host = "mailpit"
port = 1025
user = "${projectId}"
pass = "env(ZENITH_MAILPIT_SMTP_PASS)"
admin_email = "auth@journey.local"
sender_name = "Zenith local acceptance"
[auth.rate_limit]
email_sent = 60
[auth.mfa]
max_enrolled_factors = 10
[auth.mfa.totp]
enroll_enabled = true
verify_enabled = true
`;
}

/** All CLI resources carry the project label; do not assume name prefixes prove ownership. */
export function owns(labels, state) {
  return [state.installationId, state.applicationInstallationId].filter(Boolean).includes(labels?.[installationLabel]) || labels?.[projectLabel] === state.projectId;
}
/** Pure, deterministic cleanup planning. Foreign/conflicting labels refuse selection. */
export function cleanupPlan(resources, state) {
  if (!/^[a-f0-9]{24}$/.test(state.installationId) || state.projectId !== `zenith-local-${state.installationId}`) fail('identity');
  if (state.applicationInstallationId && !/^[a-f0-9]{24}$/.test(state.applicationInstallationId)) fail('identity');
  return ['container', 'volume', 'network', 'image'].flatMap(kind => {
    const selected = resources.filter(resource => resource.kind === kind && owns(resource.labels, state)).map(resource => {
      if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(resource.id)
        || resource.labels?.[installationLabel] && ![state.installationId, state.applicationInstallationId].includes(resource.labels[installationLabel])
        || resource.labels?.[projectLabel] && resource.labels[projectLabel] !== state.projectId) fail('resource-identity');
      return resource;
    });
    selected.sort((a, b) => {
      if (kind === 'container') {
        const aDatabase = a.item?.Name === `/supabase_db_${state.projectId}`;
        const bDatabase = b.item?.Name === `/supabase_db_${state.projectId}`;
        if (aDatabase !== bDatabase) return aDatabase ? 1 : -1;
      }
      return a.id.localeCompare(b.id);
    });
    return selected.map(resource => ({ kind, id: resource.id }));
  });
}

/** Reuse the shipped composition's restrictions and engine pins. Each process has its own scratch. */
export function stackComposition(config, directory, profile, gatewayImage, peer) {
  const sizing = topology(profile), labels = { [installationLabel]: config.installationId };
  const base = load(fs.readFileSync(path.join(root, 'deploy/self-hosted/compose.yml'), 'utf8'));
  const engines = load(fs.readFileSync(path.join(root, 'deploy/self-hosted/compose.disposable.yml'), 'utf8'));
  const document = { services: {}, networks: { installation: { labels } }, volumes: {} };
  // The overlay's private-directory and repo-relative binds become absolute here.
  const bind = (/** @type {string} */ mount) => mount.replace('${ZENITH_PRIVATE_DIR:?prepare private configuration}', directory)
    .replace(/^\.\//, `${path.join(root, 'deploy/self-hosted')}/`);
  const temporalClient = (engines.services.api.volumes ?? []).map(bind);
  for (const [name, raw] of Object.entries({ ...base.services, ...engines.services })) {
    if (name === 'api' || name === 'execution-worker' || name === 'platform-migrate') continue;
    document.services[name] = { ...raw, labels, ...(raw.volumes ? { volumes: raw.volumes.map(bind) } : {}) };
  }
  document.services.temporal.mem_limit = '256m';
  for (const [name, service] of Object.entries(base.services)) {
    document.services[name] = { ...service, labels,
      env_file: [{ path: path.join(directory, name === 'api' ? 'api.env' : name === 'execution-worker' ? 'worker.env' : 'migration.env'), format: 'raw' }],
      ...(engines.services[name]?.depends_on ? { depends_on: engines.services[name].depends_on } : {}),
    };
  }
  for (const [name, limit] of [['api', sizing.apiMiB], ['execution-worker', sizing.workerMiB], ['platform-migrate', 512]]) {
    const service = document.services[name];
    service.image = digestImage(config.images[name === 'api' ? 'api' : name === 'execution-worker' ? 'worker' : 'migration']);
    service.mem_limit = `${limit}m`; service.cpus = 1;
    service.volumes = [...(service.volumes ?? []), `${path.join(directory, '../tls/ca.crt')}:/run/zenith-ca.crt:ro`, ...(name === 'platform-migrate' ? [] : temporalClient)];
    // The runtime image sets no heap size; Node's default left the lean API about half its container.
    service.environment = { NODE_EXTRA_CA_CERTS: '/run/zenith-ca.crt',
      ...(name === 'platform-migrate' ? {} : { NODE_OPTIONS: `--max-old-space-size=${Math.floor(limit * 3 / 4)}` }) };
  }
  document.services.api.ports = [`127.0.0.1:${ports.api}:3400`];
  document.services.api.tmpfs = ['/tmp:rw,noexec,nosuid,size=64m,uid=1001,gid=1001,mode=1770', '/app/.next/cache:rw,noexec,nosuid,size=64m,uid=1001,gid=1001,mode=1770'];
  document.services['execution-worker'].tmpfs = ['/tmp:rw,nosuid,size=256m,uid=10001,gid=10001,mode=1770'];
  if (sizing.apis === 2) document.services['api-peer'] = { ...structuredClone(document.services.api),
    ports: [`127.0.0.1:${ports.peerApi}:3400`], volumes: ['api-peer-data:/data', `${path.join(directory, '../tls/ca.crt')}:/run/zenith-ca.crt:ro`, ...temporalClient] };
  if (sizing.workers === 2) {
    if (!peer?.workerId || peer.installationId !== config.installationId) fail('joined-worker');
    document.services['execution-worker-peer'] = { ...structuredClone(document.services['execution-worker']),
      env_file: [{ path: path.join(directory, '../worker-peer/worker.env'), format: 'raw' }],
      labels: { ...labels, 'io.zenith.worker': peer.workerId }, volumes: [`worker-${peer.workerId}:/var/lib/zenith`, `${path.join(directory, '../tls/ca.crt')}:/run/zenith-ca.crt:ro`, ...temporalClient] };
  }
  document.services['supabase-edge'] = { image: digestImage(gatewayImage), init: true, user: '1001:1001', read_only: true,
    cap_drop: ['ALL'], security_opt: ['no-new-privileges:true'], labels,
    command: ['node', '/gateway.mjs'], mem_limit: '64m', cpus: 0.25, pids_limit: 64,
    environment: { ZENITH_SUPABASE_UPSTREAM: config.supabaseKong, ZENITH_SUPABASE_EDGE_PORT: String(ports.supabase) },
    volumes: [`${path.join(root, 'deploy/self-hosted/supabase-gateway.mjs')}:/gateway.mjs:ro`, `${path.join(directory, '../tls/edge.crt')}:/run/edge.crt:ro`, `${path.join(directory, '../tls/edge.key')}:/run/edge.key:ro`],
    // Containers and the host share one origin, so the edge listens on its published port.
    ports: [`127.0.0.1:${ports.supabase}:${ports.supabase}`], networks: { installation: { aliases: ['supabase.localhost'] } },
  };
  // The pooler joins this owned network explicitly, using its stable TLS name.
  for (const service of Object.values(document.services)) for (const mount of service.volumes ?? []) {
    const name = mount.split(':')[0];
    if (!name.includes('/') && !name.includes('\\')) document.volumes[name] = { labels };
  }
  return document;
}
