import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { installationEnvironment, environmentsFor } from '../../scripts/deploy/installation.mjs';
import { mcpCompositionFromEnv } from '@/lib/controlplane/db/repos/workflow-start-deploy-authority';
import { mcpProductEndpoint } from '@/lib/controlplane/db/repos/mcp-product-endpoint';
const ref = 'abcdefghijklmnopqrst';
const database = (host: string, user = `postgres.${ref}`) => new URL(`postgresql://${user}:${randomBytes(32).toString('hex')}@${host}:6543/postgres?sslmode=verify-full`);
describe('MCP project and database endpoint admission', () => {
  it('admits an exact twenty-character hosted project and its matching pooler realm', () => {
    expect(mcpProductEndpoint(new URL(`https://${ref}.supabase.co`), database('aws-0-unit.pooler.supabase.com'))).toBe(true);
    expect(mcpProductEndpoint(new URL(`https://${ref}.supabase.co`), database(`db.${ref}.supabase.co`, 'postgres'))).toBe(true);
  });
  it.each([ref.slice(1), ref + 'u'])('does not relax hosted project reference validation for %s', wrong => {
    expect(mcpProductEndpoint(new URL(`https://${wrong}.supabase.co`), database('aws-0-unit.pooler.supabase.com', `postgres.${wrong}`))).toBe(false);
  });
  it('admits the exact local CLI TLS pooler endpoint without impersonating a hosted project', () => {
    expect(mcpProductEndpoint(new URL('https://supabase.localhost:54321'), database('supabase-pooler', 'postgres.pooler-dev'))).toBe(true);
  });
  it.each(['https://supabase.localhost:55321', 'https://supabase.localhost:64321'])('admits the whole-thousand default-stack shift %s', origin => {
    expect(mcpProductEndpoint(new URL(origin), database('supabase-pooler', 'postgres.pooler-dev'))).toBe(true);
  });
  it.each(['https://supabase.localhost:54322', 'https://supabase.localhost:55322', 'https://supabase.localhost:54821', 'https://supabase.localhost:65321', 'https://supabase.localhost:44321', 'https://supabase.localhost', 'http://supabase.localhost:54321', 'https://foreign.localhost:54321', 'https://supabase.localhost:54321/path'])('refuses an unbound local origin %s', origin => {
    expect(mcpProductEndpoint(new URL(origin), database('supabase-pooler', 'postgres.pooler-dev'))).toBe(false);
  });
  it('refuses mismatched project realms and a separate platform database', () => {
    expect(mcpProductEndpoint(new URL(`https://${ref}.supabase.co`), database('aws-0-unit.pooler.supabase.com', 'postgres.uvwxyzabcdefghijklmn'))).toBe(false);
    expect(mcpProductEndpoint(new URL('https://supabase.localhost:54321'), database('platform-db', 'postgres'))).toBe(false);
  });
  it.each(['sslmode=require', 'sslmode=verify-full&sslmode=require', 'ssl=false', ''])('refuses weaker or ambiguous local TLS: %s', query => {
    const value = database('supabase-pooler', 'postgres.pooler-dev'); value.search = query;
    expect(mcpProductEndpoint(new URL('https://supabase.localhost:54321'), value)).toBe(false);
  });
});

describe('installer to MCP single-database composition contract', () => {
  const secret = () => randomBytes(32).toString('hex');
  function fixture(mode: 'production' | 'disposable') {
    const hosted = mode === 'production';
    const origin = hosted ? 'https://' + ref + '.supabase.co' : 'https://supabase.localhost:54321';
    const product = database(hosted ? 'aws-0-unit.pooler.supabase.com' : 'supabase-pooler', hosted ? 'postgres.' + ref : 'postgres.pooler-dev').href;
    const input: Parameters<typeof installationEnvironment>[0] = { mode, apiPort: 36400, images: { api: 'unit/api@sha256:' + secret(), worker: 'unit/worker@sha256:' + secret(), migration: 'unit/migration@sha256:' + secret() },
      environment: { NEXT_PUBLIC_SITE_URL: hosted ? 'https://zenith.unit.invalid' : 'http://127.0.0.1:36400',
        SUPABASE_URL: origin, NEXT_PUBLIC_SUPABASE_URL: origin, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: secret(), SUPABASE_SERVICE_ROLE_KEY: secret(), SUPABASE_DB_URL: product,
        ...(hosted ? { ZENITH_PLATFORM_MIGRATION_URL: 'postgresql://postgres:' + secret() + '@db.' + ref + '.supabase.co:5432/postgres?sslmode=verify-full',
          ZENITH_TEMPORAL_ADDRESS: 'temporal.unit.invalid:7233', ZENITH_TEMPORAL_NAMESPACE: 'unit', ZENITH_TEMPORAL_TLS: 'true', ZENITH_TEMPORAL_API_KEY: secret() } : {}) } };
    const installationId = randomBytes(12).toString('hex');
    return { ...input, schemaVersion: 2 as const, installationId, projectName: 'zenith-' + installationId,
      source: { head: randomBytes(20).toString('hex'), contentSha256: secret(), dirty: false },
      environment: { ...installationEnvironment(input), ZENITH_SECRET_KEY: secret(), ZENITH_PLAN_ARTIFACT_KEY: secret() } };
  }
  it.each(['production', 'disposable'] as const)('the %s installer generates API and worker environments accepted by the unchanged predicate', mode => {
    const config = fixture(mode), generated = environmentsFor(config, '/private/unit');
    for (const name of ['api.env', 'worker.env']) {
      const env = generated[name], composition = mcpCompositionFromEnv(env);
      expect(env.ZENITH_PLATFORM_DB_URL).toBe(env.SUPABASE_DB_URL);
      expect(composition.selected.href).toBe(new URL(env.SUPABASE_DB_URL).href);
      expect(composition.api.origin).toBe(env.NEXT_PUBLIC_SUPABASE_URL);
    }
    expect(generated['platform.env']).toBeUndefined();
  });
  it.each(['production', 'disposable'] as const)('the old separate-server %s configuration is refused', mode => {
    const env = environmentsFor(fixture(mode), '/private/unit')['api.env'];
    env.ZENITH_PLATFORM_DB_URL = 'postgresql://postgres:' + secret() + '@platform-db:5432/zenith_platform';
    expect(() => mcpCompositionFromEnv(env)).toThrow('Native current MCP deployment authority');
  });
  it.each(['port', 'pathname', 'username', 'search'] as const)('preserves endpoint mismatch refusal for %s', field => {
    const env = environmentsFor(fixture('production'), '/private/unit')['api.env'];
    const changed = new URL(env.ZENITH_PLATFORM_DB_URL);
    changed[field] = { port: '5432', pathname: '/other', username: 'other', search: '?sslmode=require' }[field];
    env.ZENITH_PLATFORM_DB_URL = changed.href;
    expect(() => mcpCompositionFromEnv(env)).toThrow('Native current MCP deployment authority');
  });
});
