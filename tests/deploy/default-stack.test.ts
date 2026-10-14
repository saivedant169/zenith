import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { joinedConfiguration, validateInput, planFor, installationEnvironment, environmentsFor } from '../../scripts/deploy/installation.mjs';
import { apiProbeRequest, poolerProbeArguments } from '../../scripts/acceptance/default-stack/readiness.mjs';
import { issuerBindings, issuer } from '../../scripts/acceptance/default-stack/issuer.mjs';
import { cleanupPlan, supabaseConfig, mailpitEnvironment, stackComposition, topology, ports, root, installationLabel, projectLabel, digestImage, assertHeadroom, minimumFreeBytes, excludedSupabaseServices } from '../../scripts/acceptance/default-stack/config.mjs';

const secret = () => randomBytes(32).toString('hex');
const id = () => randomBytes(12).toString('hex');
function prepared(): Parameters<typeof joinedConfiguration>[0] {
  const installationId = id();
  return { schemaVersion: 2, mode: 'disposable', installationId, projectName: `zenith-${installationId}`, apiPort: ports.api,
    source: { head: randomBytes(20).toString('hex'), contentSha256: secret(), dirty: false },
    images: { api: `localhost:5000/zenith/api@sha256:${secret()}`, worker: `localhost:5000/zenith/worker@sha256:${secret()}`, migration: `localhost:5000/zenith/migration@sha256:${secret()}` },
    environment: { NEXT_PUBLIC_SITE_URL: `http://127.0.0.1:${ports.api}`, SUPABASE_URL: `https://supabase.localhost:${ports.supabase}`, NEXT_PUBLIC_SUPABASE_URL: `https://supabase.localhost:${ports.supabase}`,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: secret(), SUPABASE_SERVICE_ROLE_KEY: secret(),
      SUPABASE_DB_URL: `postgresql://postgres.pooler-dev:${secret()}@supabase-pooler:6543/postgres?sslmode=verify-full`,
      ZENITH_TEMPORAL_ADDRESS: 'temporal:7233', ZENITH_TEMPORAL_NAMESPACE: 'zenith-disposable', ZENITH_TEMPORAL_TLS: 'false',
      ZENITH_SECRET_KEY: secret(), ZENITH_PLAN_ARTIFACT_KEY: secret(),
      ZENITH_CONTROL_SIGNING_JWK: JSON.stringify(generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' })),
      ZENITH_OIDC_SIGNING_JWK: JSON.stringify(generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'jwk' })),
    } };
}
function parent() {
  const value = prepared();
  const { ZENITH_SECRET_KEY, ZENITH_PLAN_ARTIFACT_KEY, ZENITH_CONTROL_SIGNING_JWK, ZENITH_OIDC_SIGNING_JWK, ...environment } = value.environment;
  delete environment.ZENITH_TEMPORAL_ADDRESS; delete environment.ZENITH_TEMPORAL_NAMESPACE; delete environment.ZENITH_TEMPORAL_TLS;
  value.environment = { ...installationEnvironment({ mode: value.mode, apiPort: value.apiPort, images: value.images, environment }), ZENITH_SECRET_KEY, ZENITH_PLAN_ARTIFACT_KEY, ZENITH_CONTROL_SIGNING_JWK, ZENITH_OIDC_SIGNING_JWK };
  return value;
}
const fixture = parent();
interface Service { image:string; labels:Record<string,string>; volumes:string[]; ports?:string[]; env_file:{path:string;format:string}[]; read_only:boolean; mem_limit:string; environment?:Record<string,string>; }
interface Stack { services:Record<string,Service>; volumes:Record<string,{labels:Record<string,string>}>; networks:Record<string,{labels:Record<string,string>}>; }

describe('default stack pure configuration contracts', () => {
  it('joins issuer discovery and JWKS to the same TLS name reachable by API containers and the host', () => {
    expect(issuerBindings()).toEqual({ ZENITH_AGENT_OAUTH_ISSUER: issuer, ZENITH_AGENT_OAUTH_JWKS: `${issuer}/protocol/openid-connect/certs`, ZENITH_AGENT_OAUTH_CLIENT_CLAIM: 'azp', ZENITH_AGENT_OAUTH_SUBJECT_CLAIM: 'zenith_subject' });
    const join = fs.readFileSync('scripts/acceptance/default-stack/issuer.mjs', 'utf8');
    expect(join).toContain("aliases: ['issuer.zenith.localhost']");
    expect(join).toContain("identity.id !== subject || !identity.email_confirmed_at");
    expect(join).toContain("/api/agent/v3/mcp");
  });
  it('refuses resource headroom below the verifier floor and does not waive it for lean', () => {
    expect(() => assertHeadroom(minimumFreeBytes)).not.toThrow();
    expect(() => assertHeadroom(minimumFreeBytes - 1)).toThrow('disk-headroom');
    expect(() => assertHeadroom(Number.NaN)).toThrow('disk-headroom');
  });
  it('keeps original installer guards for the isolated TLS pooler and single authority', () => {
    expect(validateInput(fixture, true)).toBe(fixture);
    const unsafe = structuredClone(fixture); unsafe.environment.SUPABASE_DB_URL = unsafe.environment.SUPABASE_DB_URL.replace('verify-full', 'require');
    expect(() => validateInput(unsafe, true)).toThrow('SUPABASE_DB_URL');
    unsafe.environment.SUPABASE_DB_URL = fixture.environment.SUPABASE_DB_URL;
    unsafe.environment.ZENITH_PLATFORM_DB_URL = fixture.environment.SUPABASE_DB_URL.replace('supabase-pooler', 'foreign-pooler');
    unsafe.environment.ZENITH_PLATFORM_MIGRATION_URL = fixture.environment.SUPABASE_DB_URL;
    expect(() => validateInput(unsafe, true)).toThrow('platform-authority-is-product-database');
  });
  it('uses genuine Auth/PostgREST and transaction pooling, with protected schemas unexposed', () => {
    const text = supabaseConfig(`zenith-local-${id()}`);
    expect(text).toContain('default_pool_size = 15');
    expect(supabaseConfig(`zenith-local-${id()}`, 'lean')).toContain('default_pool_size = 5');
    expect(text).toContain('pool_mode = "transaction"'); expect(text).toContain('schemas = ["public", "graphql_public"]');
    expect(text).toContain('enabled = false\n[db.seed]'); expect(text).toContain('enable_confirmations = true');
    expect(text).toContain('[auth.email.smtp]\nenabled = true\nhost = "mailpit"\nport = 1025');
    expect(text).toMatch(/\[auth\.email\.smtp\][\s\S]*?user = "zenith-local-[a-f0-9]{24}"\npass = "env\(ZENITH_MAILPIT_SMTP_PASS\)"/);
    expect(text).toContain('[auth.mfa.totp]\nenroll_enabled = true\nverify_enabled = true');
    expect(text).not.toContain('schemas = ["platform"'); expect(text).not.toContain('password =');
    expect(() => supabaseConfig('zenith')).toThrow('project-identity');
  });
  it('renders SMTP auth only for a valid disposable installation identity and generated password', () => {
    const password = secret();
    expect(mailpitEnvironment('zenith-local-0123456789abcdef01234567', password)).toBe(
      `MP_DATABASE=/tmp/mailpit.db\nMP_SMTP_AUTH=zenith-local-0123456789abcdef01234567:${password}\nMP_SMTP_AUTH_ALLOW_INSECURE=true\n`,
    );
    expect(() => mailpitEnvironment('foreign-project', password)).toThrow('mailpit-smtp-identity');
    expect(() => mailpitEnvironment('zenith-local-0123456789abcdef01234567', 'short')).toThrow('mailpit-smtp-identity');
  });
  it('excludes the pinned CLI service names and keeps Mailpit credentials private and installation-scoped', () => {
    expect(excludedSupabaseServices.split(',')).toEqual([
      'mailpit', 'storage-api', 'imgproxy', 'realtime', 'studio', 'postgres-meta', 'logflare', 'vector', 'edge-runtime',
    ]);
    expect(excludedSupabaseServices).not.toContain('inbucket');
    expect(excludedSupabaseServices).not.toContain('pg-meta');
    const up = fs.readFileSync('scripts/acceptance/default-stack/up.mjs', 'utf8');
    expect(up).toContain('const smtpPassword = randomBytes(32).toString(\'hex\')');
    expect(up).toContain('const smtpEnv = Object.freeze({ ZENITH_MAILPIT_SMTP_PASS: smtpPassword })');
    expect(up).toContain('mailpitEnvironment(state.projectId, smtpPassword)');
    expect(up).toContain("'--env-file', mailpitEnvFile");
    expect(up.match(/env: smtpEnv/g)).toHaveLength(2);
    expect(up).not.toContain('smtp-auth-accept-any');
    expect(up).not.toContain("'-p', `127.0.0.1:${ports.mail}:1025`");
  });
  it.each(['default', 'lean'])('renders the %s topology with private CA mounts and independent scratch', profile => {
    const peer = joinedConfiguration(fixture, id());
    const stack = stackComposition({ ...fixture, supabaseKong: `supabase_kong_zenith-local-${id()}` }, '/private/installation', profile, fixture.images.api, peer) as Stack;
    expect(Object.keys(stack.services).filter(name => name.startsWith('api'))).toHaveLength(profile === 'lean' ? 1 : 2);
    expect(Object.keys(stack.services).filter(name => name.startsWith('execution-worker'))).toHaveLength(profile === 'lean' ? 1 : 2);
    expect(stack.services['platform-db']).toBeUndefined();
    expect(stack.volumes['platform-data']).toBeUndefined();
    const env = environmentsFor(fixture, '/private/installation');
    expect(env['platform.env']).toBeUndefined();
    for (const name of ['api.env', 'worker.env']) expect(env[name].ZENITH_PLATFORM_DB_URL).toBe(env[name].SUPABASE_DB_URL);
    expect(env['migration.env'].ZENITH_PLATFORM_DB_URL).toBe(fixture.environment.ZENITH_PLATFORM_MIGRATION_URL);
    for (const [name, service] of Object.entries(stack.services)) {
      expect(service.labels[installationLabel]).toBe(fixture.installationId);
      expect(service.image).toMatch(/@sha256:[a-f0-9]{64}$/);
      for (const port of service.ports ?? []) expect(port).toMatch(/^127\.0\.0\.1:/);
      if (['api', 'execution-worker', 'platform-migrate', 'api-peer', 'execution-worker-peer'].includes(name)) {
        expect(service.read_only).toBe(true);
        expect(service.environment?.NODE_EXTRA_CA_CERTS).toBe('/run/zenith-ca.crt');
        expect(service.volumes.some(volume => volume.endsWith(':/run/zenith-ca.crt:ro'))).toBe(true);
      }
    }
    for (const volume of Object.values(stack.volumes)) expect(volume.labels[installationLabel]).toBe(fixture.installationId);
    if (profile === 'default') {
      expect(stack.services['api-peer'].volumes[0]).toBe('api-peer-data:/data');
      expect(stack.services['execution-worker-peer'].volumes[0]).toBe(`worker-${peer.workerId}:/var/lib/zenith`);
      expect(stack.services['execution-worker-peer'].env_file[0].path).not.toBe(stack.services['execution-worker'].env_file[0].path);
    }
  });
  it('keeps lean limits bounded for the 4 GiB Docker profile without claiming measured fitness', () => {
    const sizing = topology('lean');
    expect(sizing.apis).toBe(1); expect(sizing.workers).toBe(1);
    const total = sizing.apiMiB + sizing.workerMiB + 384 + 256 + 64 + sizing.registryMiB + Object.values(sizing.supabaseMiB).reduce((a,b) => a+b, 0);
    expect(total).toBeLessThan(4096); expect(sizing.productionReady).toBe(false);
    expect(() => topology('tiny')).toThrow('profile');
  });
  it('refuses floating images and a missing independent worker', () => {
    expect(() => digestImage('registry:latest')).toThrow('image-digest');
    expect(() => stackComposition(fixture, '/private/installation', 'default', fixture.images.api, undefined)).toThrow('joined-worker');
  });
  it('requires the real-engine gate before invoking any engine or installer', () => {
    const result = spawnSync(process.execPath, [path.join(root, 'scripts/acceptance/default-stack/up.mjs'), '--directory', '/private/disposable'], { env: { ...process.env, ZENITH_ACCEPTANCE_DEFAULT_STACK: '0' }, encoding: 'utf8' });
    expect(result.status).toBe(77); expect(JSON.parse(result.stdout)).toMatchObject({ status: 'not-run', passed: 0, failed: 0, skipped: 1 });
    expect(result.stderr).toBe('');
  });
});
describe('shared worker keyring pure contracts', () => {
  it('shares the exact authority and all custody keys while naming independent scratch', () => {
    const peer = joinedConfiguration(fixture, id());
    expect(peer.environment).toEqual(fixture.environment); expect(peer.environment).not.toBe(fixture.environment);
    expect(peer.installationId).toBe(fixture.installationId); expect(peer.workerId).not.toBe(fixture.installationId);
    expect(planFor(peer).volumes).toEqual([`worker-${peer.workerId}`]); expect(planFor(peer).additionalWorkerPreparationSupported).toBe(true);
    expect(JSON.stringify(planFor(peer))).not.toContain(fixture.environment.ZENITH_PLAN_ARTIFACT_KEY);
  });
  it('refuses malformed IDs, duplicate scratch identity and chaining through a joined worker', () => {
    expect(() => joinedConfiguration(fixture, 'worker')).toThrow('worker-identity');
    expect(() => joinedConfiguration(fixture, fixture.installationId)).toThrow('worker-identity');
    expect(() => joinedConfiguration(joinedConfiguration(fixture, id()), id())).toThrow('worker-identity');
  });
  it('preserves the published composition and real readiness contracts', () => {
    const base = load(fs.readFileSync(path.join(root, 'deploy/self-hosted/compose.yml'), 'utf8')) as Stack;
    expect(base.services.api.volumes[0]).toBe('api-data:/data'); expect(base.services['execution-worker'].volumes[0]).toBe('worker-data:/var/lib/zenith');
  });
});
describe('ownership cleanup planning', () => {
  const installationId = id(), applicationInstallationId = id();
  const state = { installationId, applicationInstallationId, projectId: `zenith-local-${installationId}` };
  it('selects only owned resources, in dependency order, regardless of names', () => {
    const resources = [
      { kind: 'network', id: 'owned-network', labels: { [installationLabel]: installationId } },
      { kind: 'container', id: 'owned-container', labels: { [installationLabel]: applicationInstallationId } },
      { kind: 'volume', id: 'owned-volume', labels: { [projectLabel]: state.projectId } },
      { kind: 'container', id: 'zenith-foreign', labels: { [installationLabel]: id() } },
      { kind: 'volume', id: 'zenith-unlabelled', labels: {} },
    ];
    expect(cleanupPlan(resources, state)).toEqual([{ kind: 'container', id: 'owned-container' }, { kind: 'volume', id: 'owned-volume' }, { kind: 'network', id: 'owned-network' }]);
  });
  it('refuses conflicting custody and unsafe resource identifiers', () => {
    expect(() => cleanupPlan([{ kind: 'volume', id: 'conflict', labels: { [projectLabel]: state.projectId, [installationLabel]: id() } }], state)).toThrow('resource-identity');
    expect(() => cleanupPlan([{ kind: 'container', id: '--all', labels: { [installationLabel]: installationId } }], state)).toThrow('resource-identity');
    expect(() => cleanupPlan([], { ...state, projectId: 'foreign' })).toThrow('identity');
  });
  it('has an empty idempotent plan after complete absence readback', () => { expect(cleanupPlan([], state)).toEqual([]); });
});

describe('canonical API origin on declared peer transport', () => {
  it('probes the peer with the exact configured Host and preserves the MCP discovery origin', () => {
    const request = apiProbeRequest('http://127.0.0.1:36400', ports.peerApi, 'http://127.0.0.1:36400/api/agent/v3/mcp', { headers: { accept: 'application/json' }, redirect: 'error' as const });
    expect(request.url.href).toBe('http://127.0.0.1:36401/api/agent/v3/mcp');
    expect(request.options.headers.get('host')).toBe('127.0.0.1:36400');
    expect(request.options.headers.get('accept')).toBe('application/json');
    expect(request.options.redirect).toBe('error');
    expect(() => apiProbeRequest('http://127.0.0.1:36400', 35000, 'http://127.0.0.1:36400/api/me', {})).toThrow('api-probe-origin');
    expect(() => apiProbeRequest('http://127.0.0.1:36400', ports.peerApi, 'http://foreign.localhost/api/me', {})).toThrow('api-probe-origin');
  });
});

describe('isolated pooler readiness command', () => {
  it('provides bounded UID-owned temporary space without relaxing read-only TLS/authority probing', () => {
    const state = { applicationProjectName: 'zenith-owned', installationId: 'owned-installation', directory: '/private/owned' };
    const base = poolerProbeArguments(state, 'tls', 'localhost/migration@sha256:' + 'a'.repeat(64));
    const authority = poolerProbeArguments(state, 'authority', 'localhost/migration@sha256:' + 'a'.repeat(64));
    expect(base).toContain('--read-only');
    expect(base.slice(base.indexOf('--user') + 1, base.indexOf('--user') + 2)).toEqual(['1001:1001']);
    expect(base.slice(base.indexOf('--cap-drop') + 1, base.indexOf('--cap-drop') + 2)).toEqual(['ALL']);
    expect(base.slice(base.indexOf('--security-opt') + 1, base.indexOf('--security-opt') + 2)).toEqual(['no-new-privileges:true']);
    expect(base.slice(base.indexOf('--memory') + 1, base.indexOf('--memory') + 2)).toEqual(['192m']);
    expect(base.slice(base.indexOf('--tmpfs') + 1, base.indexOf('--tmpfs') + 2)).toEqual([
      '/tmp:rw,noexec,nosuid,nodev,size=16m,uid=1001,gid=1001,mode=1777',
    ]);
    expect(base).toContain('NODE_EXTRA_CA_CERTS=/run/zenith-ca.crt');
    expect(base.some(value => value.includes('target=/run/zenith-ca.crt,readonly'))).toBe(true);
    expect(base.slice(-1)).toEqual(['tls']);
    expect(authority.slice(-1)).toEqual(['authority']);
    expect(authority).toContain('/app/pooler-probe.mjs');
  });
});
