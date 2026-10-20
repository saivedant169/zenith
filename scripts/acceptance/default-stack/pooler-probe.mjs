// Runs inside the real migration image. Contract tests never pretend this ran.
import postgres from 'postgres';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
const url = process.env.SUPABASE_DB_URL;
const parsed = new URL(url);
assert.equal(parsed.hostname, 'supabase-pooler'); assert.equal(parsed.port, '6543');
assert.equal(parsed.search, '?sslmode=verify-full');
assert.equal(process.env.ZENITH_PLATFORM_DB_URL, url, 'platform authority must be the product database');
// stdout carries only the JSON receipt; server notices (drop ... cascade) go to stderr.
const options = { prepare: false, max: 1, connect_timeout: 5, idle_timeout: 1, onnotice: notice => process.stderr.write(`${notice.severity}: ${notice.message}\n`) };
const open = extra => postgres(url, { ...options, ...extra });
const primary = open({});
try {
  const [row] = await primary`select current_database() as database,current_user as role`;
  assert.equal(row.database, 'postgres'); assert.equal(row.role, 'postgres');
  for (const ssl of [{ ca: [], rejectUnauthorized: true }, { ca: fs.readFileSync('/run/zenith-ca.crt'), servername: 'wrong.invalid', rejectUnauthorized: true }]) {
    const negative = open({ ssl });
    try {
      await assert.rejects(negative`select 1`, error => ['SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID'].includes(error.code));
    } finally { await negative.end({ timeout: 1 }); }
  }
  if (process.argv[2] === 'authority') {
    const { openPlatformDb } = await import('/app/src/lib/controlplane/db/open.ts');
    const { PLATFORM_MIGRATIONS } = await import('/app/src/lib/controlplane/db/migrations/index.ts');
    const highestRegisteredVersion = Math.max(...PLATFORM_MIGRATIONS.map(migration => migration.version));
    const platform = await openPlatformDb({ kind: 'postgres', url: process.env.ZENITH_PLATFORM_DB_URL, max: 1, migrate: false });
    try {
      const identity = 'select current_database() as database,current_user as role,(pg_control_system()).system_identifier::text as system_identifier';
      const [productIdentity] = await primary.unsafe(identity), [platformIdentity] = await platform.query(identity);
      assert.equal(platformIdentity.database, productIdentity.database);
      assert.equal(platformIdentity.role, 'postgres');
      assert.ok(productIdentity.system_identifier);
      assert.equal(platformIdentity.system_identifier, productIdentity.system_identifier);
      const [ledger] = await platform.query('select max(version) as version from platform.schema_migrations');
      assert.equal(ledger.version, highestRegisteredVersion);
      const [permissions] = await primary`select bool_and(not has_schema_privilege(role,schema,'usage')) as refused
        from (values ('anon'),('authenticated')) roles(role) cross join (values ('platform'),('agent')) schemas(schema)`;
      assert.equal(permissions.refused, true);
      const [rls] = await primary`select count(*)::integer as tables, bool_and(c.relrowsecurity) as enabled
        from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='platform' and c.relkind in ('r','p')`;
      assert.ok(rls.tables > 0); assert.equal(rls.enabled, true);
      process.stdout.write(JSON.stringify({ verifiedTls: true, wrongCaRefused: true, wrongHostnameRefused: true,
        sameDatabase: true, sameSystemIdentifier: true, database: productIdentity.database,
        systemIdentifier: productIdentity.system_identifier, maxMigrationVersion: ledger.version, highestRegisteredVersion,
        privateSchemaUsageRefused: true, platformTablesRlsEnabled: true, platformTableCount: rls.tables }));
    } finally { await platform.close(); }
  } else if (process.argv[2] === 'concurrency') {
    const schema = `zenith_acceptance_${randomBytes(12).toString('hex')}`;
    const peers = Array.from({ length: 8 }, () => open({}));
    try {
      await primary.unsafe(`create schema ${schema}`);
      await primary.unsafe(`create table ${schema}.counter(id integer primary key,value integer not null); insert into ${schema}.counter values(1,0)`);
      await Promise.all(peers.map(peer => peer.begin(async tx => {
        await tx.unsafe(`update ${schema}.counter set value=value+1 where id=1`);
      })));
      const [result] = await primary.unsafe(`select value from ${schema}.counter where id=1`); assert.equal(result.value, 8);
      process.stdout.write(JSON.stringify({ verifiedTls: true, wrongCaRefused: true, wrongHostnameRefused: true, concurrentTransactions: 8, finalValue: 8 }));
    } finally { await Promise.all(peers.map(peer => peer.end({ timeout: 1 }))); await primary.unsafe(`drop schema if exists ${schema} cascade`); }
  } else process.stdout.write(JSON.stringify({ verifiedTls: true, wrongCaRefused: true, wrongHostnameRefused: true }));
} finally { await primary.end({ timeout: 1 }); }
