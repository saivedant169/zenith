import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { prepare, validateInput, installationEnvironment, assertPreparedVersion, environmentsFor } from '../../scripts/deploy/installation.mjs';

type Input = Parameters<typeof prepare>[0];
const runtimeSecret = () => randomBytes(32).toString('hex');
const image = (name: string) => `zenith-unit/${name}@sha256:${runtimeSecret()}`;
function input(mode: Input['mode'] = 'production'): Input {
  return {
    mode, apiPort: 36400, images: { api: image('api'), worker: image('worker'), migration: image('migration') },
    environment: {
      NEXT_PUBLIC_SITE_URL: mode === 'production' ? 'https://zenith.unit.invalid' : 'http://127.0.0.1:36400',
      SUPABASE_URL: mode === 'production' ? 'https://abcdefghijklmnopqrst.supabase.co' : 'https://supabase.localhost:54321', NEXT_PUBLIC_SUPABASE_URL: mode === 'production' ? 'https://abcdefghijklmnopqrst.supabase.co' : 'https://supabase.localhost:54321',
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: runtimeSecret(), SUPABASE_SERVICE_ROLE_KEY: runtimeSecret(),
      SUPABASE_DB_URL: `postgresql://${mode === 'production' ? 'postgres.abcdefghijklmnopqrst' : 'postgres.pooler-dev'}:${runtimeSecret()}@${mode === 'production' ? 'aws-0-unit.pooler.supabase.com' : 'supabase-pooler'}:6543/postgres?sslmode=verify-full`,
      ...(mode === 'production' ? {
        ZENITH_PLATFORM_MIGRATION_URL: `postgresql://postgres:${runtimeSecret()}@db.abcdefghijklmnopqrst.supabase.co:5432/postgres?sslmode=verify-full`,
        ZENITH_TEMPORAL_ADDRESS: 'temporal.unit.invalid:7233', ZENITH_TEMPORAL_NAMESPACE: 'zenith-unit',
        ZENITH_TEMPORAL_TLS: 'true', ZENITH_TEMPORAL_API_KEY: runtimeSecret(),
      } : {}),
    },
  };
}
describe('supported installation structural preflight', () => {
  it('requires one durable Supabase database and authenticated Temporal inputs', () => {
    expect(validateInput(input()).mode).toBe('production');
  });
  const badInputs: { id: string; change: (value: Input) => void; failure: string }[] = [
    { id: 'public auth absent', change: v => { delete v.environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY; }, failure: 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY' },
    { id: 'service auth absent', change: v => { delete v.environment.SUPABASE_SERVICE_ROLE_KEY; }, failure: 'SUPABASE_SERVICE_ROLE_KEY' },
    { id: 'public auth mismatch', change: v => { v.environment.NEXT_PUBLIC_SUPABASE_URL = 'https://other.unit.invalid'; }, failure: 'NEXT_PUBLIC_SUPABASE_URL' },
    { id: 'placeholder', change: v => { v.environment.SUPABASE_SERVICE_ROLE_KEY = '<replace me>'; }, failure: 'SUPABASE_SERVICE_ROLE_KEY' },
    { id: 'non-TLS public origin', change: v => { v.environment.NEXT_PUBLIC_SITE_URL = 'http://127.0.0.1:36400'; }, failure: 'NEXT_PUBLIC_SITE_URL' },
    { id: 'nonverifying pooler TLS', change: v => { v.environment.SUPABASE_DB_URL = v.environment.SUPABASE_DB_URL.replace('verify-full', 'require'); }, failure: 'SUPABASE_DB_URL' },
    { id: 'wrong pooler mode', change: v => { v.environment.SUPABASE_DB_URL = v.environment.SUPABASE_DB_URL.replace('6543', '5432'); }, failure: 'transaction-pooler' },
    { id: 'TLS override parameter', change: v => { v.environment.SUPABASE_DB_URL += '&ssl=false'; }, failure: 'SUPABASE_DB_URL' },
    { id: 'nonverifying platform TLS', change: v => { v.environment.ZENITH_PLATFORM_DB_URL = v.environment.SUPABASE_DB_URL.replace('verify-full', 'require'); }, failure: 'platform-authority-is-product-database' },
    { id: 'separate database authority', change: v => { v.environment.ZENITH_PLATFORM_DB_URL = v.environment.SUPABASE_DB_URL.replace('aws-0-unit', 'aws-1-unit'); }, failure: 'platform-authority-is-product-database' },
    { id: 'different migration authority', change: v => { v.environment.ZENITH_PLATFORM_MIGRATION_URL = v.environment.ZENITH_PLATFORM_MIGRATION_URL.replace('/postgres?', '/other?'); }, failure: 'platform-migration-authority' },
    { id: 'file backend override', change: v => { v.environment.ZENITH_STORE = 'file'; }, failure: 'unknown-environment-field' },
    { id: 'PGlite platform', change: v => { v.environment.ZENITH_PLATFORM_DB_URL = 'file:///private/platform'; }, failure: 'platform-authority-is-product-database' },
    { id: 'Temporal auth absent', change: v => { delete v.environment.ZENITH_TEMPORAL_API_KEY; }, failure: 'ZENITH_TEMPORAL_API_KEY' },
    { id: 'Temporal TLS disabled', change: v => { v.environment.ZENITH_TEMPORAL_TLS = 'false'; }, failure: 'ZENITH_TEMPORAL_TLS' },
    { id: 'unpaired OAuth config', change: v => { v.environment.ZENITH_AGENT_OAUTH_ISSUER = 'https://oauth.unit.invalid'; }, failure: 'ZENITH_AGENT_OAUTH_JWKS' },
    { id: 'malformed plugin publisher trust', change: v => { v.environment.ZENITH_PLUGIN_TRUSTED_PUBLISHERS = '{"acme":[{"keyId":"k1","publicKey":"c2hvcnQ="}]}'; }, failure: 'ZENITH_PLUGIN_TRUSTED_PUBLISHERS' },
    { id: 'non-canonical plugin publisher key', change: v => { v.environment.ZENITH_PLUGIN_TRUSTED_PUBLISHERS = JSON.stringify({ acme: [{ keyId: 'k1', publicKey: randomBytes(32).toString('base64').replace(/=$/, '') }] }); }, failure: 'ZENITH_PLUGIN_TRUSTED_PUBLISHERS' },
    { id: 'non-JSON plugin publisher trust', change: v => { v.environment.ZENITH_PLUGIN_TRUSTED_PUBLISHERS = 'acme=k1'; }, failure: 'ZENITH_PLUGIN_TRUSTED_PUBLISHERS' },
    { id: 'floating image', change: v => { v.images.worker = 'zenith/worker:latest'; }, failure: 'images.worker' },
    { id: 'out-of-range port', change: v => { v.apiPort = 80; }, failure: 'apiPort' },
  ];
  it.each(badInputs)('rejects $id without exposing values', ({ change, failure }) => {
    const value = input(); change(value);
    expect(() => validateInput(value)).toThrow(failure);
    try { validateInput(value); } catch (error) {
      expect(String(error)).not.toContain(value.environment.SUPABASE_DB_URL);
      expect(String(error)).not.toContain(value.environment.SUPABASE_SERVICE_ROLE_KEY ?? runtimeSecret());
    }
  });
  const databaseTlsCases = ['SUPABASE_DB_URL', 'ZENITH_PLATFORM_DB_URL', 'ZENITH_PLATFORM_MIGRATION_URL'].flatMap(field => [
    'sslmode=verify-full&sslmode=require',
    'sslmode=require&sslmode=verify-full',
    'sslmode=verify-full&sslmode=verify-full',
    'sslmode=verify-full&%73slmode=require',
    '%73slmode=require&sslmode=verify-full',
    'sslmode=require',
    'sslmode=prefer',
    '',
  ].map(query => ({ field, query })));
  it.each(databaseTlsCases)('rejects ambiguous or weaker TLS on $field: $query', ({ field, query }) => {
    const value = input();
    const parsed = new URL(value.environment[field] ?? value.environment.SUPABASE_DB_URL);
    parsed.search = query;
    value.environment[field] = parsed.href;
    expect(() => validateInput(value)).toThrow(field === 'ZENITH_PLATFORM_DB_URL' ? 'platform-authority-is-product-database' : field);
  });

});

describe('single Supabase installation authority', () => {
  it.each(['production', 'disposable'] as const)('derives the exact product URL in %s without mutating the input', mode => {
    const value = input(mode), before = structuredClone(value);
    const env = installationEnvironment(value);
    expect(value).toEqual(before); expect(env.ZENITH_PLATFORM_DB_URL).toBe(value.environment.SUPABASE_DB_URL);
    if (mode === 'disposable') {
      const direct = new URL(env.ZENITH_PLATFORM_MIGRATION_URL);
      expect(direct.host).toBe('supabase-db:5432'); expect(direct.pathname).toBe('/postgres');
      expect(direct.username).toBe('postgres'); expect(direct.password).toBe(new URL(env.SUPABASE_DB_URL).password);
    }
    value.environment.ZENITH_PLATFORM_DB_URL = value.environment.SUPABASE_DB_URL;
    expect(() => validateInput(value)).not.toThrow();
  });
  it.each(['hostname', 'port', 'pathname', 'username', 'password', 'search'] as const)('refuses a platform URL differing in %s', field => {
    const value = input(), changed = new URL(value.environment.SUPABASE_DB_URL);
    changed[field] = { hostname: 'foreign.pooler.supabase.com', port: '5432', pathname: '/other', username: 'other', password: runtimeSecret(), search: '?sslmode=require' }[field];
    value.environment.ZENITH_PLATFORM_DB_URL = changed.href;
    expect(() => validateInput(value)).toThrow('platform-authority-is-product-database');
  });
  it.each(['direct', 'session'] as const)('accepts a same-project %s migration endpoint', mode => {
    const value = input();
    if (mode === 'session') value.environment.ZENITH_PLATFORM_MIGRATION_URL = value.environment.SUPABASE_DB_URL.replace(':6543/', ':5432/');
    expect(() => validateInput(value)).not.toThrow();
  });
  it.each(['host', 'user', 'port', 'database'])('rejects a wrong-project or non-direct migration %s', field => {
    const value = input(), changed = new URL(value.environment.ZENITH_PLATFORM_MIGRATION_URL);
    if (field === 'host') changed.hostname = 'db.uvwxyzabcdefghijklmn.supabase.co';
    if (field === 'user') { changed.hostname = 'aws-0-unit.pooler.supabase.com'; changed.username = 'postgres.uvwxyzabcdefghijklmn'; }
    if (field === 'port') changed.port = '6543';
    if (field === 'database') changed.pathname = '/other';
    value.environment.ZENITH_PLATFORM_MIGRATION_URL = changed.href;
    expect(() => validateInput(value)).toThrow('platform-migration-authority');
  });
  it('requires a v1 directory to be re-prepared without a data copy', () => {
    expect(() => assertPreparedVersion({ schemaVersion: 1 })).toThrow('schema-v1-reprepare-required-no-data-copy');
    expect(() => assertPreparedVersion({ schemaVersion: 2 })).not.toThrow();
    expect(() => assertPreparedVersion({ schemaVersion: 3 })).toThrow('installation-identity');
  });
  it('keeps disposable Temporal overrides and unknown fields refused', () => {
    const value = input('disposable'); value.environment.ZENITH_TEMPORAL_ADDRESS = 'remote.unit.invalid:7233';
    expect(() => validateInput(value)).toThrow('disposable-engine-overrides');
    const unknown = { ...input(), registryPassword: runtimeSecret() };
    expect(() => validateInput(unknown)).toThrow('unknown-installation-field');
  });
});

describe('plugin publisher trust', () => {
  it('reaches the web app only, as the public verify keys the operator supplied', () => {
    const value = input();
    const publishers = JSON.stringify({ acme: [{ keyId: 'k1', publicKey: randomBytes(32).toString('base64') }] });
    value.environment.ZENITH_PLUGIN_TRUSTED_PUBLISHERS = publishers;
    expect(validateInput(value).mode).toBe('production');
    const config = { ...value, environment: installationEnvironment(value), schemaVersion: 2, installationId: 'a'.repeat(24), projectName: 'zenith-unit', source: { head: 'h', contentSha256: 'c', dirty: false } } as Parameters<typeof environmentsFor>[0];
    const files = environmentsFor(config, '/private/unit');
    expect(files['api.env'].ZENITH_PLUGIN_TRUSTED_PUBLISHERS).toBe(publishers);
    expect(files['worker.env'].ZENITH_PLUGIN_TRUSTED_PUBLISHERS).toBeUndefined();
    expect(files['migration.env'].ZENITH_PLUGIN_TRUSTED_PUBLISHERS).toBeUndefined();
  });
});
