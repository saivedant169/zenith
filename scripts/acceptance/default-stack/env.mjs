import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPrepared, privateLocation, assertPrivate } from '../../deploy/installation.mjs';
import { readState, requireEngineGate, cli } from './runtime.mjs';
import { ports, fail } from './config.mjs';

/** Host paths of the installation's private Temporal client files (mTLS, server name temporal). */
export function hostTemporalTls(directory) {
  const tls = path.join(directory, 'installation/temporal-tls');
  return { ZENITH_TEMPORAL_TLS_CA_FILE: path.join(tls, 'ca.crt'), ZENITH_TEMPORAL_TLS_CERT_FILE: path.join(tls, 'client.crt'),
    ZENITH_TEMPORAL_TLS_KEY_FILE: path.join(tls, 'client.key'), ZENITH_TEMPORAL_TLS_SERVER_NAME: 'temporal' };
}

/** Export the actual prepared stack for host-side J2/J4/J15 commands. Never print secrets. */
export function hostEnvironment(state) {
  const config = readPrepared(path.join(state.directory, 'installation'));
  const environment = { ...config.environment, NODE_EXTRA_CA_CERTS: path.join(state.directory, 'tls/ca.crt') };
  const pooler = new URL(config.environment.SUPABASE_DB_URL);
  // The certificate has localhost in its SAN and J4 admits literal loopback hosts.
  pooler.hostname = 'localhost'; pooler.port = String(ports.pooler);
  environment.SUPABASE_DB_URL = environment.ZENITH_PLATFORM_DB_URL = pooler.href;
  // The lean stack publishes its own engine on an owned loopback port, never a host-wide 7233 another service may hold.
  environment.ZENITH_TEMPORAL_ADDRESS = `127.0.0.1:${ports.temporal}`;
  Object.assign(environment, hostTemporalTls(state.directory));
  environment.ZENITH_DEFAULT_STACK_DIRECTORY = state.directory;
  environment.ZENITH_LOCAL_STACK_DIRECTORY = state.directory;
  environment.ZENITH_J4_API_ORIGIN = config.environment.NEXT_PUBLIC_SITE_URL;
  environment.ZENITH_DEFAULT_MAILPIT_URL = state.mailpitUrl;
  return environment;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void cli(async () => {
  requireEngineGate();
  const [directory, file, ...extra] = process.argv.slice(2);
  if (!directory || !file || extra.length) fail('env-usage');
  const destination = privateLocation(file); assertPrivate(path.dirname(destination), true);
  const environment = hostEnvironment(readState(directory));
  if (Object.values(environment).some(value => typeof value !== 'string' || /[\r\n\0]/.test(value))) fail('env-value');
  fs.writeFileSync(destination, Object.entries(environment).map(([key,value]) => `${key}=${value}`).join('\n') + '\n', { mode: 0o600, flag: 'wx' });
  process.stdout.write('Private host environment written.\n');
});
