/**
 * J4 signed-delivery fixture coordinator R5 (source-only; not integrated or executed).
 * Intended destination: scripts/acceptance/default-stack/j4-fixture-held.mjs
 * It must run as the sole Node subject of a reviewed R17 held command. This
 * artifact has not been imported, syntax-checked, or executed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { load as yamlLoad } from 'js-yaml';
import { prepareAuthContext, prepareConsent } from '../../release/drivers/j4-auth-consent.mjs';
import { startAgent } from '../../release/drivers/j4-fixture-agent.mjs';
import { prepareTarget } from './j4-fixture-target.mjs';
import { prepare as prepareLocalKind } from '../../../tests/e2e/default/prepare.mjs';
import { docker, kubeconfig } from '../../../tests/e2e/default/support.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const FIXED_ENV = Object.freeze({
  HOME: '/Users/saivedanthava',
  PATH: '/Applications/Docker.app/Contents/Resources/bin:/Users/saivedanthava/.local/share/zenith-verifier/bin:/usr/bin:/bin',
  DOCKER_HOST: 'unix:///Users/saivedanthava/.docker/run/docker.sock',
  TMPDIR: '/tmp', LANG: 'C', LC_ALL: 'C',
});
const SCHEMA_SHA256 = '4456d3ba2b158008b1fa62b30e7822f30515a386395e7d7d10f8743317ea7d9c';
const AUTH_SHA256 = 'cab426e712ecff14038142b11b6db9e09e8b6925d8fc5298ea6efe433fa52a76';
const TARGET_SHA256 = '424726256c3ec9bf53664c227a8645ed51cd3054d6c92afda349d15131c9e73f';
const AGENT_SHA256 = '8cb7737f5025e798b72b99dff8e7b6171732dd6411c186cf7fc55311e6882007';
const CASE_ID = 'wave6-55718f085353604a';
const TEST_NAME = 'joins real signed registered delivery, broker semantics, evidence and cancellation audit';
const KIND_YAML = 'kind: Cluster\napiVersion: kind.x-k8s.io/v1alpha4\nnetworking:\n  apiServerAddress: 127.0.0.1\n  disableDefaultCNI: true\n  podSubnet: "10.244.0.0/16"\nnodes:\n- role: control-plane\n- role: worker\n';
const SHA256 = /^[a-f0-9]{64}$/;
const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = value => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('j4-held:non-json-object');
    return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  }
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('j4-held:nonfinite');
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint')
    throw new Error('j4-held:non-json-value');
  return value;
};
const canonicalHash = value => hash(Buffer.from(JSON.stringify(canonical(value)), 'utf8'));
const need = (value, code) => { if (!value) throw new Error(`j4-held:${code}`); return value; };
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const sameFileSnapshot = (a, b) => a.isFile() && b.isFile() && a.dev === b.dev && a.ino === b.ino
  && a.uid === b.uid && a.mode === b.mode && a.nlink === b.nlink && a.size === b.size
  && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

function readExactBounded(fd, size, max, code) {
  need(Number.isSafeInteger(size) && size >= 0 && size <= max, `${code}-size`);
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const count = fs.readSync(fd, bytes, offset, size - offset, offset);
    need(count > 0, `${code}-short-read`);
    offset += count;
  }
  const extra = Buffer.alloc(1);
  need(fs.readSync(fd, extra, 0, 1, size) === 0, `${code}-grew-during-read`);
  return bytes;
}

function privateRead(file, expectedSha, root, mode = 0o600, max = 2 * 1024 * 1024) {
  need(Number.isInteger(fs.constants.O_NOFOLLOW), 'nofollow-unavailable');
  need(path.isAbsolute(file) && path.resolve(file) === file, 'private-file-path');
  const rootReal = fs.realpathSync(root), before = fs.lstatSync(file);
  need(before.isFile() && !before.isSymbolicLink() && before.uid === process.getuid()
    && (before.mode & 0o777) === mode && before.nlink === 1 && before.size <= max, 'private-file-identity');
  for (let p = file; p !== path.dirname(p); p = path.dirname(p)) need(!fs.lstatSync(p).isSymbolicLink(), 'private-file-ancestor');
  const real = fs.realpathSync(file);
  need(real.startsWith(rootReal + path.sep), 'private-file-scope');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    need(sameFileSnapshot(before, opened), 'private-file-race');
    const bytes = readExactBounded(fd, opened.size, max, 'private-file-read');
    const afterFd = fs.fstatSync(fd);
    const after = fs.lstatSync(file);
    need(sameFileSnapshot(opened, afterFd) && sameFileSnapshot(before, after)
      && after.dev === opened.dev && after.ino === opened.ino
      && bytes.length === before.size && hash(bytes) === expectedSha, 'private-file-hash-or-change');
    return bytes;
  } finally { fs.closeSync(fd); }
}

function privateOwnedRead(file, root, modes = [0o600], max = 1024 * 1024) {
  need(Number.isInteger(fs.constants.O_NOFOLLOW), 'nofollow-unavailable');
  need(path.isAbsolute(file) && path.resolve(file) === file, 'private-owned-path');
  const rootReal = fs.realpathSync(root), before = fs.lstatSync(file);
  need(before.isFile() && !before.isSymbolicLink() && before.uid === process.getuid()
    && modes.includes(before.mode & 0o777) && before.nlink === 1 && before.size <= max, 'private-owned-identity');
  for (let p = file; p !== path.dirname(p); p = path.dirname(p))
    need(!fs.lstatSync(p).isSymbolicLink(), 'private-owned-ancestor');
  need(fs.realpathSync(file).startsWith(rootReal + path.sep), 'private-owned-scope');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    need(sameFileSnapshot(before, opened), 'private-owned-race');
    const bytes = readExactBounded(fd, opened.size, max, 'private-owned-read');
    const afterFd = fs.fstatSync(fd), after = fs.lstatSync(file);
    need(sameFileSnapshot(opened, afterFd) && sameFileSnapshot(before, after)
      && after.dev === opened.dev && after.ino === opened.ino
      && bytes.length === before.size, 'private-owned-change');
    return { bytes, ref: { path: file, sha256: hash(bytes) } };
  } finally { fs.closeSync(fd); }
}

function sourceRead(file, expectedSha, max = 64 * 1024 * 1024) {
  need(Number.isInteger(fs.constants.O_NOFOLLOW) && path.isAbsolute(file) && path.resolve(file) === file,
    'source-read-path');
  const rootReal = fs.realpathSync(ROOT), before = fs.lstatSync(file);
  need(before.isFile() && !before.isSymbolicLink() && before.size <= max, 'source-read-file');
  for (let p = file; p !== path.dirname(p); p = path.dirname(p))
    need(!fs.lstatSync(p).isSymbolicLink(), 'source-read-ancestor');
  need(fs.realpathSync(file).startsWith(rootReal + path.sep), 'source-read-scope');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    need(sameFileSnapshot(before, opened), 'source-read-race');
    const bytes = readExactBounded(fd, opened.size, max, 'source-read');
    const afterFd = fs.fstatSync(fd), after = fs.lstatSync(file);
    need(sameFileSnapshot(opened, afterFd) && sameFileSnapshot(before, after)
      && after.dev === opened.dev && after.ino === opened.ino && bytes.length === before.size
      && hash(bytes) === expectedSha, 'source-read-change-or-hash');
    return bytes;
  } finally { fs.closeSync(fd); }
}

function parseObserverKubeconfig(text, expectedCaData) {
  const value = yamlLoad(text);
  const keyset = (object, names) => object && typeof object === 'object' && !Array.isArray(object)
    && Object.keys(object).sort().join(',') === [...names].sort().join(',');
  need(keyset(value, ['apiVersion','kind','clusters','contexts','current-context','users','preferences'])
    && value.apiVersion === 'v1' && value.kind === 'Config' && value['current-context'] === 'kind-zenith-j2'
    && Array.isArray(value.clusters) && value.clusters.length === 1
    && Array.isArray(value.contexts) && value.contexts.length === 1
    && Array.isArray(value.users) && value.users.length === 1
    && keyset(value.preferences, []), 'observer-kubeconfig-root');
  const clusterEntry = value.clusters[0], contextEntry = value.contexts[0], userEntry = value.users[0];
  need(keyset(clusterEntry, ['name','cluster']) && clusterEntry.name === 'kind-zenith-j2'
    && keyset(clusterEntry.cluster, ['server','certificate-authority-data'])
    && clusterEntry.cluster['certificate-authority-data'] === expectedCaData
    && /^https:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(clusterEntry.cluster.server)
    && Number(clusterEntry.cluster.server.slice(clusterEntry.cluster.server.lastIndexOf(':') + 1)) <= 65535,
    'observer-kubeconfig-cluster');
  need(keyset(contextEntry, ['name','context']) && contextEntry.name === 'kind-zenith-j2'
    && keyset(contextEntry.context, ['cluster','user']) && contextEntry.context.cluster === clusterEntry.name
    && typeof contextEntry.context.user === 'string' && contextEntry.context.user.length > 0,
    'observer-kubeconfig-context');
  need(keyset(userEntry, ['name','user']) && userEntry.name === contextEntry.context.user
    && keyset(userEntry.user, ['client-certificate-data','client-key-data'])
    && [userEntry.user['client-certificate-data'], userEntry.user['client-key-data']].every(value =>
      typeof value === 'string' && value.length > 0
      && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)),
    'observer-kubeconfig-client-identity');
  return { caData: clusterEntry.cluster['certificate-authority-data'], server: clusterEntry.cluster.server };
}

function writePrivateExclusive(root, name, value) {
  need(Number.isInteger(fs.constants.O_NOFOLLOW), 'nofollow-unavailable');
  const file = path.join(root, name), bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const stat = fs.lstatSync(file);
  need(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid()
    && (stat.mode & 0o777) === 0o600 && stat.nlink === 1, 'private-write-identity');
  return { path: file, sha256: hash(bytes) };
}

function verifyBinding(binding, privateRoot) {
  const { bindingSha256, ...withoutDigest } = binding ?? {};
  need(exactKeys(binding, ['schemaVersion','kind','runId','source','r16SourceFreezeSha256','evidence','r9',
    'cleanupEpoch','privateDir','apiOrigin','supabaseOrigin','runtime','bindingSha256'])
    && exactKeys(binding.source, ['head','contentSha256','dirty'])
    && exactKeys(binding.evidence, ['r16Summary','r16Execution','witnessR10'])
    && exactKeys(binding.r9, ['privateRuntime','stackDirectory','joined','state','ownership','preapi','prestart','completion','readiness'])
    && exactKeys(binding.runtime, ['installationId','applicationInstallationId','supabaseProjectId','applicationProjectName',
      'apiContainerId','databaseContainerId','workerContainerId','apiOwnerLabels','databaseOwnerLabels','workerOwnerLabels',
      'databaseIdentitySha256','apiEnvironment','workerEnvironment','hostEnvironment'])
    && binding.schemaVersion === 1 && binding.kind === 'j4_fixture_binding'
    && /^[a-z0-9][a-z0-9-]{3,19}$/.test(binding.runId ?? '') && binding.source?.dirty === false
    && /^[a-f0-9]{40}$/.test(binding.source.head ?? '') && SHA256.test(binding.source.contentSha256 ?? '')
    && SHA256.test(binding.r16SourceFreezeSha256 ?? '') && SHA256.test(bindingSha256 ?? '')
    && typeof binding.cleanupEpoch === 'string' && Number.isFinite(Date.parse(binding.cleanupEpoch))
    && /^http:\/\/(127\.0\.0\.1|localhost)(:[0-9]+)?$/.test(binding.apiOrigin ?? '')
    && /^https:\/\/(supabase\.localhost|localhost|127\.0\.0\.1)(:[0-9]+)?$/.test(binding.supabaseOrigin ?? '')
    && ['apiContainerId','databaseContainerId','workerContainerId'].every(key => /^[a-f0-9]{64}$/.test(binding.runtime[key] ?? ''))
    && SHA256.test(binding.runtime.databaseIdentitySha256 ?? '')
    && canonicalHash(withoutDigest) === bindingSha256, 'binding-shape-or-digest');
  need(binding.r9?.privateRuntime === privateRoot
    && binding.privateDir === path.resolve(privateRoot, 'signed-delivery'), 'binding-private-dir-relationship');
  for (const ref of [binding.evidence.r16Summary, binding.evidence.r16Execution, binding.evidence.witnessR10,
    binding.r9.joined, binding.r9.state, binding.r9.ownership, binding.r9.preapi, binding.r9.prestart,
    binding.r9.completion, binding.r9.readiness, binding.runtime.apiEnvironment, binding.runtime.workerEnvironment,
    binding.runtime.hostEnvironment])
    need(exactKeys(ref, ['path','sha256']) && path.isAbsolute(ref.path) && SHA256.test(ref.sha256 ?? ''), 'binding-file-ref');
  for (const labels of [binding.runtime.apiOwnerLabels, binding.runtime.databaseOwnerLabels, binding.runtime.workerOwnerLabels])
    need(exactKeys(labels, Object.keys(labels ?? {})) && Object.keys(labels).length > 0
      && Object.values(labels).every(value => typeof value === 'string'), 'binding-owner-labels');
  const info = fs.lstatSync(binding.privateDir);
  need(info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid()
    && (info.mode & 0o777) === 0o700, 'binding-private-dir-owner-mode');
  return binding;
}

function verifyCoordinatorPin(binding, pin) {
  const r9Fields = ['joined','state','ownership','preapi','prestart','completion','readiness'];
  const evidenceFields = ['r16Summary','r16Execution','witnessR10'];
  const runtimeFields = ['installationId','applicationInstallationId','supabaseProjectId','apiContainerId',
    'databaseContainerId','workerContainerId','databaseIdentitySha256'];
  const expected = {
    schemaVersion: 1, kind: 'j4_verified_coordinator_pin', source: binding.source,
    r16SourceFreezeSha256: binding.r16SourceFreezeSha256, bindingSha256: binding.bindingSha256,
    cleanupEpoch: binding.cleanupEpoch,
    r9FileSha256: Object.fromEntries(r9Fields.map(key => [key, binding.r9[key]?.sha256])),
    evidenceSha256: Object.fromEntries(evidenceFields.map(key => [key, binding.evidence[key]?.sha256])),
    runtimeIds: Object.fromEntries(runtimeFields.map(key => [key, binding.runtime[key]])),
  };
  need(pin && Object.keys(pin).sort().join(',') === Object.keys(expected).sort().join(',')
    && canonicalHash(pin) === canonicalHash(expected), 'verified-coordinator-pin');
  return pin;
}

function exactReceipt(ref, binding, expected) {
  const bytes = privateRead(ref.path, ref.sha256, binding.privateDir);
  const doc = JSON.parse(bytes.toString('utf8'));
  need(doc.runId === binding.runId && doc.bindingSha256 === binding.bindingSha256, 'phase-receipt-binding');
  for (const [key, value] of Object.entries(expected)) need(doc[key] === value, `phase-receipt-${key}`);
  return hash(bytes);
}

function verifyTargetFacts(target, binding) {
  need(target?.schemaVersion === 1 && target.kind === 'j4_target_facts'
    && target.runId === binding.runId && target.bindingSha256 === binding.bindingSha256
    && target.createdAfterEpoch === true && target.address === 'service/witness'
    && Date.parse(target.environmentCreatedAt) > Date.parse(binding.cleanupEpoch)
    && Date.parse(target.resourceCreatedAt) > Date.parse(binding.cleanupEpoch)
    && SHA256.test(target.resourceReadbackSha256 ?? ''), 'target-facts');
  const bytes = privateRead(target.ownerReceipt.path, target.ownerReceipt.sha256, binding.privateDir);
  const owner = JSON.parse(bytes.toString('utf8'));
  need(exactKeys(owner, ['schemaVersion','kind','runId','bindingSha256','source','r16SourceFreezeSha256',
    'cleanupEpoch','target','resource','timestamps','readbacks','cleanupOwner','credentials'])
    && owner.schemaVersion === 1 && owner.kind === 'j4_target_owner_receipt'
    && owner.runId === binding.runId && owner.bindingSha256 === binding.bindingSha256
    && canonicalHash(owner.source) === canonicalHash(binding.source)
    && owner.r16SourceFreezeSha256 === binding.r16SourceFreezeSha256
    && owner.cleanupEpoch === binding.cleanupEpoch, 'target-owner-receipt-binding');
  need(exactKeys(owner.target, ['workspaceId','projectId','environmentId','resourceId','address',
    'connectionId','deploymentId','operationId'])
    && owner.target.workspaceId === target.workspaceId && owner.target.projectId === target.projectId
    && owner.target.environmentId === target.environmentId && owner.target.resourceId === target.resourceId
    && owner.target.address === target.address && typeof owner.target.connectionId === 'string'
    && owner.target.connectionId.length > 0 && owner.target.deploymentId === target.deploymentId
    && owner.target.operationId === target.operationId, 'target-owner-receipt-identities');
  need(exactKeys(owner.resource, ['provider','kind','nativeType','ownership','status','revisionId'])
    && owner.resource.provider === 'kubernetes' && owner.resource.kind === 'container_service'
    && owner.resource.nativeType === 'k8s:Deployment' && owner.resource.ownership === 'managed'
    && owner.resource.status === 'active' && typeof owner.resource.revisionId === 'string'
    && owner.resource.revisionId.length > 0, 'target-owner-receipt-resource');
  need(exactKeys(owner.timestamps, ['environmentCreatedAt','resourceCreatedAt','createdAfterEpoch'])
    && owner.timestamps.environmentCreatedAt === target.environmentCreatedAt
    && owner.timestamps.resourceCreatedAt === target.resourceCreatedAt
    && owner.timestamps.createdAfterEpoch === true, 'target-owner-receipt-timestamps');
  need(exactKeys(owner.readbacks, ['runtimeOwnershipSha256','kindBindingSha256','connectionSha256',
    'deploymentSha256','resourceReadbackSha256'])
    && ['runtimeOwnershipSha256','kindBindingSha256','connectionSha256','deploymentSha256','resourceReadbackSha256']
      .every(key => SHA256.test(owner.readbacks[key] ?? ''))
    && owner.readbacks.resourceReadbackSha256 === target.resourceReadbackSha256, 'target-owner-receipt-readbacks');
  need(owner.cleanupOwner === 'j4-orchestrator-retain-until-joined-settlement'
    && owner.credentials === 'not-included', 'target-owner-receipt-retention');
  const sha = hash(bytes);
  return sha;
}

function verifyAuthFacts(auth, binding, coordinatorPin) {
  const facts = auth?.authOwnerFacts, context = auth?.actualBrowserContext;
  need(facts?.schemaVersion === 1 && facts.kind === 'j4_auth_owner_facts'
    && facts.runId === binding.runId && facts.bindingSha256 === binding.bindingSha256
    && facts.coordinatorPinSha256 === canonicalHash(coordinatorPin)
    && canonicalHash(facts.source) === canonicalHash(binding.source)
    && facts.r16SourceFreezeSha256 === binding.r16SourceFreezeSha256
    && facts.cleanupEpoch === binding.cleanupEpoch && facts.apiOrigin === binding.apiOrigin
    && facts.supabaseOrigin === binding.supabaseOrigin
    && typeof facts.requesterUserId === 'string' && facts.requesterUserId.length > 0
    && typeof facts.approverUserId === 'string' && facts.approverUserId.length > 0
    && facts.requesterUserId !== facts.approverUserId
    && facts.requesterPasswordSession === 'observed' && facts.approverPasswordSession === 'observed'
    && facts.requesterMfaServerProof === 'observed' && facts.approverMfaServerProof === 'observed'
    && exactKeys(facts.browser, ['playwrightVersion','chromiumRevision','chromiumVersion','executablePath'])
    && ['playwrightVersion','chromiumRevision','chromiumVersion','executablePath'].every(key =>
      typeof facts.browser[key] === 'string' && facts.browser[key].length > 0)
    && exactKeys(facts.ownership, ['userIds','browserContexts','custodyMarker','cleanup'])
    && Array.isArray(facts.ownership.userIds) && facts.ownership.userIds.length === 2
    && facts.ownership.userIds.includes(facts.requesterUserId) && facts.ownership.userIds.includes(facts.approverUserId)
    && facts.ownership.browserContexts === 2 && facts.ownership.cleanup === 'outer-r17-owner'
    && context?.requesterUserId === facts.requesterUserId && context?.approverUserId === facts.approverUserId
    && context?.requesterPage && context?.approverPage && context?.requesterContext
    && context?.approverContext && context?.browser, 'auth-owner-facts');
  const bytes = privateRead(facts.ownerReceipt.path, facts.ownerReceipt.sha256, binding.privateDir);
  const { ownerReceipt: _ownerReceipt, ...receiptFacts } = facts;
  need(canonicalHash(JSON.parse(bytes.toString('utf8'))) === canonicalHash(receiptFacts), 'auth-owner-receipt-facts');
  return hash(bytes);
}

function verifyConsentFacts(consent, target, auth, binding, coordinatorPin) {
  need(consent?.schemaVersion === 1 && consent.kind === 'j4_consent_facts'
    && consent.runId === binding.runId && consent.bindingSha256 === binding.bindingSha256
    && consent.workspaceId === target.workspaceId && consent.environmentId === target.environmentId
    && consent.resourceId === target.resourceId && consent.address === target.address
    && consent.actorUserId === auth.authOwnerFacts.requesterUserId && consent.actorRole === 'admin'
    && consent.responseStatus === 201 && consent.shownOnce === true && consent.registration === 'not_created'
    && SHA256.test(consent.requestSha256 ?? '') && Date.parse(consent.expiresAt) > Date.now()
    && Date.parse(consent.expiresAt) <= Date.now() + 90_000, 'consent-facts');
  const expectedRequestSha = canonicalHash({ kind: 'machine', ttlMinutes: 1,
    binding: { environmentId: target.environmentId, address: target.address } });
  need(consent.requestSha256 === expectedRequestSha, 'consent-request-digest');
  const receiptBytes = privateRead(consent.ownerReceipt.path, consent.ownerReceipt.sha256, binding.privateDir);
  const receipt = JSON.parse(receiptBytes.toString('utf8'));
  const expectedKeys = ['schemaVersion','kind','runId','bindingSha256','workspaceId','environmentId','resourceId',
    'address','actorUserId','actorRole','requestSha256','responseStatus','shownOnce','expiresAt','registration',
    'cookieFile','issuanceIntent','targetOwnerReceipt','authOwnerReceipt','coordinatorPinSha256','actualReadbacks',
    'secrets','cleanup'];
  need(receipt && typeof receipt === 'object' && !Array.isArray(receipt)
    && Object.keys(receipt).sort().join(',') === expectedKeys.sort().join(','), 'consent-owner-receipt-keyset');
  for (const key of ['schemaVersion','kind','runId','bindingSha256','workspaceId','environmentId','resourceId',
    'address','actorUserId','actorRole','requestSha256','responseStatus','shownOnce','expiresAt','registration','cookieFile'])
    need(canonicalHash(receipt[key]) === canonicalHash(consent[key]), `consent-owner-receipt-${key}`);
  need(receipt.coordinatorPinSha256 === canonicalHash(coordinatorPin)
    && canonicalHash(receipt.targetOwnerReceipt) === canonicalHash(target.ownerReceipt)
    && canonicalHash(receipt.authOwnerReceipt) === canonicalHash(auth.authOwnerFacts.ownerReceipt)
    && receipt.actualReadbacks?.workspaceAdmin === true && receipt.actualReadbacks?.membershipAdmin === true
    && receipt.actualReadbacks?.environmentProjectJoin === true
    && receipt.actualReadbacks?.environmentCreatedAfterEpoch === true
    && receipt.actualReadbacks?.resourceCreatedAfterEpoch === true
    && receipt.actualReadbacks?.sameOriginConsent === true
    && receipt.actualReadbacks?.routeBindingEchoed === false
    && receipt.secrets === 'not_recorded' && receipt.cleanup === 'owned-by-outer-r17-child', 'consent-owner-receipt-joins');
  const intentBytes = privateRead(receipt.issuanceIntent.path, receipt.issuanceIntent.sha256, binding.privateDir);
  const intent = JSON.parse(intentBytes.toString('utf8'));
  need(exactKeys(intent, ['schemaVersion','kind','runId','bindingSha256','coordinatorPinSha256','target',
    'requestSha256','cookieFile','status','disposition'])
    && exactKeys(intent.target, ['workspaceId','projectId','environmentId','resourceId','address'])
    && intent.schemaVersion === 1 && intent.kind === 'j4_consent_issuance_intent'
    && intent.runId === binding.runId && intent.bindingSha256 === binding.bindingSha256
    && intent.coordinatorPinSha256 === canonicalHash(coordinatorPin)
    && canonicalHash(intent.target) === canonicalHash({ workspaceId: target.workspaceId,
      projectId: target.projectId, environmentId: target.environmentId, resourceId: target.resourceId, address: target.address })
    && intent.requestSha256 === consent.requestSha256
    && canonicalHash(intent.cookieFile) === canonicalHash(consent.cookieFile)
    && intent.status === 'issuance_unconfirmed'
    && intent.disposition === 'outer-r17-retain-until-settled', 'consent-issuance-intent');
  privateRead(consent.cookieFile.path, consent.cookieFile.sha256, binding.privateDir);
  return hash(receiptBytes);
}

function verifyImageManifest(binding, manifestRef) {
  const manifestBytes = privateRead(manifestRef.path, manifestRef.sha256, binding.privateDir);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  need(exactKeys(manifest, ['schemaVersion','kind','status','runId','bindingSha256','source',
    'r16SourceFreezeSha256','buildContextMode','buildContextSha256','dockerfile','buildInputs',
    'buildInputsSha256','artifact'])
    && exactKeys(manifest.source, ['head','contentSha256','dirty'])
    && exactKeys(manifest.dockerfile, ['path','sha256'])
    && exactKeys(manifest.artifact, ['architecture','imageId','imageReference','binarySha256'])
    && manifest.schemaVersion === 1 && manifest.kind === 'j4_agent_source_image'
    && manifest.status === 'observed' && manifest.runId === binding.runId
    && manifest.bindingSha256 === binding.bindingSha256
    && manifest.source?.head === binding.source.head
    && manifest.source?.contentSha256 === binding.source.contentSha256
    && manifest.source?.dirty === false
    && manifest.r16SourceFreezeSha256 === binding.r16SourceFreezeSha256
    && manifest.buildContextMode === 'full-verified-source-freeze'
    && manifest.buildContextSha256 === binding.source.contentSha256
    && manifest.dockerfile?.path === path.join(ROOT, 'tests/e2e/default/zenithd.Dockerfile')
    && SHA256.test(manifest.dockerfile.sha256 ?? '')
    && Array.isArray(manifest.buildInputs) && manifest.buildInputs.length > 0
    && SHA256.test(manifest.buildInputsSha256 ?? '')
    && manifest.artifact?.architecture === 'arm64'
    && /^sha256:[a-f0-9]{64}$/.test(manifest.artifact.imageId ?? '')
    && /^[A-Za-z0-9][A-Za-z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(manifest.artifact.imageReference ?? '')
    && SHA256.test(manifest.artifact.binarySha256 ?? ''), 'source-image-manifest-join');
  need(canonicalHash(manifest.buildInputs) === manifest.buildInputsSha256, 'source-image-input-inventory-hash');
  for (const input of manifest.buildInputs) {
    need(exactKeys(input, ['path','sha256']) && path.isAbsolute(input.path) && input.path.startsWith(`${ROOT}${path.sep}`)
      && SHA256.test(input.sha256 ?? ''), 'source-image-input-ref');
    sourceRead(input.path, input.sha256);
  }
  need(manifest.buildInputs.some(input => input.path === manifest.dockerfile.path
    && input.sha256 === manifest.dockerfile.sha256), 'source-image-dockerfile-in-inventory');
  return manifest.artifact;
}

async function verifyCachedSourceImage(image) {
  const rows = JSON.parse(await docker(['image', 'inspect', image.imageReference], { maxBytes: 128 * 1024 }));
  need(Array.isArray(rows) && rows.length === 1 && rows[0].Id === image.imageId
    && rows[0].Architecture === image.architecture && rows[0].RepoDigests?.includes(image.imageReference),
    'source-image-cache-identity');
}

function verifyAgentFacts(agent, target, consent, binding, image) {
  need(agent?.schemaVersion === 1 && agent.kind === 'j4_agent_facts'
    && agent.runId === binding.runId && agent.bindingSha256 === binding.bindingSha256
    && agent.workspaceId === target.workspaceId && agent.environmentId === target.environmentId
    && agent.resourceId === target.resourceId && agent.address === target.address
    && agent.requestSha256 === consent.requestSha256
    && agent.machineId && agent.machineName && agent.transport === 'zenithd'
    && agent.status === 'active' && agent.stale === false
    && Array.isArray(agent.capabilities) && agent.capabilities.includes('machine.inspect')
    && !agent.capabilities.includes('machine.exec') && !agent.capabilities.includes('container.exec')
    && agent.registration?.tokenConsumed === true && agent.registration?.usedByMachineId === agent.machineId
    && agent.registration?.bindingMatched === true
    && agent.native?.image === image.imageReference && agent.native?.imageId === image.imageId
    && agent.native?.architecture === image.architecture && agent.native?.binarySha256 === image.binarySha256
    && SHA256.test(agent.native?.configSha256 ?? '') && SHA256.test(agent.native?.actualConfigSha256 ?? '')
    && SHA256.test(agent.native?.containerId ?? '') && SHA256.test(agent.apiReadbackSha256 ?? '')
    && SHA256.test(agent.databaseReadbackSha256 ?? ''), 'agent-facts');
  exactReceipt(agent.ownerReceipt, binding, {
    machineId: agent.machineId, workspaceId: target.workspaceId,
    environmentId: target.environmentId, resourceId: target.resourceId,
    requestSha256: consent.requestSha256,
  });
}

async function prepareOwnedKind(binding, hostEnv, planRef) {
  const bytes = privateRead(planRef.path, planRef.sha256, binding.privateDir);
  const plan = JSON.parse(bytes.toString('utf8'));
  need(exactKeys(plan, ['schemaVersion','kind','status','runId','bindingSha256','source','r16SourceFreezeSha256',
    'kindConfigSha256','nodeImage','nodeImageId','witnessImage','witnessImageId'])
    && exactKeys(plan.source, ['head','contentSha256','dirty'])
    && plan.schemaVersion === 1 && plan.kind === 'j4_local_kind_plan' && plan.status === 'approved_inputs'
    && plan.runId === binding.runId && plan.bindingSha256 === binding.bindingSha256
    && plan.source?.head === binding.source.head && plan.source?.contentSha256 === binding.source.contentSha256
    && plan.source?.dirty === false && plan.r16SourceFreezeSha256 === binding.r16SourceFreezeSha256
    && plan.kindConfigSha256 === hash(Buffer.from(KIND_YAML, 'utf8'))
    && /^.+@sha256:[a-f0-9]{64}$/.test(plan.nodeImage ?? '')
    && /^localhost:5000\/zenith-j2-witness@sha256:[a-f0-9]{64}$/.test(plan.witnessImage ?? '')
    && /^sha256:[a-f0-9]{64}$/.test(plan.nodeImageId ?? '')
    && /^sha256:[a-f0-9]{64}$/.test(plan.witnessImageId ?? ''), 'kind-plan-binding');
  const inspectImage = async (reference, id) => {
    const rows = JSON.parse(await docker(['image', 'inspect', reference], { maxBytes: 128 * 1024 }));
    need(Array.isArray(rows) && rows.length === 1 && rows[0].Id === id
      && rows[0].Architecture === 'arm64' && rows[0].RepoDigests?.includes(reference), 'kind-image-cache-or-identity');
    return rows[0];
  };
  await inspectImage(plan.nodeImage, plan.nodeImageId);
  await inspectImage(plan.witnessImage, plan.witnessImageId);
  const kindDir = path.join(binding.privateDir, 'kind');
  need(!fs.existsSync(kindDir), 'kind-directory-preexists');
  const configPath = path.join(binding.privateDir, 'kind.yaml');
  const configFd = fs.openSync(configPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(configFd, KIND_YAML); fs.fsyncSync(configFd); } finally { fs.closeSync(configFd); }
  const configStat = fs.lstatSync(configPath);
  need(configStat.isFile() && !configStat.isSymbolicLink() && configStat.uid === process.getuid()
    && (configStat.mode & 0o777) === 0o600 && hash(fs.readFileSync(configPath)) === plan.kindConfigSha256, 'kind-config-private');
  process.env.ZENITH_DEFAULT_JOURNEY = '1';
  const prepared = await prepareLocalKind(['--directory', kindDir, '--stack', binding.r9.stackDirectory,
    '--node-image', plan.nodeImage, '--witness-image', plan.witnessImage,
    '--mailpit-url', hostEnv.ZENITH_DEFAULT_MAILPIT_URL, '--isolated-kind-config', configPath]);
  need(prepared?.status === 'prepared' && prepared.productionReady === false, 'kind-prepare-result');
  const targetsPath = path.join(kindDir, 'targets.json'), journeyPath = path.join(kindDir, 'journey.json');
  const targetsRead = privateOwnedRead(targetsPath, kindDir), journeyRead = privateOwnedRead(journeyPath, kindDir);
  const targets = JSON.parse(targetsRead.bytes.toString('utf8')), journey = JSON.parse(journeyRead.bytes.toString('utf8'));
  need(targets.status === 'created' && targets.kind === 'zenith-j2' && targets.createdBy === 'J2-DEFAULT-JOURNEY'
    && /^[a-f0-9]{64}$/.test(targets.containerId ?? '') && /^[a-f0-9]{64}$/.test(targets.buildContainerId ?? '')
    && journey.stackDirectory === binding.r9.stackDirectory && journey.kind?.context === 'kind-zenith-j2'
    && journey.kind?.namespace === 'zenith-j2' && journey.kind?.server === 'https://zenith-j2-control-plane:6443'
    && journey.kind?.image === plan.witnessImage && journey.machine?.image === plan.witnessImage, 'kind-output-binding');
  const inspectContainer = async id => {
    const rows = JSON.parse(await docker(['inspect', id], { maxBytes: 128 * 1024 }));
    need(Array.isArray(rows) && rows.length === 1 && rows[0].Id === id && rows[0].State?.Running === true
      && rows[0].Config?.Labels?.['io.x-k8s.kind.cluster'] === 'zenith-j2', 'kind-container-live-owner');
    return rows[0];
  };
  const node = await inspectContainer(targets.containerId), worker = await inspectContainer(targets.buildContainerId);
  need(node.Name === '/zenith-j2-control-plane' && worker.Name === '/zenith-j2-worker', 'kind-container-names');
  const nodeImage = JSON.parse(await docker(['image', 'inspect', node.Image], { maxBytes: 128 * 1024 }))[0];
  const workerImage = JSON.parse(await docker(['image', 'inspect', worker.Image], { maxBytes: 128 * 1024 }))[0];
  need(nodeImage?.Architecture === 'arm64' && workerImage?.Architecture === 'arm64', 'kind-native-images');
  const kubeconfigFiles = { deployment: journey.kind.kubeconfigFile,
    rotation: journey.kind.rotationKubeconfigFile, observer: journey.kind.observerKubeconfigFile };
  const kubeconfigs = Object.fromEntries(Object.entries(kubeconfigFiles).map(([name, file]) =>
    [name, privateOwnedRead(file, kindDir)]));
  const parsedKubeconfigs = {
    deployment: kubeconfig(kubeconfigFiles.deployment, { kind: journey.kind }),
    rotation: kubeconfig(kubeconfigFiles.rotation, { kind: journey.kind }),
    observer: parseObserverKubeconfig(kubeconfigs.observer.bytes.toString('utf8').trim(),
      kubeconfig(kubeconfigFiles.deployment, { kind: journey.kind }).caData),
  };
  for (const name of ['deployment','rotation'])
    need(parsedKubeconfigs[name].text === kubeconfigs[name].bytes.toString('utf8').trim(), `kind-${name}-kubeconfig-parser-bytes`);
  need(parsedKubeconfigs.deployment.caData === parsedKubeconfigs.rotation.caData
    && parsedKubeconfigs.deployment.caData === parsedKubeconfigs.observer.caData
    && parsedKubeconfigs.rotation.text !== parsedKubeconfigs.deployment.text, 'kind-kubeconfig-set-join');
  const observerPath = journey.kind.observerKubeconfigFile;
  const actualKube = parsedKubeconfigs.deployment;
  const kubeconfigRefs = Object.fromEntries(Object.entries(kubeconfigs).map(([name, value]) => [name, value.ref]));
  const ownerLabels = { 'io.x-k8s.kind.cluster': 'zenith-j2' };
  need(node.Config.Image && worker.Config.Image, 'kind-container-image-labels');
  const ownerRecord = {
    schemaVersion: 1, kind: 'j4_owned_kind_fixture', status: 'observed', runId: binding.runId,
    bindingSha256: binding.bindingSha256, source: binding.source,
    r16SourceFreezeSha256: binding.r16SourceFreezeSha256,
    clusterName: 'zenith-j2', namespace: 'zenith-j2', server: 'https://zenith-j2-control-plane:6443',
    clusterContainerId: node.Id, controlPlaneContainerId: node.Id, buildContainerId: worker.Id,
    nodeImage: node.Config.Image, nodeImageId: node.Image, nodeArchitecture: nodeImage.Architecture,
    buildImage: worker.Config.Image, buildImageId: worker.Image, buildArchitecture: workerImage.Architecture,
    image: journey.kind.image, imageId: plan.witnessImageId, architecture: 'arm64',
    configSha256: plan.kindConfigSha256, context: journey.kind.context, caData: actualKube.caData,
    containerImages: { cluster: node.Config.Image, controlPlane: node.Config.Image, build: worker.Config.Image },
    controlPlaneOwnerLabels: ownerLabels, buildOwnerLabels: ownerLabels,
    kubeconfigs: kubeconfigRefs,
    targetPreparation: { targetsPath, journeyPath,
      targetsSha256: targetsRead.ref.sha256, journeySha256: journeyRead.ref.sha256 },
    cleanupOwner: 'j4-orchestrator-retain-until-explicit-exact-settlement',
  };
  const ownerReceiptRef = writePrivateExclusive(binding.privateDir, `j4-kind-${binding.runId}.private.json`, ownerRecord);
  const ownerReceipt = { ...ownerRecord, ...ownerReceiptRef };
  return { clusterName: 'zenith-j2', namespace: journey.kind.namespace, server: journey.kind.server,
    context: journey.kind.context, kubeconfigFile: journey.kind.kubeconfigFile,
    rotationKubeconfigFile: journey.kind.rotationKubeconfigFile, observerKubeconfigFile: observerPath,
    caData: actualKube.caData, image: journey.kind.image, clusterContainerId: node.Id,
    ownerReceipt };
}

function parseEnvironment(ref, binding) {
  const bytes = privateRead(ref.path, ref.sha256, binding.privateDir);
  const values = Object.create(null);
  for (const line of bytes.toString('utf8').split(/\r?\n/)) {
    if (!line) continue;
    const at = line.indexOf('=');
    need(at > 0, 'host-environment-format');
    const key = line.slice(0, at), value = line.slice(at + 1);
    need(/^[A-Z][A-Z0-9_]*$/.test(key) && !/[\r\n\0]/.test(value) && !(key in values), 'host-environment-entry');
    values[key] = value;
  }
  need(values.ZENITH_J4_API_ORIGIN === binding.apiOrigin
    && values.ZENITH_PLATFORM_DB_URL && values.SUPABASE_URL === binding.supabaseOrigin, 'host-environment-binding');
  return values;
}

function sanitizeCustody(error) {
  const a1 = error?.a1Custody;
  if (a1 && typeof a1 === 'object') {
    if ('issuanceStatus' in a1 || 'issuanceIntent' in a1) return {
      owner: 'A1-consent', issuanceStatus: a1.issuanceStatus ?? 'issuance_unconfirmed',
      issuanceIntent: a1.issuanceIntent ?? null, tokenHandleObserved: Boolean(a1.privateTokenHandle),
      tokenJoin: a1.tokenJoin ?? null, cookieFile: a1.cookieFile ?? null,
      runId: a1.runId ?? null, bindingSha256: a1.bindingSha256 ?? null,
      retention: a1.retention ?? 'retain-until-expiry-and-exact-database-reconciliation',
    };
    return { owner: 'A1-auth', userIds: Array.isArray(a1.userIds) ? a1.userIds.filter(x => typeof x === 'string') : [],
      custodyMarker: a1.custodyMarker ?? null, authCreationMayBeUncertain: a1.authCreationMayBeUncertain === true,
      cleanup: a1.cleanup ?? 'retain-until-exact-settlement' };
  }
  const life = error?.lifecycleHandle;
  if (life && typeof life === 'object' && life.partialTarget && typeof life.partialTarget === 'object') return {
    owner: 'A2-target', status: life.status ?? 'failed_retained_uncertain',
    phase: life.cleanupBlockedAtStep ?? error.lifecyclePhase ?? 'unknown', cleanupBlocked: life.cleanupBlocked === true,
    targetIds: Object.fromEntries(['workspaceId','projectId','environmentId','resourceId','connectionId','deploymentId','operationId']
      .filter(key => typeof life.partialTarget[key] === 'string').map(key => [key, life.partialTarget[key]])),
    ownedRuntime: life.ownedRuntime ?? null,
  };
  if (life && typeof life === 'object') return { owner: 'B-agent', phase: error.lifecyclePhase ?? 'unknown',
    startupUncertain: life.startupUncertain ?? true, freshTokenState: life.freshTokenState ?? 'unknown',
    intents: Array.isArray(life.intents) ? life.intents.filter(item => item && ['container','volume'].includes(item.kind)
      && typeof item.id === 'string').map(item => ({ kind: item.kind, id: item.id })) : [],
    machineId: typeof life.id === 'string' ? life.id : null };
  return null;
}

function consentResultCustody(consent, binding) {
  const facts = consent?.consentFacts;
  if (!facts || typeof facts !== 'object') return null;
  let issuanceIntent = null, ownerReceiptReadback = 'unavailable';
  try {
    const bytes = privateRead(facts.ownerReceipt.path, facts.ownerReceipt.sha256, binding.privateDir);
    const body = JSON.parse(bytes.toString('utf8'));
    if (body.runId === binding.runId && body.bindingSha256 === binding.bindingSha256
        && body.issuanceIntent && typeof body.issuanceIntent.path === 'string'
        && SHA256.test(body.issuanceIntent.sha256 ?? '')) {
      issuanceIntent = body.issuanceIntent;
      ownerReceiptReadback = 'verified';
    } else ownerReceiptReadback = 'binding-mismatch';
  } catch { ownerReceiptReadback = 'unavailable-or-invalid'; }
  return { owner: 'A1-consent-result', issuanceStatus: facts.responseStatus === 201
      ? 'response_observed_201' : 'issuance_unconfirmed', tokenHandleObserved: Boolean(consent.privateTokenHandle),
    issuanceIntent, ownerReceipt: facts.ownerReceipt ?? null, ownerReceiptReadback, cookieFile: facts.cookieFile ?? null,
    tokenJoin: { runId: binding.runId, bindingSha256: binding.bindingSha256,
      workspaceId: facts.workspaceId ?? null, environmentId: facts.environmentId ?? null,
      address: facts.address ?? null, expiresAt: facts.expiresAt ?? null },
    retention: 'outer-r17-retain-until-token-consumed-or-expiry-and-owner-reconciliation' };
}

function replaceProcessEnvironment(hostEnv) {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, FIXED_ENV, hostEnv, { PATH: FIXED_ENV.PATH, ZENITH_DEFAULT_JOURNEY: '1' });
}

async function runFixed(label, argv, env, runtime, recordCommand) {
  const dir = path.join(runtime, `command-${label}`);
  fs.mkdirSync(dir, { mode: 0o700 });
  const dirStat = fs.lstatSync(dir);
  need(dirStat.isDirectory() && !dirStat.isSymbolicLink() && dirStat.uid === process.getuid()
    && (dirStat.mode & 0o777) === 0o700, 'command-log-directory');
  const maxBytes = 16 * 1024 * 1024;
  const stdoutPath = path.join(dir, 'stdout.private'), stderrPath = path.join(dir, 'stderr.private');
  const out = fs.openSync(stdoutPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY
    | fs.constants.O_NOFOLLOW, 0o600);
  const err = fs.openSync(stderrPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY
    | fs.constants.O_NOFOLLOW, 0o600);
  let outcome, overflow = false;
  const drainBounded = (stream, fd) => {
    let saved = 0;
    stream.on('data', chunk => {
      const allowance = Math.max(0, maxBytes - saved), count = Math.min(allowance, chunk.length);
      let offset = 0;
      while (offset < count) offset += fs.writeSync(fd, chunk, offset, count - offset);
      saved += count;
      if (count !== chunk.length) overflow = true;
    });
  };
  try {
    outcome = await new Promise(resolve => {
      const child = spawn(argv[0], argv.slice(1), { cwd: ROOT, env, shell: false,
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      drainBounded(child.stdout, out); drainBounded(child.stderr, err);
      let spawnError = false;
      child.once('error', () => { spawnError = true; });
      child.once('close', (status, signal) => resolve({ status, signal, spawnError }));
    });
  } finally { fs.fsyncSync(out); fs.fsyncSync(err); fs.closeSync(out); fs.closeSync(err); }
  const stdout = privateOwnedRead(stdoutPath, runtime, [0o600], maxBytes);
  const stderr = privateOwnedRead(stderrPath, runtime, [0o600], maxBytes);
  const record = { label, returncode: Number.isInteger(outcome?.status) ? outcome.status : null,
    signal: outcome?.signal ?? null, spawnError: outcome?.spawnError === true, outputOverflow: overflow,
    stdoutPath, stdoutSha256: stdout.ref.sha256, stderrPath, stderrSha256: stderr.ref.sha256,
    maxBytesPerStream: maxBytes };
  if (typeof recordCommand === 'function') recordCommand(record);
  need(!overflow, `${label}-output-limit`);
  need(!record.spawnError && !record.signal && record.returncode === 0, `${label}-nonzero-or-signaled`);
  return record;
}

async function main() {
  need(process.argv.length === 2, 'unexpected-arguments');
  const invocationPath = process.env.ZENITH_J4_INVOCATION_FILE;
  need(typeof invocationPath === 'string' && path.isAbsolute(invocationPath), 'invocation-file-required');
  const invocationSha = process.env.ZENITH_J4_INVOCATION_SHA256;
  need(SHA256.test(invocationSha ?? ''), 'invocation-hash-required');
  const invocationBytes = privateRead(invocationPath, invocationSha, path.dirname(invocationPath));
  const invocation = JSON.parse(invocationBytes.toString('utf8'));
  need(invocation && typeof invocation === 'object' && !Array.isArray(invocation)
    && Object.keys(invocation).sort().join(',') ===
      'adapterPins,bindingSha256,coordinatorPin,imageManifestRef,kind,kindPlanRef,r9Binding,runId,schemaVersion',
    'invocation-keyset');
  const privateRoot = invocation?.r9Binding?.r9?.privateRuntime;
  need(typeof privateRoot === 'string' && path.isAbsolute(privateRoot), 'private-runtime-required');
  const binding = verifyBinding(invocation.r9Binding, privateRoot);
  const coordinatorPin = verifyCoordinatorPin(binding, invocation.coordinatorPin);
  need(invocation.kind === 'j4_fixture_invocation' && invocation.schemaVersion === 1
    && invocation.bindingSha256 === binding.bindingSha256
    && invocation.runId === binding.runId, 'invocation-binding');
  process.umask(0o077);
  const runtime = binding.privateDir;
  const marker = writePrivateExclusive(runtime, `j4-held-${binding.runId}.custody`, {
    schemaVersion: 1, kind: 'j4_fixture_custody_marker', runId: binding.runId,
    bindingSha256: binding.bindingSha256, status: 'in_progress', cleanup: 'retain_until_explicit_exact_settlement',
  });
  const receipts = { kind: 'j4_fixture_owner_receipt', schemaVersion: 1, runId: binding.runId,
    bindingSha256: binding.bindingSha256, status: 'in_progress', marker, phases: {}, commands: [],
    cleanup: { status: 'retained' } };
  const phaseRef = (name, body) => {
    const ref = writePrivateExclusive(runtime, `j4-held-${binding.runId}-${name}.private.json`, body);
    receipts.phases[name] = ref;
  };
  let auth, target, consent, machine, image;
  try {
    need(invocation.adapterPins && typeof invocation.adapterPins === 'object' && !Array.isArray(invocation.adapterPins)
      && Object.keys(invocation.adapterPins).sort().join(',') ===
        'agentModuleSha256,authModuleSha256,bindingSchemaSha256,targetModuleSha256'
      && invocation.adapterPins?.bindingSchemaSha256 === SCHEMA_SHA256
      && invocation.adapterPins?.targetModuleSha256 === TARGET_SHA256
      && invocation.adapterPins?.agentModuleSha256 === AGENT_SHA256
      && invocation.adapterPins?.authModuleSha256 === AUTH_SHA256, 'adapter-source-pins');
    need(path.dirname(fs.realpathSync(invocationPath)) === fs.realpathSync(binding.privateDir), 'invocation-private-dir');
    for (const key of ['imageManifestRef','kindPlanRef'])
      need(invocation[key] && typeof invocation[key] === 'object' && !Array.isArray(invocation[key])
        && Object.keys(invocation[key]).sort().join(',') === 'path,sha256'
        && path.isAbsolute(invocation[key].path) && SHA256.test(invocation[key].sha256 ?? ''),
        `invocation-${key}-shape`);
    const env = parseEnvironment(binding.runtime.hostEnvironment, binding);
    replaceProcessEnvironment(env);
    image = verifyImageManifest(binding, invocation.imageManifestRef);
    await verifyCachedSourceImage(image);
    const ownedLocalKindBinding = await prepareOwnedKind(binding, env, invocation.kindPlanRef);
    phaseRef('kind', { schemaVersion: 1, kind: 'j4_kind_phase', runId: binding.runId,
      bindingSha256: binding.bindingSha256, ownerReceipt: ownedLocalKindBinding.ownerReceipt,
      clusterContainerId: ownedLocalKindBinding.clusterContainerId, image: ownedLocalKindBinding.image });

    auth = await prepareAuthContext({ r9Binding: binding, coordinatorPin, privateDir: binding.privateDir });
    const authOwnerSha = verifyAuthFacts(auth, binding, coordinatorPin);
    phaseRef('auth', { schemaVersion: 1, kind: 'j4_auth_phase', runId: binding.runId,
      bindingSha256: binding.bindingSha256, authOwnerFacts: auth.authOwnerFacts,
      ownerReceiptSha256: authOwnerSha });

    target = await prepareTarget({ r9Binding: binding, actualBrowserContext: auth.actualBrowserContext,
      ownedLocalKindBinding });
    const targetOwnerSha = verifyTargetFacts(target.targetFacts, binding);
    phaseRef('target', { schemaVersion: 1, kind: 'j4_target_phase', runId: binding.runId,
      bindingSha256: binding.bindingSha256, facts: target.targetFacts, ownerReceiptSha256: targetOwnerSha });

    consent = await prepareConsent({ r9Binding: binding, coordinatorPin, page: auth.actualBrowserContext.requesterPage,
      authOwnerFacts: auth.authOwnerFacts, targetFacts: target.targetFacts });
    const consentOwnerSha = verifyConsentFacts(consent.consentFacts, target.targetFacts, auth, binding, coordinatorPin);
    phaseRef('consent', { schemaVersion: 1, kind: 'j4_consent_phase', runId: binding.runId,
      bindingSha256: binding.bindingSha256, facts: consent.consentFacts,
      ownerReceiptSha256: consentOwnerSha });

    try {
      machine = await startAgent({ r9Binding: binding, targetFacts: target.targetFacts,
        consentFacts: consent.consentFacts, privateTokenHandle: consent.privateTokenHandle,
        sourceBoundImage: image.imageReference });
    } catch (error) {
      machine = { lifecycleHandle: error?.lifecycleHandle };
      phaseRef('agent-failure', { schemaVersion: 1, kind: 'j4_agent_phase', runId: binding.runId,
        bindingSha256: binding.bindingSha256, status: 'incomplete-retain', phase: error?.lifecyclePhase ?? 'unknown',
        startupUncertain: machine.lifecycleHandle?.startupUncertain ?? true,
        freshTokenState: machine.lifecycleHandle?.freshTokenState ?? 'unknown' });
      throw error;
    }
    verifyAgentFacts(machine.agentFacts, target.targetFacts, consent.consentFacts, binding, image);
    need(machine.lifecycleHandle?.startupUncertain === false
      && machine.lifecycleHandle?.freshTokenState === 'consumed-confirmed', 'agent-cleanup-gate');
    phaseRef('agent', { schemaVersion: 1, kind: 'j4_agent_phase', runId: binding.runId,
      bindingSha256: binding.bindingSha256, facts: machine.agentFacts });

    const targetFile = path.join(runtime, 'target.json');
    const targetJson = { workspaceId: target.targetFacts.workspaceId,
      targetId: machine.agentFacts.machineId, environmentId: target.targetFacts.environmentId,
      resourceId: target.targetFacts.resourceId };
    need(Object.keys(targetJson).sort().join(',') === 'environmentId,resourceId,targetId,workspaceId', 'target-json-keyset');
    const targetRef = writePrivateExclusive(runtime, 'target.json', targetJson);
    const cookie = consent.consentFacts.cookieFile;
    privateRead(cookie.path, cookie.sha256, runtime);
    const report = path.join(runtime, `${CASE_ID}.json`);
    const testEnv = { LANG: 'C', LC_ALL: 'C', NODE_ENV: 'test',
      ZENITH_TEST_MAINTENANCE: '0', ZENITH_TEST_RUNBOOK_DELIVERY: '1',
      ZENITH_J4_API_ORIGIN: binding.apiOrigin, ZENITH_PLATFORM_DB_URL: env.ZENITH_PLATFORM_DB_URL,
      ZENITH_J4_BROWSER_COOKIE_FILE: cookie.path, ZENITH_J4_TARGET_FILE: targetFile };
    testEnv.PATH = '/usr/bin:/bin';
    phaseRef('acceptance-intent', { schemaVersion: 1, kind: 'j4_acceptance_phase', runId: binding.runId,
      bindingSha256: binding.bindingSha256, status: 'started', caseId: CASE_ID,
      testName: TEST_NAME, targetFile: targetRef, reportPath: report });
    const test = await runFixed('wave6-vitest', [process.execPath, 'node_modules/vitest/vitest.mjs', 'run',
      'tests/acceptance/maintenance-default.test.ts', `--testNamePattern=${TEST_NAME}`,
      '--no-file-parallelism', '--maxWorkers=2', '--reporter=json', `--outputFile=${report}`], testEnv, runtime,
      command => receipts.commands.push(command));
    const reportRead = privateOwnedRead(report, runtime, [0o600], 16 * 1024 * 1024);
    const reportBytes = reportRead.bytes;
    const gateEnv = { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', NODE_ENV: 'test' };
    const gate = await runFixed('wave6-case-verifier', [process.execPath, 'scripts/ci/wave6-gates.mjs',
      '--case', CASE_ID, '--report', report], gateEnv, runtime,
      command => receipts.commands.push(command));
    need(privateOwnedRead(report, runtime, [0o600], 16 * 1024 * 1024).ref.sha256 === reportRead.ref.sha256,
      'vitest-report-changed-after-verifier');
    phaseRef('acceptance', { schemaVersion: 1, kind: 'j4_acceptance_phase', runId: binding.runId,
      bindingSha256: binding.bindingSha256, status: 'passed', caseId: CASE_ID, testName: TEST_NAME,
      reportPath: report, reportSha256: hash(reportBytes), vitestCommand: test, verifierCommand: gate });

    // Revoke only the exact machine after the case verifier passed. Unknown
    // startup/token/revocation outcomes retain all owned resources and handles.
    await machine.lifecycleHandle.revokeOwnedMachines(auth.actualBrowserContext.requesterPage, target.targetFacts.workspaceId);
    await machine.lifecycleHandle.cleanup();
    await auth.actualBrowserContext.requesterContext.close();
    await auth.actualBrowserContext.approverContext.close();
    await auth.actualBrowserContext.browser.close();
    receipts.status = 'passed_retained_target_and_audit';
    receipts.cleanup = { status: 'agent_revoked_and_exact_machine_volumes_removed',
      authUsers: 'retained', workspaceProjectEnvironmentResource: 'retained_for_audit',
      browser: 'closed_after_verified_case' };
    phaseRef('terminal', { schemaVersion: 1, kind: 'j4_terminal_phase', runId: binding.runId,
      bindingSha256: binding.bindingSha256, status: receipts.status, cleanup: receipts.cleanup });
  } catch (error) {
    receipts.status = 'incomplete_retain';
    const rawCode = typeof error?.message === 'string' ? error.message : '';
    receipts.failureCode = /^j4-[a-z0-9:-]{1,120}$/.test(rawCode) ? rawCode : 'unexpected-error';
    receipts.cleanup = { status: 'retained_due_to_failure_or_uncertainty',
      machineStartupUncertain: machine?.lifecycleHandle?.startupUncertain ?? null,
      freshTokenState: machine?.lifecycleHandle?.freshTokenState ?? null };
    const custody = sanitizeCustody(error) ?? consentResultCustody(consent, binding);
    if (custody) receipts.cleanup.ownedFailureCustody = custody;
    try { phaseRef('failure', { schemaVersion: 1, kind: 'j4_terminal_phase', runId: binding.runId,
      bindingSha256: binding.bindingSha256, status: receipts.status, failureCode: receipts.failureCode,
      cleanup: receipts.cleanup }); } catch { /* preserve monotonic retention */ }
    process.exitCode = 2;
  } finally {
    // No recursive removal or guessed cleanup here. The R17 parent proves
    // process settlement; durable fixture cleanup is performed only by the
    // exact lifecycle gates above, otherwise this receipt remains retained.
    try { writePrivateExclusive(runtime, `j4-held-${binding.runId}-owner.private.json`, receipts); }
    catch { process.exitCode = 2; }
  }
}

await main();
