/**
 * Native Linux acceptance for `installation.mjs stage-linux-binds`.
 *
 * Prepares a disposable installation from throwaway inputs and starts only its
 * own mTLS Temporal service through the installer's Compose argv: first without
 * the per-uid copies (expected to fail: uid 1000 cannot read the operator's 0600
 * key), then after staging (expected healthy). Removes only its own project.
 *
 * Usage: ZENITH_ACCEPTANCE_LINUX_INSTALLER=1 node scripts/acceptance/linux-installer-binds.mjs <new-private-dir>
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { composeArgs, composeEnvironment, prepare, readPrepared, stageLinuxBinds, LINUX_BINDS_FILE } from '../deploy/installation.mjs';

const fail = id => { throw new Error(`linux-installer:${id}`); };
if (process.env.ZENITH_ACCEPTANCE_LINUX_INSTALLER !== '1') fail('gate');
if (process.platform !== 'linux') fail('native-linux-required');
const directory = process.argv[2];
if (!directory || process.argv.length !== 3 || fs.existsSync(directory)) fail('usage');

const secret = () => randomBytes(32).toString('hex');
const image = name => `zenith-linux-installer/${name}@sha256:${secret()}`;
const config = prepare({
  mode: 'disposable', apiPort: 36400, images: { api: image('api'), worker: image('worker'), migration: image('migration') },
  environment: {
    NEXT_PUBLIC_SITE_URL: 'http://127.0.0.1:36400', SUPABASE_URL: 'https://supabase.localhost:54321', NEXT_PUBLIC_SUPABASE_URL: 'https://supabase.localhost:54321',
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: secret(), SUPABASE_SERVICE_ROLE_KEY: secret(),
    SUPABASE_DB_URL: `postgresql://postgres.pooler-dev:${secret()}@supabase-pooler:6543/postgres?sslmode=verify-full`,
  },
}, directory);
const compose = (args, timeout = 240_000) => spawnSync('docker', [...composeArgs(readPrepared(directory), directory), ...args],
  { env: composeEnvironment(), stdio: 'ignore', timeout }).status;
const result = { schemaVersion: 1, kind: 'linux-installer-private-binds', mode: config.mode, productionReady: false };
try {
  result.withoutStaging = compose(['up', '-d', '--wait', '--wait-timeout', '60', 'temporal']) === 0 ? 'healthy' : 'refused';
  compose(['rm', '-sf', 'temporal']);
  result.staging = stageLinuxBinds(config, directory);
  result.overridePresent = fs.existsSync(path.join(directory, LINUX_BINDS_FILE));
  result.withStaging = compose(['up', '-d', '--wait', '--wait-timeout', '120', 'temporal']) === 0 ? 'healthy' : 'refused';
  result.originalKeyMode = (fs.statSync(path.join(directory, 'temporal-tls/server.key')).mode & 0o777).toString(8);
} finally {
  result.cleanupExit = compose(['down', '-v', '--remove-orphans']);
}
process.stdout.write(`${JSON.stringify(result)}\n`);
if (result.withoutStaging !== 'refused' || result.withStaging !== 'healthy' || !result.overridePresent || result.originalKeyMode !== '600' || result.cleanupExit !== 0) process.exitCode = 1;
