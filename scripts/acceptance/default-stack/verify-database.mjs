import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { cli, requireEngineGate, docker, readState, save } from './runtime.mjs';
import { supabaseRequest, poolerProbe, readiness } from './readiness.mjs';
import { readPrepared } from '../../deploy/installation.mjs';
import { root, fail } from './config.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const psql = (container, database, sql) => docker(['exec', '-i', container, 'psql', '-X', '-U', 'postgres', '-d', database, '-v', 'ON_ERROR_STOP=1', '-At'], { input: sql, id: 'database-contract' });

/** Database recovery in a fresh owned DB on the same real engine. Clean-host
 * recovery and production backup policy remain the Wave-5 OPS-04 owner's join.
 */
async function recovery(state, container, original, prefix) {
  const database = `zenith_restore_${randomBytes(12).toString('hex')}`;
  const marker = randomBytes(32).toString('hex');
  const schema = `zenith_probe_${randomBytes(12).toString('hex')}`;
  let restored = false;
  try {
    await psql(container, original, `create schema ${schema}; create table ${schema}.marker(value text primary key); insert into ${schema}.marker values('${marker}');`);
    // The product authority schemas with their actual table ACL/RLS, migration ledgers and rows. Supabase-managed
    // schemas (auth, storage, vault, graphql) need supabase_admin and their own tooling, so a whole-database plain
    // restore by postgres is refused; they are outside this rehearsal, and these schemas reference none of them.
    const dump = await docker(['exec', container, 'pg_dump', '-U', 'postgres', '-d', original, '--format=plain',
      ...['public', 'platform', 'agent', 'hosted', schema].map(name => `--schema=${name}`)], { id: 'database-dump' });
    const backup = path.join(state.directory, `${prefix}.backup.sql`);
    fs.writeFileSync(backup, dump, { mode: 0o600, flag: 'wx' });
    await psql(container, 'postgres', `create database ${database} template template0;`); restored = true;
    // The dump recreates public with its real grants; supabase_admin's own defaults are set by the image, not by postgres.
    await psql(container, database, 'drop schema public;');
    const managed = /^ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public (?:GRANT|REVOKE) [^\n]*;$/gm;
    const managedDefaultPrivilegesSkipped = (dump.match(managed) ?? []).length;
    await psql(container, database, dump.replace(managed, ''));
    const readback = await psql(container, database, `select value from ${schema}.marker;`);
    if (readback !== marker) fail('restore-readback');
    const ledger = `select version,name,checksum from platform.schema_migrations order by version;`;
    if (await psql(container, original, ledger) !== await psql(container, database, ledger)) fail('restore-ledger');
    // Compare current schemas' table ACLs and RLS settings, rather than asserting
    // that pg_restore's success implies an authorization-preserving restore.
    const security = "select n.nspname,c.relname,c.relrowsecurity,c.relforcerowsecurity,coalesce(c.relacl::text,'') from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','platform','agent','hosted') and c.relkind='r' order by 1,2;";
    if (await psql(container, original, security) !== await psql(container, database, security)) fail('restore-authorization');
    return { restored: true, markerReadback: true, ledgerPreserved: true, authorizationPreserved: true, backupSha256: hash(dump), managedDefaultPrivilegesSkipped, cleanHost: false };
  } finally {
    if (restored) await psql(container, 'postgres', `drop database ${database} with (force);`);
    await psql(container, original, `drop schema if exists ${schema} cascade;`);
  }
}

export async function verifyDatabase(state) {
  requireEngineGate(); await readiness(state);
  const config = readPrepared(path.join(state.directory, 'installation'));
  const product = `supabase_db_${state.projectId}`;
  const authority = await poolerProbe(state, 'authority');
  const publicHeaders = { apikey: config.environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY };
  const checks = {};
  for (const schema of ['platform', 'agent']) {
    const response = await supabaseRequest(state, '/rest/v1/', { ...publicHeaders, 'accept-profile': schema });
    const body = JSON.parse(response.body);
    checks[`postgrest-${schema}-not-exposed`] = response.status === 406 && body.code === 'PGRST106';
  }
  const id = `acceptance-${randomBytes(12).toString('hex')}`;
  try {
    await psql(product, 'postgres', `insert into public.workspaces(id,workspace_id,slug,name,data) values('${id}','${id}','${id}','Disposable acceptance','{}');`);
    const endpoint = `/rest/v1/workspaces?id=eq.${id}&select=id`;
    const serviceKey = config.environment.SUPABASE_SERVICE_ROLE_KEY;
    const publicResult = await supabaseRequest(state, endpoint, publicHeaders);
    const serviceResult = await supabaseRequest(state, endpoint, { apikey: serviceKey, authorization: `Bearer ${serviceKey}` });
    checks['postgrest-anon-denied'] = publicResult.status === 200 && JSON.stringify(JSON.parse(publicResult.body)) === '[]'
      || publicResult.status === 401 || publicResult.status === 403;
    checks['postgrest-service-row-readback'] = serviceResult.status === 200 && JSON.parse(serviceResult.body).length === 1 && JSON.parse(serviceResult.body)[0].id === id;
  } finally { await psql(product, 'postgres', `delete from public.workspaces where id='${id}' and workspace_id='${id}';`); }
  // Genuine Supabase roles and native privileges. No stand-in role creation.
  const permissions = await psql(product, 'postgres', `select bool_and(not has_schema_privilege(role,schema,'usage')) from (values ('anon'),('authenticated')) roles(role) cross join (values ('platform'),('agent')) schemas(schema);`);
  checks['native-role-boundary'] = permissions === 't';
  checks['single-database-authority'] = authority.sameDatabase === true && authority.sameSystemIdentifier === true;
  checks['platform-schema-version'] = authority.maxMigrationVersion === authority.highestRegisteredVersion;
  checks['platform-tables-rls'] = authority.platformTablesRlsEnabled === true && authority.platformTableCount > 0;
  const concurrency = await poolerProbe(state, 'concurrency');
  checks['tls-pooler-concurrency'] = concurrency.concurrentTransactions === 8 && concurrency.finalValue === 8;
  const migrations = fs.readdirSync(path.join(root, 'supabase/migrations')).filter(file => /^\d+.*\.sql$/.test(file)).sort();
  // Reapplication proves the actual immutable snapshots' idempotent path.
  for (const file of migrations) await psql(product, 'postgres', fs.readFileSync(path.join(root, 'supabase/migrations', file), 'utf8'));
  checks['supabase-migration-reapply'] = true;
  const authorityRecovery = await recovery(state, product, 'postgres', 'authority');
  checks['single-authority-backup-restore'] = authorityRecovery.restored;
  const receipt = { schemaVersion: 1, kind: 'local_engine', source: state.source, architecture: state.architecture, profile: state.profile,
    checks, migrations: migrations.map(file => ({ file, sha256: hash(fs.readFileSync(path.join(root, 'supabase/migrations', file))) })),
    authority, authorityRecovery, passed: Object.values(checks).filter(Boolean).length, failed: Object.values(checks).filter(value => !value).length, skipped: 0,
    hostedProductionAcceptance: false, crossWorkerExecution: false, cleanHostRecovery: false, productionReady: false };
  save(path.join(state.directory, 'database.receipt.json'), receipt);
  if (receipt.failed) fail('database-acceptance');
  return receipt;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await cli(async () => {
  if (process.argv.length !== 3) fail('usage');
  process.stdout.write(`${JSON.stringify(await verifyDatabase(readState(process.argv[2])))}\n`);
});
