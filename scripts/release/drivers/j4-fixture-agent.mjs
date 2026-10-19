/**
 * Source-only J4 B adapter candidate. Execute only as part of the reviewed
 * single R17-held Node coordinator; this module has not been imported/run.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Machine } from '../../../tests/e2e/default/engines.mjs';
import { docker, ensure, until } from '../../../tests/e2e/default/support.mjs';
import { consumePrivateToken } from './j4-auth-consent.mjs';

const SHA = /^[a-f0-9]{64}$/;
const DIGEST_IMAGE = /^[A-Za-z0-9][A-Za-z0-9./:_-]*@sha256:[a-f0-9]{64}$/;
const MACHINE_ID = /^[A-Za-z0-9_-]{1,200}$/;
const sha256 = value => createHash('sha256').update(Buffer.isBuffer(value) ? value : typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const stable = value => Array.isArray(value) ? '[' + value.map(stable).join(',') + ']'
  : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}'
    : typeof value === 'number' && !Number.isFinite(value) ? (() => { throw new Error('j4-agent:nonfinite'); })() : JSON.stringify(value);
const requireFact = (condition, id) => { if (!condition) throw new Error('j4-agent:' + id); };

function fileRef(ref, root, expectedMode = 0o600) {
  requireFact(ref && path.isAbsolute(ref.path) && SHA.test(ref.sha256), 'file-ref');
  const input = path.resolve(ref.path), realRoot = fs.realpathSync(root);
  for (let current = input; current !== path.dirname(current); current = path.dirname(current))
    requireFact(!fs.lstatSync(current).isSymbolicLink(), 'file-no-symlink-ancestor');
  const real = fs.realpathSync(input);
  requireFact(real.startsWith(realRoot + path.sep), 'file-under-private-root');
  const stat = fs.lstatSync(real);
  requireFact(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === process.getuid() &&
    (stat.mode & 0o777) === expectedMode && stat.size <= 512 * 1024, 'file-owner-mode-size');
  const bytes = fs.readFileSync(real);
  requireFact(sha256(bytes) === ref.sha256, 'file-hash');
  return { real, bytes };
}

function verifyBinding(binding) {
  requireFact(binding?.schemaVersion === 1 && binding.kind === 'j4_fixture_binding' &&
    /^[a-z0-9][a-z0-9-]{3,19}$/.test(binding.runId) && binding.source?.dirty === false &&
    /^[a-f0-9]{40}$/.test(binding.source.head) && SHA.test(binding.source.contentSha256), 'binding-shape');
  const { bindingSha256, ...rest } = binding;
  requireFact(SHA.test(bindingSha256) && sha256(stable(rest)) === bindingSha256, 'binding-digest');
  requireFact(path.isAbsolute(binding.privateDir) && path.resolve(binding.privateDir) ===
    path.resolve(binding.r9?.privateRuntime ?? '', 'signed-delivery'), 'binding-private-dir');
  const privateStat = fs.lstatSync(binding.privateDir);
  requireFact(privateStat.isDirectory() && !privateStat.isSymbolicLink() && privateStat.uid === process.getuid() &&
    (privateStat.mode & 0o777) === 0o700, 'binding-private-dir-owner-mode');
  requireFact(/^https?:\/\/(127\.0\.0\.1|localhost)(:[0-9]+)?$/.test(binding.apiOrigin), 'binding-api-origin');
  requireFact(/^[a-f0-9]{64}$/.test(binding.runtime?.apiContainerId ?? '') &&
    /^[a-f0-9]{64}$/.test(binding.runtime?.databaseContainerId ?? ''), 'binding-runtime-container-ids');
  return binding;
}

function verifyPhaseReceipt(ref, binding, expected, location = 'root', extra = {}) {
  const { bytes } = fileRef(ref, binding.privateDir);
  const receipt = JSON.parse(bytes.toString('utf8'));
  requireFact(receipt.runId === binding.runId && receipt.bindingSha256 === binding.bindingSha256, 'phase-receipt-binding');
  const actual = location === 'target' ? receipt.target : receipt;
  requireFact(actual && typeof actual === 'object' && !Array.isArray(actual), 'phase-receipt-' + location);
  if (location === 'target') {
    // A2's canonical owner receipt has one closed target envelope. Reject
    // parallel top-level copies so that envelope remains authoritative.
    const topKeys = ['bindingSha256','cleanupEpoch','cleanupOwner','credentials','kind','r16SourceFreezeSha256','readbacks','resource','runId','schemaVersion','source','target','timestamps'];
    const targetKeys = ['address','connectionId','deploymentId','environmentId','operationId','projectId','resourceId','workspaceId'];
    const resourceKeys = ['kind','nativeType','ownership','provider','revisionId','status'];
    const timestampKeys = ['createdAfterEpoch','environmentCreatedAt','resourceCreatedAt'];
    const readbackKeys = ['connectionSha256','deploymentSha256','kindBindingSha256','resourceReadbackSha256','runtimeOwnershipSha256'];
    requireFact(receipt.kind === 'j4_target_owner_receipt' && receipt.schemaVersion === 1 &&
      Object.keys(receipt).sort().join(',') === topKeys.join(','), 'phase-receipt-target-envelope');
    requireFact(Object.keys(actual).sort().join(',') === targetKeys.join(','), 'phase-receipt-target-keys');
    for (const key of targetKeys) requireFact(!Object.hasOwn(receipt, key), 'phase-receipt-duplicate-' + key);
    requireFact(typeof actual.connectionId === 'string' && actual.connectionId.length > 0 && actual.connectionId.length <= 200,
      'phase-receipt-connection-id');
    requireFact(receipt.cleanupEpoch === binding.cleanupEpoch &&
      stable(receipt.source) === stable(binding.source) &&
      receipt.r16SourceFreezeSha256 === binding.r16SourceFreezeSha256, 'phase-receipt-target-source-binding');
    requireFact(receipt.resource && Object.keys(receipt.resource).sort().join(',') === resourceKeys.join(',') &&
      receipt.resource.provider === 'kubernetes' && receipt.resource.kind === 'container_service' &&
      receipt.resource.nativeType === 'k8s:Deployment' && receipt.resource.ownership === 'managed' &&
      receipt.resource.status === 'active' && typeof receipt.resource.revisionId === 'string' && receipt.resource.revisionId.length > 0,
      'phase-receipt-resource');
    requireFact(receipt.timestamps && Object.keys(receipt.timestamps).sort().join(',') === timestampKeys.join(',') &&
      receipt.timestamps.environmentCreatedAt === extra.environmentCreatedAt &&
      receipt.timestamps.resourceCreatedAt === extra.resourceCreatedAt && receipt.timestamps.createdAfterEpoch === true,
      'phase-receipt-target-timestamps');
    requireFact(receipt.readbacks && Object.keys(receipt.readbacks).sort().join(',') === readbackKeys.join(',') &&
      Object.values(receipt.readbacks).every(value => SHA.test(value)) &&
      receipt.readbacks.resourceReadbackSha256 === extra.resourceReadbackSha256, 'phase-receipt-target-readbacks');
  }
  for (const [key, value] of Object.entries(expected)) requireFact(actual[key] === value, 'phase-receipt-' + location + '-' + key);
  return sha256(bytes);
}

async function verifyRuntimeOwners(binding) {
  const [apiRaw, dbRaw] = await Promise.all([
    docker(['inspect', binding.runtime.apiContainerId], { maxBytes: 128 * 1024 }),
    docker(['inspect', binding.runtime.databaseContainerId], { maxBytes: 128 * 1024 }),
  ]);
  const [api] = JSON.parse(apiRaw), [db] = JSON.parse(dbRaw);
  requireFact(api?.Id === binding.runtime.apiContainerId && db?.Id === binding.runtime.databaseContainerId &&
    api.State?.Running === true && db.State?.Running === true, 'runtime-exact-running-containers');
  for (const [actual, expected] of [[api.Config?.Labels ?? {}, binding.runtime.apiOwnerLabels],
    [db.Config?.Labels ?? {}, binding.runtime.databaseOwnerLabels]]) {
    requireFact(expected && Object.keys(expected).length > 0 && Object.entries(expected).every(([key, value]) => actual[key] === value), 'runtime-owner-labels');
  }
  return { apiId: api.Id, databaseId: db.Id, apiImage: api.Config?.Image, databaseImage: db.Config?.Image };
}

class J4Machine extends Machine {
  async startExecDisabled(token, environmentId, address) {
    this.startupUncertain = true;
    this.freshTokenState = 'unconfirmed';
    for (const volume of this.volumes) {
      this.intents.push({ kind: 'volume', id: volume });
      await docker(['volume', 'create', '--label', 'io.zenith.journey=' + this.runId, volume]);
    }
    const config = {
      controlPlane: { url: 'http://127.0.0.1:3400' }, name: this.container,
      stateDir: '/var/lib/zenithd', registration: { tokenFile: '/witness/registration-token' },
      exec: { enabled: false }, heartbeatSec: 5, pollWaitSec: 2, maxConcurrent: 1,
      labels: { 'zenith.credentialMode': 'local_only' },
    };
    this.agentConfig = config;
    await this.seed(token, config);
    this.intents.push({ kind: 'container', id: this.container });
    await docker(['run', '-d', '--name', this.container, '--label', 'io.zenith.journey=' + this.runId,
      '--network', 'container:' + this.stack.api, '--read-only', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges:true', '--memory', '96m', '--pids-limit', '64',
      '--mount', 'type=volume,source=' + this.volumes[0] + ',target=/witness',
      '--mount', 'type=volume,source=' + this.volumes[1] + ',target=/var/lib/zenithd',
      '--entrypoint', '/usr/local/bin/zenithd', this.config.machine.image, 'run', '--config', '/witness/config.json']);
    this.environmentId = environmentId;
    this.address = address;
  }
}

function readMachineCookie(cookieRef, privateDir, apiOrigin) {
  const { bytes } = fileRef(cookieRef, privateDir);
  const cookie = bytes.toString('utf8');
  requireFact(cookie.length > 0 && cookie.length <= 16 * 1024 && !/[\r\n\u0000]/.test(cookie) &&
    new URL(apiOrigin).origin === apiOrigin, 'api-cookie');
  return cookie;
}

async function apiMachineReadback(binding, target, consent) {
  const cookie = readMachineCookie(consent.cookieFile, binding.privateDir, binding.apiOrigin);
  return until(async () => {
    const response = await fetch(binding.apiOrigin + '/api/platform/v1/machines', {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { cookie, 'x-zenith-workspace': target.workspaceId },
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    requireFact(bytes.length <= 512 * 1024 && response.status === 200, 'api-readback-status-size');
    const data = JSON.parse(bytes.toString('utf8'));
    requireFact(data?.ok !== false && Array.isArray(data.machines), 'api-readback-shape');
    const matches = data.machines.filter(machine => machine.name === 'zenith-j4-' + binding.runId &&
      machine.transport === 'zenithd' && machine.workspaceId === target.workspaceId &&
      machine.environmentId === target.environmentId && machine.address === target.address);
    return { matches, sha256: sha256(bytes) };
  }, value => value.matches.length === 1 && value.matches[0].connection?.state === 'online', 180_000)
    .then(value => ({ machine: value.matches[0], sha256: value.sha256 }));
}

async function databaseReadback(binding, machineId, tokenHash, target) {
  requireFact(MACHINE_ID.test(machineId) && SHA.test(tokenHash), 'db-query-input');
  const literal = value => "'" + String(value).replaceAll("'", "''") + "'";
  const sql = "select json_build_object('machine',(select row_to_json(m) from platform.machines m where m.id='" + machineId +
    "' and m.workspace_id=" + literal(target.workspaceId) + "), 'token',(select row_to_json(t) from platform.runner_registration_tokens t where t.token_hash='" +
    tokenHash + "'))::text";
  const text = await docker(['exec', binding.runtime.databaseContainerId, 'psql', '-X', '-A', '-t', '-U', 'postgres', '-d', 'postgres', '-c', sql],
    { timeout: 30_000, maxBytes: 128 * 1024 });
  const row = JSON.parse(text);
  requireFact(row?.machine?.id === machineId && row.machine.workspace_id === target.workspaceId &&
    row.machine.environment_id === target.environmentId && row.machine.address === target.address &&
    row.machine.transport === 'zenithd' && row.machine.status === 'active', 'db-machine-binding');
  requireFact(row.token?.kind === 'machine' && row.token.workspace_id === target.workspaceId &&
    row.token.used_at && row.token.used_by === machineId && row.token.binding?.environmentId === target.environmentId &&
    row.token.binding?.address === target.address && Number.isFinite(Date.parse(row.token.expires_at)) &&
    Date.parse(row.token.expires_at) > Date.parse(row.machine.registered_at), 'db-token-consumption-binding');
  return { row, sha256: sha256(JSON.stringify(row)) };
}

async function copyHash(containerId, sourcePath, destination) {
  await docker(['cp', containerId + ':' + sourcePath, destination], { maxBytes: 1024 });
  try {
    const stat = fs.lstatSync(destination);
    requireFact(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === process.getuid() && stat.size <= 8 * 1024 * 1024,
      'native-copy-private-file');
    const bytes = fs.readFileSync(destination);
    return { sha256: sha256(bytes), bytes };
  } finally { fs.rmSync(destination, { force: true }); }
}

function writeReceipt(privateDir, runId, record) {
  const file = path.join(privateDir, 'j4-agent-' + runId + '-observed.private.json');
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const stat = fs.lstatSync(file);
  requireFact(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === process.getuid() &&
    (stat.mode & 0o777) === 0o600, 'receipt-private');
  return { path: file, sha256: sha256(fs.readFileSync(file)) };
}

/** Candidate only; exact API follows frozen shared binding R2. */
export async function startAgent({ r9Binding, targetFacts, consentFacts, privateTokenHandle, sourceBoundImage }) {
  const binding = verifyBinding(r9Binding);
  const join = facts => facts?.runId === binding.runId && facts.bindingSha256 === binding.bindingSha256;
  requireFact(join(targetFacts) && join(consentFacts), 'phase-binding-join');
  requireFact(targetFacts.workspaceId === consentFacts.workspaceId && targetFacts.environmentId === consentFacts.environmentId &&
    targetFacts.resourceId === consentFacts.resourceId && targetFacts.address === consentFacts.address &&
    targetFacts.environmentId === consentFacts.environmentId && targetFacts.address === 'service/witness' &&
    consentFacts.requestSha256 && consentFacts.registration === 'not_created' && consentFacts.responseStatus === 201 &&
    consentFacts.shownOnce === true && consentFacts.actorRole === 'admin', 'phase-target-consent-join');
  const expectedRequestSha256 = sha256(stable({ kind: 'machine', ttlMinutes: 1,
    binding: { environmentId: targetFacts.environmentId, address: targetFacts.address } }));
  requireFact(consentFacts.requestSha256 === expectedRequestSha256, 'consent-request-digest');
  const epochMs = Date.parse(binding.cleanupEpoch);
  requireFact(targetFacts.createdAfterEpoch === true && Number.isFinite(epochMs) &&
    Date.parse(targetFacts.environmentCreatedAt) > epochMs && Date.parse(targetFacts.resourceCreatedAt) > epochMs,
    'target-after-cleanup-epoch');
  const targetReceiptSha256 = verifyPhaseReceipt(targetFacts.ownerReceipt, binding, {
    workspaceId: targetFacts.workspaceId, projectId: targetFacts.projectId,
    environmentId: targetFacts.environmentId, resourceId: targetFacts.resourceId, address: targetFacts.address,
    deploymentId: targetFacts.deploymentId, operationId: targetFacts.operationId,
  }, 'target', { environmentCreatedAt: targetFacts.environmentCreatedAt, resourceCreatedAt: targetFacts.resourceCreatedAt,
    resourceReadbackSha256: targetFacts.resourceReadbackSha256 });
  const consentReceiptSha256 = verifyPhaseReceipt(consentFacts.ownerReceipt, binding, {
    workspaceId: consentFacts.workspaceId, environmentId: consentFacts.environmentId,
    resourceId: consentFacts.resourceId, address: consentFacts.address,
    actorUserId: consentFacts.actorUserId, actorRole: 'admin', requestSha256: consentFacts.requestSha256,
    responseStatus: 201, shownOnce: true, expiresAt: consentFacts.expiresAt, registration: 'not_created',
  });
  requireFact(DIGEST_IMAGE.test(sourceBoundImage) && binding.runtime.apiContainerId && binding.runtime.databaseContainerId, 'source-image-or-runtime');
  const stack = { api: binding.runtime.apiContainerId, state: { projectId: binding.runtime.supabaseProjectId,
    installationId: binding.runtime.installationId } };
  const machine = new J4Machine({ machine: { image: sourceBoundImage } }, stack, binding.runId);
  machine.container = 'zenith-j4-' + binding.runId;
  machine.volumes = [machine.container + '-witness', machine.container + '-state'];
  machine.agentNames = [machine.container];
  machine.agentIds = [];
  machine.credential = '';
  machine.freshTokenState = 'unconfirmed';
  let phase = 'consent-token-handle';
  try {
    requireFact(Date.parse(consentFacts.expiresAt) > Date.now(), 'consent-token-expired');
    const token = consumePrivateToken(privateTokenHandle, { runId: binding.runId, bindingSha256: binding.bindingSha256,
      workspaceId: targetFacts.workspaceId, environmentId: targetFacts.environmentId,
      address: targetFacts.address, expiresAt: consentFacts.expiresAt });
    requireFact(/^zmt_[A-Za-z0-9_-]{32}$/.test(token), 'private-token-value');
    const tokenHash = sha256(token);
    phase = 'image-readback';
    await verifyRuntimeOwners(binding);
    const imageText = await docker(['image', 'inspect', sourceBoundImage], { maxBytes: 128 * 1024 });
    const [image] = JSON.parse(imageText);
    ensure(image?.Architecture === 'arm64' && image.RepoDigests?.includes(sourceBoundImage), 'j4-agent-native-source-image');
    phase = 'native-start';
    await machine.startExecDisabled(token, targetFacts.environmentId, targetFacts.address);
    const [container] = JSON.parse(await docker(['inspect', machine.container], { maxBytes: 128 * 1024 }));
    ensure(container?.State?.Running === true && container.Config?.Labels?.['io.zenith.journey'] === binding.runId &&
      container.Config?.Image === sourceBoundImage && container.Image === image.Id, 'j4-agent-owned-container-readback');
    for (const volumeName of machine.volumes) {
      const [volume] = JSON.parse(await docker(['volume', 'inspect', volumeName], { maxBytes: 64 * 1024 }));
      ensure(volume?.Name === volumeName && volume.Labels?.['io.zenith.journey'] === binding.runId, 'j4-agent-volume-owner');
    }
    const privateDir = fs.realpathSync(binding.privateDir);
    const configPath = path.join(privateDir, 'j4-agent-' + binding.runId + '-config.readback');
    const binaryPath = path.join(privateDir, 'j4-agent-' + binding.runId + '-binary.readback');
    const configReadback = await copyHash(container.Id, '/witness/config.json', configPath);
    const actualConfig = JSON.parse(configReadback.bytes.toString('utf8'));
    ensure(sha256(stable(actualConfig)) === sha256(stable(machine.agentConfig)) && actualConfig.exec?.enabled === false &&
      !Object.hasOwn(actualConfig.exec ?? {}, 'allowArgv0'), 'j4-agent-config-readback');
    const binaryReadback = await copyHash(container.Id, '/usr/local/bin/zenithd', binaryPath);
    ensure(binaryReadback.bytes.length > 20 && binaryReadback.bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) &&
      binaryReadback.bytes.readUInt16LE(18) === 183, 'j4-agent-native-arm64-binary');
    const api = await apiMachineReadback(binding, targetFacts, consentFacts);
    const observed = api.machine;
    ensure(observed.id && observed.id === observed.targetId && observed.name === machine.container && observed.transport === 'zenithd' &&
      observed.status === 'active' && observed.stale === false && observed.connection?.state === 'online' &&
      observed.capabilities?.includes('machine.inspect') && !observed.capabilities?.includes('machine.exec') &&
      !observed.capabilities?.includes('container.exec') && observed.lastHeartbeatAt &&
      Date.parse(observed.lastHeartbeatAt) >= Date.parse(observed.registeredAt), 'j4-agent-api-heartbeat-capabilities');
    ensure(Date.now() - Date.parse(observed.lastHeartbeatAt) < 90_000, 'j4-agent-api-heartbeat-fresh');
    phase = 'db-token-and-heartbeat-readback';
    const dbResult = await databaseReadback(binding, observed.id, tokenHash, targetFacts);
    const dbMachine = dbResult.row.machine;
    ensure(JSON.stringify(dbMachine.capabilities) === JSON.stringify(observed.capabilities) &&
      dbMachine.last_heartbeat_at && Date.parse(dbMachine.last_heartbeat_at) >= Date.parse(dbMachine.registered_at) &&
      Date.now() - Date.parse(dbMachine.last_heartbeat_at) < 90_000 &&
      dbMachine.capabilities.includes('machine.inspect') && !dbMachine.capabilities.includes('machine.exec') &&
      !dbMachine.capabilities.includes('container.exec'), 'j4-agent-db-heartbeat-capabilities');
    machine.id = observed.id;
    machine.agentIds.push(observed.id);
    machine.freshTokenState = 'consumed-confirmed';
    machine.startupUncertain = false;
    const configDigest = sha256(stable(machine.agentConfig));
    const record = {
      schemaVersion: 1, kind: 'j4_agent_facts', runId: binding.runId, bindingSha256: binding.bindingSha256,
      workspaceId: targetFacts.workspaceId, environmentId: targetFacts.environmentId, resourceId: targetFacts.resourceId,
      address: targetFacts.address, requestSha256: consentFacts.requestSha256,
      machineId: observed.id, machineName: observed.name, transport: observed.transport, status: observed.status,
      stale: observed.stale, capabilities: observed.capabilities,
      registeredAt: observed.registeredAt, lastHeartbeatAt: observed.lastHeartbeatAt,
      native: { containerId: container.Id, containerName: machine.container, image: sourceBoundImage,
        imageId: image.Id, architecture: image.Architecture, configSha256: configDigest,
        actualConfigSha256: configReadback.sha256, binarySha256: binaryReadback.sha256 },
      registration: { tokenConsumed: true, usedByMachineId: observed.id, bindingMatched: true },
      targetOwnerReceiptSha256: targetReceiptSha256, consentOwnerReceiptSha256: consentReceiptSha256,
      apiReadbackSha256: api.sha256, databaseReadbackSha256: dbResult.sha256,
    };
    const ownerReceipt = writeReceipt(binding.privateDir, binding.runId, record);
    return { agentFacts: { ...record, ownerReceipt }, lifecycleHandle: machine };
  } catch (error) {
    // A thrown phase retains its in-memory owner handle and uncertainty latch;
    // C may close it only after the same owner and token joins are confirmed.
    if (error && typeof error === 'object') {
      error.lifecycleHandle = machine;
      error.lifecyclePhase = phase;
    }
    throw error;
  }
}
