// DRV-3 upgrade candidates (docs/build/production/verify/DRV-3.md): rebuild api, worker and
// migration from this source with distinct rehearsal labels, push them to the stack's owned
// registry and write the strict private ZENITH_LOCAL_UPGRADE_IMAGES_FILE. Same-source artifacts
// prove replacement, not a released N-1/N matrix. Services stop during the build to bound memory
// and always restart. Native platform only, as the upgrade driver requires.
import fs from 'node:fs';
import { readState, compose, docker } from './runtime.mjs';

const directory = process.env.ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR, out = process.env.ZENITH_LOCAL_UPGRADE_IMAGES_FILE, runId = process.env.ZENITH_LOCAL_RUN_ID;
if (!directory || !out || !runId) throw new Error('upgrade-candidates:usage');
const platform = { arm64: 'linux/arm64', x64: 'linux/amd64' }[process.arch];
if (!platform) throw new Error('upgrade-candidates:native-architecture');
const state = readState(directory);
const input = JSON.parse(fs.readFileSync(state.directory + '/input.json', 'utf8'));
const cli = ['db', 'auth', 'rest', 'kong', 'pooler'].map(role => `supabase_${role}_${state.projectId}`);
await compose(state, ['stop', 'api', 'execution-worker', 'temporal']);
await docker(['stop', ...cli]);
const images = { schema: 1 };
try {
  for (const [role, file] of [['api', 'Dockerfile'], ['worker', 'docker/worker.Dockerfile'], ['migration', 'deploy/self-hosted/migrations.Dockerfile']]) {
    const repository = `localhost:5000/zenith-${state.installationId}/${role}`, tag = `${repository}:drv3`;
    const args = ['build', '--quiet', '--platform', platform, '--label', `io.zenith.installation=${state.installationId}`,
      '--label', `io.zenith.rehearsal=${runId}`, '-f', file, '-t', tag];
    if (role === 'api') for (const [key, value] of Object.entries(input.environment)) if (key.startsWith('NEXT_PUBLIC_')) args.push('--build-arg', `${key}=${value}`);
    await docker([...args, '.'], { timeout: 1_800_000 });
    await docker(['push', tag], { timeout: 600_000 });
    images[role] = JSON.parse(await docker(['image', 'inspect', tag]))[0].RepoDigests.find(ref => ref.startsWith(repository + '@'));
    if (!images[role]) throw new Error('upgrade-candidates:digest');
  }
  fs.writeFileSync(out, JSON.stringify(images), { mode: 0o600, flag: 'wx' });
} finally {
  await docker(['start', ...cli]);
  await compose(state, ['up', '-d', '--wait', 'api', 'execution-worker', 'temporal']);
}
process.stdout.write('Upgrade candidates written.\n');
