import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { docker, ensure, until, browserRequest, ok, sha256 } from './support.mjs';

export class Machine {
  constructor(config, stack, runId) {
    this.config = config; this.stack = stack; this.runId = runId;
    this.container = 'zenith-j2-' + runId;
    this.volumes = [this.container + '-witness', this.container + '-state'];
    this.credential = randomBytes(32).toString('base64url');
    // Intents are recorded before each Docker create request. Docker can create
    // an object even when the local client loses the response.
    this.intents = [];
    this.startupUncertain = false;
    this.agentNames = [this.container];
    this.agentIds = [];
    this.freshTokenState = 'not-requested';
    this.uncertaintyCustody = false;
    this.uncertaintyContainmentProved = false;
    this.uncertaintyEvidenceDurable = false;
    this.revocationConfirmed = false;
  }
  async seed(token, config, rewrite = false) {
    this.startupUncertain = true;
    const seedContainer = config.name + '-seed';
    if (!this.intents.some(value => value.kind === 'container' && value.id === seedContainer))
      this.intents.push({ kind: 'container', id: seedContainer });
    const args = ['run', '--rm', '-i', '--network', 'none', '--read-only', '--cap-drop', 'ALL'];
    if (rewrite) args.push('--user', '65532:65532');
    else args.push('--cap-add', 'CHOWN', '--user', '0:0');
    args.push('--memory', '64m', '--pids-limit', '32',
      '--mount', 'type=volume,source=' + this.volumes[0] + ',target=/witness',
      '--name', seedContainer, '--label', 'io.zenith.journey=' + this.runId,
      this.config.machine.image, rewrite ? 'seed-update' : 'seed');
    const input = rewrite ? { config, token } : { config, token, credential: this.credential };
    await docker(args, { input: JSON.stringify(input) });
  }
  async start(token, environmentId, address) {
    // Keep an irreversible in-memory latch set across any helper rejection,
    // including timeout/overflow before the Docker client has closed.
    this.startupUncertain = true;
    for (const volume of this.volumes) {
      this.intents.push({ kind: 'volume', id: volume });
      await docker(['volume', 'create', '--label', 'io.zenith.journey=' + this.runId, volume]);
    }
    const config = { controlPlane: { url: 'http://127.0.0.1:3400' }, name: this.container,
      stateDir: '/var/lib/zenithd', registration: { tokenFile: '/witness/registration-token' },
      exec: { enabled: true, allowArgv0: ['/usr/local/bin/witness'] },
      heartbeatSec: 5, pollWaitSec: 2, maxConcurrent: 1,
      labels: { 'zenith.credentialMode': 'local_only' } };
    this.agentConfig = config;
    await this.seed(token, config);
    this.intents.push({ kind: 'container', id: this.container });
    await docker(['run', '-d', '--name', this.container, '--label', 'io.zenith.journey=' + this.runId,
      // Go accepts loopback HTTP only. Share the owned API's network namespace,
      // without a host network, Docker socket, privileged mode or TLS bypass.
      '--network', 'container:' + this.stack.api, '--read-only', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges:true', '--memory', '96m', '--pids-limit', '64',
      '--mount', 'type=volume,source=' + this.volumes[0] + ',target=/witness',
      '--mount', 'type=volume,source=' + this.volumes[1] + ',target=/var/lib/zenithd',
      '--entrypoint', '/usr/local/bin/zenithd', this.config.machine.image, 'run', '--config', '/witness/config.json']);
    this.environmentId = environmentId; this.address = address;
    this.startupUncertain = false;
  }
  async registered(page, workspaceId) {
    const name = this.container;
    const data = await until(async () => ok(await browserRequest(page, '/api/platform/v1/machines', undefined, 'GET', workspaceId)),
      value => value.machines?.some(machine => machine.name === name && machine.connection?.state === 'online'));
    const machine = data.machines.find(value => value.name === name);
    // agentView exposes no transport field; the machines list holds only registered zenithd agents.
    ensure(machine.status === 'active' && machine.environmentId === this.environmentId && machine.address === this.address,
      'machine-consent-binding');
    this.id = machine.id;
    if (!this.agentIds.includes(machine.id)) this.agentIds.push(machine.id);
    return machine;
  }
  async rejoin(token) {
    this.startupUncertain = true;
    const [old] = JSON.parse(await docker(['inspect', this.container]));
    ensure(old.Config.Labels?.['io.zenith.journey'] === this.runId && old.State.Running === false && old.State.ExitCode === 3, 'rejoin-old-container-stopped-owned');
    const oldContainer = this.container;
    const newContainer = oldContainer + '-rejoin';
    ensure(newContainer.length <= 63 && this.agentNames.length === 1, 'rejoin-name-bound');
    const collision = await docker(['ps', '-aq', '--filter', 'name=^/' + newContainer + '$']);
    ensure(collision.length === 0, 'rejoin-container-name-collision');
    this.agentNames.push(newContainer);
    this.agentConfig = { ...this.agentConfig, name: newContainer };
    await this.seed(token, this.agentConfig, true);
    // The old native process has exited. Re-register with the real native binary,
    // the fresh one-use browser token, and the same owned persistent identity volume.
    const registerContainer = newContainer + '-register';
    ensure(registerContainer.length <= 63, 'rejoin-register-name-bound');
    const registerCollision = await docker(['ps', '-aq', '--filter', 'name=^/' + registerContainer + '$']);
    ensure(registerCollision.length === 0, 'rejoin-register-name-collision');
    this.intents.push({ kind: 'container', id: registerContainer });
    const registered = await docker(['run', '--name', registerContainer, '--label', 'io.zenith.journey=' + this.runId,
      '--network', 'container:' + this.stack.api, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--memory', '96m', '--pids-limit', '64',
      '--mount', 'type=volume,source=' + this.volumes[0] + ',target=/witness',
      '--mount', 'type=volume,source=' + this.volumes[1] + ',target=/var/lib/zenithd',
      '--entrypoint', '/usr/local/bin/zenithd', this.config.machine.image,
      'register', '--config', '/witness/config.json', '--force', '--token-file', '/witness/registration-token']);
    const identity = /^registered machine ([A-Za-z0-9_-]+) in workspace .+$/m.exec(registered);
    ensure(identity, 'rejoin-native-register-receipt');
    // Scrub the consumed token from the fixture volume before starting the new process.
    await this.seed('', this.agentConfig, true);
    this.rejoinedId = identity[1];
    this.agentIds.push(this.rejoinedId);
    this.intents.push({ kind: 'container', id: newContainer });
    try {
      await docker(['run', '-d', '--name', newContainer, '--label', 'io.zenith.journey=' + this.runId,
        '--network', 'container:' + this.stack.api, '--read-only', '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges:true', '--memory', '96m', '--pids-limit', '64',
        '--mount', 'type=volume,source=' + this.volumes[0] + ',target=/witness',
        '--mount', 'type=volume,source=' + this.volumes[1] + ',target=/var/lib/zenithd',
        '--entrypoint', '/usr/local/bin/zenithd', this.config.machine.image, 'run', '--config', '/witness/config.json']);
    } catch (error) {
      // The pre-recorded intent keeps an ambiguous Docker result owned and retained.
      throw error;
    }
    this.container = newContainer;
    this.startupUncertain = false;
  }
  async revokeOwnedMachines(page, workspaceId) {
    const list = async () => ok(await browserRequest(page, '/api/platform/v1/machines', undefined, 'GET', workspaceId)).machines;
    ensure(this.agentIds.length > 0, 'machine-cleanup-no-identity');
    const current = await list();
    const owned = current.filter(machine => this.agentNames.includes(machine.name) || this.agentIds.includes(machine.id));
    // The machine list (agentView) carries no transport; ownership is name, environment and address.
    ensure(owned.every(machine => this.agentNames.includes(machine.name) &&
      machine.environmentId === this.environmentId && machine.address === this.address), 'machine-cleanup-binding');
    ensure(new Set(owned.map(machine => machine.id)).size === owned.length && this.agentIds.every(id => owned.some(machine => machine.id === id)),
      'machine-cleanup-identity-join');
    for (const machine of owned) if (machine.status !== 'revoked') {
      const result = ok(await browserRequest(page, '/api/platform/v1/machines/' + machine.id + '/revoke', {}, 'POST', workspaceId));
      ensure(result.id === machine.id && result.status === 'revoked', 'machine-cleanup-revocation');
    }
    const after = await list();
    const remaining = after.filter(machine => this.agentNames.includes(machine.name) || this.agentIds.includes(machine.id));
    ensure(remaining.length === owned.length && remaining.every(machine => machine.status === 'revoked' && machine.revokedAt &&
      machine.environmentId === this.environmentId && machine.address === this.address),
      'machine-cleanup-revocation-readback');
  }
  async readUncertaintyMarker(expectedNonce) {
    ensure(/^[a-f0-9]{24}$/.test(expectedNonce), 'uncertainty-marker-nonce');
    const output = await docker(['exec', this.container, '/usr/local/bin/witness', 'hold-read', expectedNonce], { timeout: 10_000, maxBytes: 512 });
    const marker = JSON.parse(output);
    ensure(marker && Object.keys(marker).sort().join(',') === 'kind,nonce' && marker.kind === 'zenith-default-journey' &&
      marker.nonce === expectedNonce, 'uncertainty-marker-readback');
    const canonical = JSON.stringify({ kind: marker.kind, nonce: marker.nonce });
    ensure(output.trim() === canonical, 'uncertainty-marker-canonical');
    return { sha256: sha256(canonical), nonceMatch: true };
  }
  async read(expectedNonce) {
    const read = await docker(['exec', this.container, '/usr/local/bin/witness', 'read']);
    const data = JSON.parse(read);
    ensure(data.nonce === expectedNonce && data.kind === 'zenith-default-journey', 'machine-independent-readback');
    return sha256(data);
  }
  async credentialAbsent(scratch, additionalCredentials = []) {
    // Scan the CP containers' environment and durable application directories on
    // the HOST. Never send the local credential to a CP process or model.
    const inspect = await docker(['inspect', this.stack.api, this.stack.worker]);
    for (const credential of [this.credential, ...additionalCredentials]) ensure(!inspect.includes(credential), 'credential-in-cp-environment');
    // J1 proves product and authority share this owned local PostgreSQL engine.
    // Export through its existing local admin socket, never pass the canary to
    // SQL/the CP, and inspect the bounded logical dump only in host memory.
    const database = 'supabase_db_' + this.stack.state.projectId;
    const [db] = JSON.parse(await docker(['inspect', database]));
    ensure(db.Config.Labels?.['com.supabase.cli.project'] === this.stack.state.projectId &&
      db.Config.Labels?.['io.zenith.installation'] === this.stack.state.installationId, 'cp-database-ownership');
    const dump = await docker(['exec', database, 'pg_dump', '-U', 'postgres', '-d', 'postgres', '--format=plain'],
      { maxBytes: 64 * 1024 * 1024, timeout: 120_000 });
    ensure(dump.includes('CREATE SCHEMA platform;'), 'cp-logical-dump-empty');
    for (const credential of [this.credential, ...additionalCredentials]) ensure(!dump.includes(credential), 'credential-in-cp-database');
    for (const [id, directory] of [[this.stack.api, '/data'], [this.stack.worker, '/var/lib/zenith']]) {
      const destination = path.join(scratch, id.slice(0, 12));
      fs.mkdirSync(destination, { mode: 0o700 });
      await docker(['cp', id + ':' + directory + '/.', destination], { maxBytes: 1024 });
      let bytes = 0;
      const walk = folder => {
        for (const name of fs.readdirSync(folder)) {
          const file = path.join(folder, name), stat = fs.lstatSync(file);
          ensure(!stat.isSymbolicLink(), 'cp-scan-symlink');
          if (stat.isDirectory()) walk(file);
          else if (stat.isFile()) {
            bytes += stat.size;
            ensure(bytes <= 64 * 1024 * 1024, 'cp-scan-bound');
            const contents = fs.readFileSync(file);
            for (const credential of [this.credential, ...additionalCredentials]) ensure(!contents.includes(Buffer.from(credential)), 'credential-in-cp-file');
          }
        }
      };
      try { walk(destination); } finally { fs.rmSync(destination, { recursive: true, force: true }); }
    }
  }
  async quiesceOwned() {
    const present = await docker(['ps', '-a', '--filter', 'label=io.zenith.journey=' + this.runId, '--format', '{{.Names}}']);
    const names = new Set(present.split(/\r?\n/).map(value => value.trim()).filter(Boolean));
    for (const resource of this.intents.filter(value => value.kind === 'container')) {
      if (!names.has(resource.id)) continue;
      const [current] = JSON.parse(await docker(['inspect', resource.id]));
      ensure(current.Config.Labels?.['io.zenith.journey'] === this.runId, 'quiesce-container-ownership');
      if (current.State.Running) {
        await docker(['stop', '--time', '10', resource.id]);
        const [stopped] = JSON.parse(await docker(['inspect', resource.id]));
        ensure(stopped.Config.Labels?.['io.zenith.journey'] === this.runId && stopped.State.Running === false, 'quiesce-stop-readback');
      }
    }
  }
  async cleanup() {
    if (this.uncertaintyCustody) throw new Error('journey:cleanup-uncertainty-custody');
    if (this.startupUncertain) throw new Error('journey:cleanup-startup-uncertain');
    const failures = [];
    const inventory = async kind => {
      const args = kind === 'container'
        ? ['ps', '-a', '--filter', 'label=io.zenith.journey=' + this.runId, '--format', '{{.Names}}']
        : ['volume', 'ls', '--filter', 'label=io.zenith.journey=' + this.runId, '--format', '{{.Name}}'];
      const text = await docker(args);
      return new Set(text.split(/\r?\n/).map(value => value.trim()).filter(Boolean));
    };
    let present;
    try {
      present = { container: await inventory('container'), volume: await inventory('volume') };
    } catch {
      // If Docker cannot prove the owner-filtered inventory, retain resources.
      // Never guess, force-remove, or run a broad cleanup command.
      throw new Error('journey:cleanup-inventory');
    }
    for (const resource of [...this.intents].reverse()) {
      if (!present[resource.kind].has(resource.id)) continue;
      const inspectKind = resource.kind === 'container' ? 'container' : 'volume';
      const [current] = JSON.parse(await docker([inspectKind, 'inspect', resource.id]));
      const labels = resource.kind === 'container' ? current.Config?.Labels : current.Labels;
      ensure(labels?.['io.zenith.journey'] === this.runId, 'cleanup-ownership');
      if (resource.kind === 'container') {
        if (current.State?.Running) await docker(['stop', '--time', '10', resource.id]);
        await docker(['rm', resource.id]);
      } else await docker(['volume', 'rm', resource.id]);
      }
    const remaining = { container: await inventory('container'), volume: await inventory('volume') };
    for (const resource of this.intents) {
      if (remaining[resource.kind].has(resource.id)) failures.push(resource.kind + ':' + resource.id);
    }
    // Unexpected resources carrying this unique run label are not ours to
    // delete automatically; surface them as unresolved ownership.
    for (const kind of ['container', 'volume']) {
      const expected = new Set(this.intents.filter(item => item.kind === kind).map(item => item.id));
      for (const id of remaining[kind]) if (!expected.has(id)) failures.push(kind + ':unexpected-owned-label');
    }
    ensure(failures.length === 0, 'cleanup-unresolved');
  }
}
