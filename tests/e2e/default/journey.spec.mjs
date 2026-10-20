import { chromium, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { receipt, writeReceipt } from './receipt.mjs';
import {
  Config, ensure, nonce, pause, privateFile, prerequisites, operator, localUrl,
  jsonRequest, browserRequest, ok, action, until, kubeconfig, linkedAgent, mcp,
  kindReadback, adminHeaders, command, docker, sha256,
} from './support.mjs';
import { Machine } from './engines.mjs';
import { enrollOperator } from './mfa.mjs';
import { UX_CASES, UX_TAGS, UX_VIEWPORTS, writeUxReceipt } from './ux-receipt.mjs';

const UX_ENABLED = process.env.ZENITH_UX01_BROWSER === '1';

async function auditUx(page, pageId, axeSource, scans) {
  for (const viewport of UX_VIEWPORTS) {
    await page.setViewportSize(viewport);
    if (!(await page.evaluate(() => Boolean(window.axe)))) await page.addScriptTag({ content: axeSource });
    const result = await page.evaluate(async tags => {
      const scan = await window.axe.run(document, { runOnly: { type: 'tag', values: tags } });
      return { violations: scan.violations.map(({ id, impact }) => ({ id, impact })),
        horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth };
    }, UX_TAGS);
    scans.push({ pageId, viewport: `${viewport.width}x${viewport.height}`, ...result });
    ensure(result.violations.length === 0 && !result.horizontalOverflow, 'ux01-a11y-scan');
  }
}

const canonicalJson = value => {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalJson(value[key])]));
  return value;
};
const sameJson = (left, right) => JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
const canonicalText = value => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(canonicalText).join(',') + ']';
  return '{' + Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => JSON.stringify(key) + ':' + canonicalText(item)).join(',') + '}';
};
const canonicalDigest = value => createHash('sha256').update(canonicalText(value)).digest('hex');
const exactObject = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');

function readUxExclusiveWindow({ stack, source, config }) {
  const file = process.env.ZENITH_UX01_EXCLUSIVE_WINDOW_FILE, expectedId = process.env.ZENITH_UX01_EXCLUSIVE_WINDOW_ID;
  ensure(typeof file === 'string' && path.isAbsolute(file) && typeof expectedId === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(expectedId), 'ux01-window-input');
  const resolved = path.resolve(file), parent = fs.lstatSync(path.dirname(resolved)), stat = fs.lstatSync(resolved);
  for (let current = resolved; current !== path.dirname(current); current = path.dirname(current))
    ensure(!fs.lstatSync(current).isSymbolicLink(), 'ux01-window-path-symlink');
  ensure(!resolved.startsWith(path.resolve('.') + path.sep) && parent.isDirectory() && !parent.isSymbolicLink() &&
    parent.uid === process.getuid() && (parent.mode & 0o777) === 0o700 && stat.isFile() && !stat.isSymbolicLink() &&
    stat.size >= 1 && stat.size <= 4096 && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o600, 'ux01-window-file-custody');
  const fd = fs.openSync(resolved, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const sameIdentity = (left, right) => left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mode === right.mode && left.uid === right.uid && left.nlink === right.nlink &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
  let bytes;
  try {
    const opened = fs.fstatSync(fd);
    ensure(opened.isFile() && opened.dev === stat.dev && opened.ino === stat.ino && opened.size >= 1 && opened.size <= 4096 &&
      opened.uid === process.getuid() && (opened.mode & 0o777) === 0o600 && sameIdentity(opened, stat), 'ux01-window-open-identity');
    const buffer = Buffer.alloc(4097), count = fs.readSync(fd, buffer, 0, buffer.length, 0);
    ensure(count === opened.size && count <= 4096, 'ux01-window-read-bound');
    const afterRead = fs.fstatSync(fd);
    ensure(sameIdentity(afterRead, opened), 'ux01-window-read-stable');
    const pathAfterRead = fs.lstatSync(resolved);
    ensure(pathAfterRead.isFile() && !pathAfterRead.isSymbolicLink() && sameIdentity(pathAfterRead, stat) &&
      sameIdentity(pathAfterRead, opened), 'ux01-window-path-read-stable');
    bytes = buffer.subarray(0, count);
  } finally { fs.closeSync(fd); }
  const window = JSON.parse(bytes.toString('utf8'));
  ensure(exactObject(window, ['schemaVersion','windowId','installationId','source','imageDigest','startedAt','expiresAt','issuer','creatorScope','otherCreators','inventory']) &&
    window.schemaVersion === 1 && window.windowId === expectedId && window.installationId === stack.state.installationId &&
    exactObject(window.source, ['commit','sourceDigest']) && window.source.commit === source.commit && window.source.sourceDigest === source.sourceDigest &&
    window.imageDigest === config.machine.image.split('@sha256:')[1] && window.issuer === 'root-orchestrator' &&
    window.creatorScope === 'J2-only' && window.otherCreators === 'paused', 'ux01-window-binding');
  const now = Date.now(), started = Date.parse(window.startedAt), expires = Date.parse(window.expiresAt);
  ensure(Number.isFinite(started) && Number.isFinite(expires) && new Date(started).toISOString() === window.startedAt &&
    new Date(expires).toISOString() === window.expiresAt && started <= now && now < expires && expires - started <= 3_600_000, 'ux01-window-time');
  const inventory = window.inventory, observed = Date.parse(inventory?.observedAt);
  ensure(exactObject(inventory, ['observedAt','claimableRunIds','activeScheduleIds','sha256']) &&
    Array.isArray(inventory.claimableRunIds) && inventory.claimableRunIds.length === 0 &&
    Array.isArray(inventory.activeScheduleIds) && inventory.activeScheduleIds.length === 0 &&
    Number.isFinite(observed) && new Date(observed).toISOString() === inventory.observedAt &&
    started <= observed && observed <= now && inventory.sha256 === canonicalDigest({ installationId: window.installationId,
      sourceDigest: source.sourceDigest, observedAt: inventory.observedAt, claimableRunIds: inventory.claimableRunIds, activeScheduleIds: inventory.activeScheduleIds }),
    'ux01-window-inventory');
  return { id: window.windowId, digest: createHash('sha256').update(bytes).digest('hex'), expiresAt: window.expiresAt, inventory: inventory.sha256 };
}

async function authenticateBeforeWorkspace(page, stack, user) {
  await page.goto(stack.apiUrl + '/login?next=/overview');
  await page.getByLabel('Email', { exact: true }).fill(user.email);
  await page.getByLabel('Password', { exact: true }).fill(user.password);
  const signedIn = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.origin === stack.supabaseUrl && url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'password';
  });
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const verified = await signedIn;
  ensure(verified.ok() && (await verified.json()).user?.id === user.id, 'real-auth-identity');
  await page.waitForURL(url => url.origin === stack.apiUrl && url.pathname !== '/login');
}

// Collection (--list) never reads a credential/config or starts an engine.
test.skip(process.env.ZENITH_DEFAULT_JOURNEY !== '1', 'needs ZENITH_DEFAULT_JOURNEY=1, J1 stack, Mailpit, kind and Chromium');

test('default operated browser, REST, MCP and customer machine journey', async ({ browser }) => {
  let source = {}, stack, config, a, b, machine, healthMachine, linked, runnerProcess, runnerId, runnerName, runnerServiceAccount, runnerConnectionId, runnerDir, runnerCustodyMarker, runnerCaseSucceeded = false, runnerSpawned = false, runnerSpawnError = false, runnerExited = false, runnerClosed = false, workspaceId, project, environmentId, healthResourceId;
  let uxBrowser, uxA, uxB, axeSource, uxApprovalRecorded = false, uxUncertaintyEvidence, uxOriginalWindow, uxStage = 'not-started', uxOuterCleanupComplete = false, uxFailureStage;
  const uxPrivateObservations = [];
  let uxPrivateObservationBytes = 0;
  const captureUxObservation = (name, value) => {
    ensure(UX_ENABLED && /^[a-z][a-z0-9.-]{0,63}$/.test(name) && uxPrivateObservations.length < 96, 'ux01-private-observation-bound');
    const encoded = JSON.stringify(value);
    ensure(typeof encoded === 'string' && encoded.length <= 24 * 1024 &&
      uxPrivateObservationBytes + encoded.length <= 128 * 1024, 'ux01-private-observation-size');
    const safe = JSON.parse(encoded);
    uxPrivateObservationBytes += encoded.length;
    uxPrivateObservations.push({ name, value: safe });
  };
  const markUxFailure = () => {
    uxFailureStage ??= uxStage;
    uxUncertaintyEvidence = null;
    const row = uxCases.find(value => value.id === 'ux01-uncertainty-a11y');
    if (row?.status === 'passed') row.status = 'failed';
  };
  const persistUxPrivateDocument = suffix => {
    const receiptPath = path.resolve(process.env.ZENITH_UX01_RECEIPT), privatePath = receiptPath + suffix;
    const parentPath = path.dirname(receiptPath), parent = fs.lstatSync(parentPath);
    const sameIdentity = (left, right) => left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
      left.mode === right.mode && left.uid === right.uid && left.nlink === right.nlink &&
      left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
    ensure(parent.isDirectory() && !parent.isSymbolicLink() && parent.uid === process.getuid() &&
      (parent.mode & 0o777) === 0o700 && path.dirname(privatePath) === parentPath && !fs.existsSync(privatePath), 'ux01-private-evidence-path');
    const snapshot = suffix.includes('snapshot');
    const document = { schemaVersion: 1, runId, phase: snapshot ? 'before-cleanup' : 'final',
      outcome: snapshot ? 'captured-before-cleanup' : uxStage === 'complete' && uxOuterCleanupComplete && !failed ? 'complete' : 'incomplete',
      failure: snapshot || uxStage === 'complete' && uxOuterCleanupComplete && !failed ? null : { stage: uxFailureStage ?? uxStage,
        caseStatus: 'failed', custodyOutstanding: Boolean(healthMachine?.uncertaintyCustody), originalWindow: uxOriginalWindow ?? null },
      observations: uxPrivateObservations };
    const encoded = Buffer.from(JSON.stringify(document, null, 2) + '\n');
    ensure(encoded.length <= 160 * 1024, 'ux01-private-evidence-total-bound');
    const fd = fs.openSync(privatePath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, encoded); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    // APFS counts a directory's entries in its link count, so the new file itself changes it: compare after the write.
    const parentAfterWrite = fs.lstatSync(parentPath);
    const written = fs.lstatSync(privatePath), readFd = fs.openSync(privatePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const opened = fs.fstatSync(readFd);
      ensure(written.isFile() && !written.isSymbolicLink() && written.uid === process.getuid() &&
        (written.mode & 0o777) === 0o600 && written.nlink === 1 && opened.dev === written.dev && opened.ino === written.ino &&
        opened.size === encoded.length && opened.nlink === 1 && sameIdentity(written, opened), 'ux01-private-evidence-readback-identity');
      const readback = Buffer.alloc(encoded.length + 1), count = fs.readSync(readFd, readback, 0, readback.length, 0);
      ensure(count === encoded.length && readback.subarray(0, count).equals(encoded), 'ux01-private-evidence-readback-bytes');
      const after = fs.fstatSync(readFd), currentPath = fs.lstatSync(privatePath);
      const currentParent = fs.lstatSync(parentPath);
      ensure(sameIdentity(after, opened) && sameIdentity(currentPath, opened) && currentPath.isFile() &&
        !currentPath.isSymbolicLink() && currentPath.uid === process.getuid() && (currentPath.mode & 0o777) === 0o600 &&
        currentParent.isDirectory() && !currentParent.isSymbolicLink() && currentParent.dev === parent.dev &&
        currentParent.ino === parent.ino && currentParent.uid === process.getuid() && (currentParent.mode & 0o777) === 0o700 &&
        currentParent.nlink === parentAfterWrite.nlink && parentAfterWrite.ino === parent.ino,
        'ux01-private-evidence-readback-stable');
    } finally { fs.closeSync(readFd); }
    return privatePath;
  };
  const users = [], facts = [], readbacks = {};
  const captureJob = job => job && ({ job: job.job, source: job.source, status: job.status, observedAt: job.observedAt,
    startedAt: job.startedAt, finishedAt: job.finishedAt, fence: job.fence, counts: job.counts });
  const captureRun = body => ({ id: body.run?.id, status: body.run?.status, bindingDigest: body.run?.bindingDigest,
    steps: (body.steps ?? []).map(value => ({ targetIndex: value.targetIndex, id: value.id ?? value.stepId,
      operationId: value.operationId, status: value.status, errorCode: value.errorCode })) });
  const captureOperation = detail => ({ id: detail.operation?.id, status: detail.operation?.status,
    workspaceId: detail.operation?.workspaceId, projectId: detail.operation?.projectId, environmentId: detail.operation?.environmentId,
    resourceId: detail.operation?.resourceId, capability: detail.operation?.capability,
    runbookStep: detail.operation?.proposal?.input?.runbookStep });
  const uxCases = UX_CASES.map(({ id }) => ({ id, status: 'not_run', scans: [] }));
  const uxCase = async (id, work) => {
    const row = uxCases.find(value => value.id === id); ensure(Boolean(row) && row.status === 'not_run', 'ux01-case-id');
    try { await test.step(id, work); row.status = 'passed'; }
    catch (error) {
      // Only a fixed journey code (or the error class) reaches the private Playwright log; never page text or URLs.
      const message = String(error?.message ?? '');
      // Other errors keep only their class and first line, without query strings or long opaque tokens.
      const firstLine = message.split('\n')[0].replace(/\?[^\s]*/g, '?…').replace(/[A-Za-z0-9_-]{32,}/g, '…').slice(0, 160);
      console.error('ux01-case-failure', id, /^journey:[A-Za-z0-9_.-]+$/.test(message) ? message : `${error?.name ?? 'Error'}: ${firstLine}`);
      row.status = 'failed'; if (id === 'ux01-uncertainty-a11y') markUxFailure(); throw new Error('journey:' + id);
    }
  };
  const runId = nonce(), witnessNonce = nonce(), serviceId = 'witness';
  // Machines bind the platform resource row of the deployed witness: its graph address and canonical id.
  const witnessAddress = 'container_service/witness';
  // Reads of this owned J1 database, only after its ownership labels are confirmed.
  const psql = async (sql, variables) => {
    const database = 'supabase_db_' + stack.state.projectId;
    const [databaseContainer] = JSON.parse(await docker(['inspect', database]));
    ensure(databaseContainer.Config.Labels?.['com.supabase.cli.project'] === stack.state.projectId &&
      databaseContainer.Config.Labels?.['io.zenith.installation'] === stack.state.installationId, 'health-evidence-database-ownership');
    return command('docker', ['exec', '-i', database, 'psql', '-X', '-U', 'postgres', '-d', 'postgres',
      '-v', 'ON_ERROR_STOP=1', ...Object.entries(variables).flatMap(([name, value]) => ['-v', name + '=' + value]), '-At'], { input: sql });
  };
  const witnessResourceId = async () => {
    // Manifest service IDs identify graph origins, not persisted resource
    // primary keys. Resolve the active target from this owned J1 database.
    const resourceSql = "select coalesce(json_agg(json_build_object('id',id,'workspaceId',workspace_id,'projectId',project_id,'environmentId',environment_id,'address',address,'ownership',ownership,'status',status)), '[]'::json)::text from platform.resources where workspace_id=:'workspace_id' and project_id=:'project_id' and environment_id=:'environment_id' and address=:'address' and ownership='managed' and status='active'";
    const resources = JSON.parse(await psql(resourceSql, { workspace_id: workspaceId, project_id: project.id, environment_id: environmentId, address: witnessAddress }));
    ensure(resources.length === 1 && resources[0].workspaceId === workspaceId && resources[0].projectId === project.id &&
      resources[0].environmentId === environmentId && resources[0].address === witnessAddress &&
      resources[0].ownership === 'managed' && resources[0].status === 'active' && typeof resources[0].id === 'string' && resources[0].id.length > 0,
      'health-target-resource-binding');
    return resources[0].id;
  };
  const step = async (id, work) => {
    try { await test.step(id, work); facts.push({ id, status: 'passed' }); }
    catch { facts.push({ id, status: 'failed' }); throw new Error('journey:' + id); }
  };
  const stopRunner = async () => {
    const child = runnerProcess;
    if (!child) return;
    const waitClosed = async timeout => runnerClosed || await Promise.race([
      new Promise(resolve => child.once('close', () => resolve(true))), pause(timeout).then(() => false),
    ]);
    if (!runnerClosed) {
      if (runnerSpawned && !runnerExited) child.kill('SIGTERM');
      let closed = await waitClosed(15_000);
      if (!closed && !runnerClosed && child.pid) {
        child.kill('SIGKILL');
        closed = await waitClosed(5_000);
      }
      ensure(closed && runnerClosed, 'runner-process-close-unconfirmed');
    }
    ensure(runnerClosed, 'runner-process-close-unconfirmed');
    runnerProcess = undefined;
  };
  const getDetail = async operationId => ok(await browserRequest(a, '/api/platform/v1/operations/' + operationId, undefined, 'GET', workspaceId));
  const getRunbookRun = async runId => ok(await browserRequest(a, '/api/platform/v1/runbooks/runs/' + runId, undefined, 'GET', workspaceId));
  const psqlRead = async (sql, variables = {}) => {
    const database = 'supabase_db_' + stack.state.projectId;
    const [container] = JSON.parse(await docker(['inspect', database]));
    ensure(container.Config.Labels?.['com.supabase.cli.project'] === stack.state.projectId &&
      container.Config.Labels?.['io.zenith.installation'] === stack.state.installationId, 'ux01-window-db-ownership');
    const output = await command('docker', ['exec', '-i', database, 'psql', '-X', '-U', 'postgres', '-d', 'postgres',
      '-v', 'ON_ERROR_STOP=1', ...Object.entries(variables).flatMap(([name, value]) => ['-v', name + '=' + value]), '-At'], { input: sql });
    return JSON.parse(output);
  };
  const runbookInventory = async ownRunId => {
    const database = 'supabase_db_' + stack.state.projectId;
    const [container] = JSON.parse(await docker(['inspect', database]));
    ensure(container.Config.Labels?.['com.supabase.cli.project'] === stack.state.projectId &&
      container.Config.Labels?.['io.zenith.installation'] === stack.state.installationId, 'ux01-window-db-ownership');
    const sql = `select json_build_object('observedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'claimableRunIds',coalesce((select json_agg(id order by id) from platform.machine_runbook_runs
        where (status='approved' or (status='running' and (lease_until is null or lease_until <= clock_timestamp())))
          and id <> :'own_run_id'),'[]'::json),
      'activeRunIds',coalesce((select json_agg(id order by id) from platform.machine_runbook_runs
        where status in ('pending_approval','approved','running') and id <> :'own_run_id'),'[]'::json),
      'activeScheduleIds',coalesce((select json_agg(id order by id) from platform.machine_runbook_schedules where status='active'),'[]'::json))::text`;
    const raw = await command('docker', ['exec', '-i', database, 'psql', '-X', '-U', 'postgres', '-d', 'postgres',
      '-v', 'ON_ERROR_STOP=1', '-v', 'own_run_id=' + (ownRunId || '__no_own_run__'), '-At'], { input: sql });
    const snapshot = JSON.parse(raw);
    ensure(exactObject(snapshot, ['observedAt','claimableRunIds','activeRunIds','activeScheduleIds']) &&
      Array.isArray(snapshot.claimableRunIds) && snapshot.claimableRunIds.length === 0 &&
      Array.isArray(snapshot.activeRunIds) && snapshot.activeRunIds.length === 0 &&
      Array.isArray(snapshot.activeScheduleIds) && snapshot.activeScheduleIds.length === 0, 'ux01-window-global-inventory');
    const window = readUxExclusiveWindow({ stack, source, config });
    return { ...snapshot, sha256: canonicalDigest({ installationId: stack.state.installationId,
      sourceDigest: source.sourceDigest, observedAt: snapshot.observedAt,
      claimableRunIds: snapshot.claimableRunIds, activeRunIds: snapshot.activeRunIds, activeScheduleIds: snapshot.activeScheduleIds }), window };
  };
  const runbookJobRow = async () => {
    const database = 'supabase_db_' + stack.state.projectId;
    const sql = `select coalesce(json_agg(json_build_object('job',job,'source',last_source,'status',last_status,
      'observedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'startedAt',case when last_started_at is null then null else to_char(last_started_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
      'finishedAt',case when last_finished_at is null then null else to_char(last_finished_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
      'fence',last_fence::text,'counts',last_counts)), '[]'::json)::text from platform.scheduled_job_runs where job='runbooks'`;
    const [container] = JSON.parse(await docker(['inspect', database]));
    ensure(container.Config.Labels?.['com.supabase.cli.project'] === stack.state.projectId &&
      container.Config.Labels?.['io.zenith.installation'] === stack.state.installationId, 'ux01-scheduler-db-ownership');
    const output = await command('docker', ['exec', '-i', database, 'psql', '-X', '-U', 'postgres', '-d', 'postgres', '-At'], { input: sql });
    const rows = JSON.parse(output); ensure(rows.length <= 1, 'ux01-scheduler-job-unique'); return rows[0] ?? null;
  };
  const runbookAudit = async runId => {
    const database = 'supabase_db_' + stack.state.projectId;
    const sql = `select coalesce(json_agg(json_build_object('workspaceId',workspace_id,'subject',subject,'seq',seq,
      'event',event,'actor',actor,'detail',detail,'prevDigest',prev_digest,'entryDigest',entry_digest,
      'createdAt',to_char(created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) order by seq), '[]'::json)::text
      from platform.machine_runbook_audit where workspace_id=:'workspace_id' and subject=:'subject'`;
    const raw = await command('docker', ['exec', '-i', database, 'psql', '-X', '-U', 'postgres', '-d', 'postgres',
      '-v', 'ON_ERROR_STOP=1', '-v', 'workspace_id=' + workspaceId, '-v', 'subject=run:' + runId, '-At'], { input: sql });
    return JSON.parse(raw);
  };
  const machineRequests = async (operationId, machineId) => {
    const database = 'supabase_db_' + stack.state.projectId;
    const sql = `select coalesce(json_agg(json_build_object('id',id,'machineId',machine_id,'workspaceId',workspace_id,
      'operationId',operation_id,'operation',operation,'capability',capability,'status',status,
      'startedAt',case when started_at is null then null else to_char(started_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
      'settledAt',case when settled_at is null then null else to_char(settled_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end) order by created_at,id), '[]'::json)::text
      from platform.machine_requests where workspace_id=:'workspace_id' and operation_id=:'operation_id' and machine_id=:'machine_id'`;
    const raw = await command('docker', ['exec', '-i', database, 'psql', '-X', '-U', 'postgres', '-d', 'postgres',
      '-v', 'ON_ERROR_STOP=1', '-v', 'workspace_id=' + workspaceId, '-v', 'operation_id=' + operationId,
      '-v', 'machine_id=' + machineId, '-At'], { input: sql });
    return JSON.parse(raw);
  };
  const auditChainValid = entries => {
    let previous = '0'.repeat(64);
    return entries.every((entry, index) => {
      const body = { prev: previous, ws: entry.workspaceId, subject: entry.subject, seq: entry.seq,
        event: entry.event, actor: entry.actor, detail: entry.detail, at: entry.createdAt };
      const digest = canonicalDigest(body);
      const valid = entry.seq === index + 1 && entry.prevDigest === previous && entry.entryDigest === digest;
      previous = entry.entryDigest; return valid;
    });
  };
  const approvalBody = detail => ({
    proposalDigest: detail.operation.proposalDigest,
    ...(detail.operation.planDigest ? { planDigest: detail.operation.planDigest } : {}),
    ...(detail.planReview?.semantics?.digest ? { semanticsDigest: detail.planReview.semantics.digest } : {}),
  });
  const approve = async (operationId, checkSelf = false) => {
    const detail = await getDetail(operationId);
    ensure(detail.operation.status === 'awaiting_approval' && detail.decision?.approval?.separationOfDuties === true, 'independent-approval-required');
    if (checkSelf) {
      const self = await browserRequest(a, '/api/platform/v1/operations/' + operationId + '/approve', approvalBody(detail), 'POST', workspaceId);
      ensure(self.status === 403 && self.data.error?.code === 'separation_of_duties', 'self-approval-not-refused');
    }
    const approvalPage = UX_ENABLED ? uxB : b;
    await approvalPage.goto(stack.apiUrl + '/platform/operations/' + operationId);
    // The real Chrome UI carries reviewed server digests; no request interception.
    if (UX_ENABLED && !uxApprovalRecorded) {
      await uxCase('ux01-independent-approval-a11y', async () => {
        const scans = uxCases.find(row => row.id === 'ux01-independent-approval-a11y').scans;
        await auditUx(approvalPage, 'operation-before-independent-approval', axeSource, scans);
        const response = approvalPage.waitForResponse(value => value.url().endsWith('/operations/' + operationId + '/approve') && value.request().method() === 'POST');
        await approvalPage.getByRole('button', { name: /^Approve / }).click();
        const recorded = await response;
        ensure(recorded.ok() && (await recorded.json()).operation?.status === 'approved', 'browser-approval-refused');
        await approvalPage.getByRole('status').filter({ hasText: 'Decision recorded.' }).waitFor();
        await auditUx(approvalPage, 'operation-after-independent-approval', axeSource, scans);
      });
      uxApprovalRecorded = true;
    } else {
      const response = approvalPage.waitForResponse(value => value.url().endsWith('/operations/' + operationId + '/approve') && value.request().method() === 'POST');
      await approvalPage.getByRole('button', { name: /^Approve / }).click();
      const recorded = await response;
      ensure(recorded.ok() && (await recorded.json()).operation?.status === 'approved', 'browser-approval-refused');
    }
    const approved = await getDetail(operationId);
    ensure(approved.approvals.some(value => value.approverId === users[1] && value.decision === 'approve'), 'operator-b-approval');
    return approved;
  };
  const scale = async (surface, replicas) => {
    const key = nonce(), scope = { workspaceId, projectId: project.id, environmentId, resourceId: serviceId };
    let operationId;
    if (surface === 'rest') {
      const result = ok(await jsonRequest(stack.apiUrl + '/api/platform/v1/capabilities/propose', {
        method: 'POST', headers: { authorization: 'Bearer ' + linked.token, 'x-zenith-workspace': workspaceId },
        body: { capability: 'service.scale', scope, input: { operation: 'scale', serviceId, replicas }, idempotencyKey: key },
      }));
      ensure(result.operation.status === 'awaiting_approval', 'rest-proposal-gate');
      operationId = result.operation.id;
    } else {
      const result = await mcp(stack, linked.token, 'tools/call', { name: 'zenith_scale_service',
        arguments: { target: { workspaceId, projectId: project.id, environmentId }, serviceId, replicas, idempotencyKey: key } });
      ensure(result.data.status === 'awaiting_approval' && result.data.executed === false, 'mcp-proposal-gate');
      operationId = result.data.operationId;
    }
    await approve(operationId, true);
    await mcp(stack, linked.token, 'tools/call', { name: 'zenith_execute_approved_operation',
      arguments: { workspaceId, operationId, expectedDigest: (await getDetail(operationId)).operation.proposalDigest } });
    const terminal = await until(() => getDetail(operationId),
      value => ['succeeded', 'failed', 'denied', 'uncertain', 'cancelled', 'expired'].includes(value.operation.status));
    ensure(terminal.operation.status === 'succeeded', 'scale-terminal-outcome');
    return { operationId };
  };
  let failed = false;
  try {
    await step('prerequisites', async () => {
      source = JSON.parse(privateFile(process.env.ZENITH_JOURNEY_SOURCE));
      if (UX_ENABLED) {
        const chromePath = process.env.ZENITH_UX01_CHROME, receipt = process.env.ZENITH_UX01_RECEIPT;
        ensure(Boolean(chromePath && receipt && fs.existsSync(chromePath) && path.isAbsolute(receipt) && typeof process.getuid === 'function'), 'ux01-inputs');
        const file = path.resolve(receipt), parent = path.dirname(file);
        const parentStat = fs.lstatSync(parent);
        ensure(parentStat.isDirectory() && !parentStat.isSymbolicLink() && parentStat.uid === process.getuid() && (parentStat.mode & 0o777) === 0o700, 'ux01-private-receipt-directory');
        ensure(path.dirname(file) === parent && !fs.existsSync(file), 'ux01-new-receipt-child');
        const relative = path.relative(path.resolve(process.cwd()), file);
        ensure(relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative), 'ux01-private-receipt-outside-checkout');
        axeSource = (await import('axe-core')).default.source;
      }
      config = Config.parse(JSON.parse(privateFile(process.env.ZENITH_JOURNEY_CONFIG)));
      stack = await prerequisites(config, source);
      Object.assign(source, { docker: stack.docker, dockerArch: stack.dockerArch, profile: stack.profile });
      kubeconfig(config.kind.kubeconfigFile, config);
      const rotation = kubeconfig(config.kind.rotationKubeconfigFile, config);
      ensure(rotation.text !== privateFile(config.kind.kubeconfigFile), 'rotation-distinct-credential');
      privateFile(config.kind.observerKubeconfigFile);
      a = await (await browser.newContext()).newPage();
      b = await (await browser.newContext()).newPage();
    });
    await step('auth-admin-mailpit', async () => {
      const operatorA = await operator(stack, config.mailpitUrl, 'a', users);
      const operatorB = await operator(stack, config.mailpitUrl, 'b', users);
      ensure(operatorA.id !== operatorB.id, 'independent-identities');
      await authenticateBeforeWorkspace(a, stack, operatorA);
      await authenticateBeforeWorkspace(b, stack, operatorB);
      await enrollOperator(a, stack); await enrollOperator(b, stack);
    });
    await step('two-operator-workspace', async () => {
      const workspace = ok(await browserRequest(a, '/api/workspace', { name: 'Zenith J2 ' + runId })).workspace;
      workspaceId = workspace.id;
      ok(await browserRequest(a, '/api/bootstrap'));
      const userB = ok(await jsonRequest(stack.supabaseUrl + '/auth/v1/admin/users/' + users[1], { headers: adminHeaders(stack) }));
      const invite = ok(await browserRequest(a, '/api/workspace/invites', { email: userB.email, role: 'admin', workspaceId })).invite;
      const accepted = ok(await browserRequest(b, '/api/workspace/invites/' + invite.id + '/accept', {}));
      ok(await browserRequest(b, '/api/bootstrap'));
      ensure(accepted.member?.id === users[1] && accepted.member?.role === 'admin', 'operator-b-membership');
      // The default policy lets a sole admin approve their own production change and refuses raw machine
      // commands in production. This journey proves the workspace's two-person rule and runs its customer
      // machine beside the deployed witness, so operator A sets both through the real admin browser route;
      // every escape hatch still needs B's independent approval.
      const policy = ok(await browserRequest(a, '/api/platform/v1/workspace/policy', { overrides: { twoPersonProduction: true, allowEscapeHatchInProduction: true } }, 'PUT', workspaceId));
      ensure(policy.workspaceId === workspaceId && policy.effective?.twoPersonProduction === true && policy.effective?.allowEscapeHatchInProduction === true, 'two-person-production-policy');
      const created = await action(a, 'project.create', { name: 'J2 witness ' + runId, withEnvironment: false });
      project = { id: created.projectId, slug: created.slug, name: 'J2 witness ' + runId };
      const manifest = { version: 2, placement: { provider: 'kubernetes', regions: ['in-cluster'] },
        providerConfig: { kubernetes: { namespace: config.kind.namespace } }, services: [{ id: serviceId, name: 'witness', kind: 'web',
        source: { type: 'image', image: config.kind.image }, size: 'small', replicas: 1, port: 8080,
        healthPath: '/', ownership: 'managed', env: [{ key: 'WITNESS_NONCE', value: witnessNonce }] }],
        resources: [], routes: [], bindings: [] };
      await action(a, 'project.updateManifest', { projectId: project.id, manifest });
      // Store genuine LOCAL kind credentials through the existing tenant vault action,
      // then remove their temporary product env references before any revision/deploy.
      for (const [key, file] of [['J2_OLD_KUBE', config.kind.kubeconfigFile], ['J2_NEW_KUBE', config.kind.rotationKubeconfigFile]]) {
        await action(a, 'system.setSecret', { projectId: project.id, serviceId, key, secretRef: 'vault:' + key, secretValue: privateFile(file) });
      }
      await action(a, 'project.updateManifest', { projectId: project.id, manifest });
      const target = kubeconfig(config.kind.kubeconfigFile, config);
      const connection = await action(a, 'connection.createKubernetes', { label: 'J2 kind ' + runId, server: config.kind.server,
        caData: target.caData, namespaces: [config.kind.namespace], credentialRef: 'vault:J2_OLD_KUBE', scopedGuest: false });
      project.connectionId = connection.connectionId;
      await a.goto(stack.apiUrl + '/platform/connections');
      const card = a.getByRole('listitem').filter({ hasText: 'J2 kind ' + runId });
      const verified = a.waitForResponse(value => value.url().endsWith('/connections/' + project.connectionId + '/verify') && value.request().method() === 'POST');
      await card.getByRole('button', { name: 'Verify', exact: true }).click();
      // The route answers 200 with ok:false on a refused verification; require the verified outcome.
      const verifiedResponse = await verified;
      ensure(verifiedResponse.ok() && (await verifiedResponse.json())?.ok === true, 'connection-verification');
      const env = await action(a, 'env.create', { projectId: project.id, name: 'production', class: 'production',
        connectionId: project.connectionId, approvalRequired: true });
      environmentId = env.environmentId;
      linked = await linkedAgent(a, stack, project, workspaceId);
      if (UX_ENABLED) {
        uxBrowser = await chromium.launch({ executablePath: process.env.ZENITH_UX01_CHROME, headless: true });
        uxA = await uxBrowser.newContext({ storageState: await a.context().storageState() }).then(context => context.newPage());
        uxB = await uxBrowser.newContext({ storageState: await b.context().storageState() }).then(context => context.newPage());
      }
      await test.step('mcp-runner-plan-human-confirmation', async () => {
      // The J2 workspace id is generated above, so this creates a genuine runner
      // registration in that exact workspace via the same browser-only admin route.
      // The registration token exists only in this process and a 0600 one-shot file.
      const scratch = process.env.ZENITH_JOURNEY_SCRATCH;
      ensure(typeof scratch === 'string' && path.isAbsolute(scratch), 'runner-private-scratch-required');
      const scratchReal = fs.realpathSync(scratch), sourceReal = fs.realpathSync(process.cwd());
      ensure(!scratchReal.startsWith(sourceReal + path.sep), 'runner-private-scratch-outside-source');
      runnerCustodyMarker = path.join(scratchReal, 'RETAIN-RUNNER-CUSTODY');
      fs.writeFileSync(runnerCustodyMarker, 'runner-setup-or-close-unconfirmed\n', { mode: 0o600, flag: 'wx' });
      runnerDir = path.join(scratchReal, 'mcp-runner');
      fs.mkdirSync(runnerDir, { mode: 0o700 });
      const stateDir = path.join(runnerDir, 'state');
      fs.mkdirSync(stateDir, { mode: 0o700 });
      const runnerBinary = path.join(runnerDir, 'zenith-runner');
      const previousToolchain = process.env.GOTOOLCHAIN;
      const previousCgo = process.env.CGO_ENABLED;
      process.env.GOTOOLCHAIN = 'local';
      process.env.CGO_ENABLED = '0';
      try {
        ensure(await command('go', ['env', 'GOVERSION']) === 'go1.27.1', 'runner-go-toolchain-pin');
        await command('go', ['-C', path.resolve('go'), 'build', '-o', runnerBinary, './cmd/zenith-runner'], { timeout: 180_000 });
      } finally {
        if (previousToolchain === undefined) delete process.env.GOTOOLCHAIN; else process.env.GOTOOLCHAIN = previousToolchain;
        if (previousCgo === undefined) delete process.env.CGO_ENABLED; else process.env.CGO_ENABLED = previousCgo;
      }
      ensure(fs.statSync(runnerBinary).isFile() && (fs.statSync(runnerBinary).mode & 0o111) !== 0, 'runner-binary-build');
      runnerName = 'j2-mcp-' + runId;
      const registration = ok(await browserRequest(a, '/api/platform/v1/runners/tokens',
        { kind: 'runner', ttlMinutes: 10 }, 'POST', workspaceId));
      ensure(registration.kind === 'runner' && registration.workspaceId === workspaceId &&
        registration.shownOnce === true && typeof registration.token === 'string' && registration.token.startsWith('zrt_'),
        'same-workspace-runner-token');
      const tokenFile = path.join(runnerDir, 'registration.token');
      fs.writeFileSync(tokenFile, registration.token + '\n', { mode: 0o600, flag: 'wx' });
      const runnerConfigFile = path.join(runnerDir, 'config.json');
      const k8sApiServer = await command('kubectl', ['--kubeconfig', config.kind.observerKubeconfigFile,
        'config', 'view', '--minify', '-o', 'jsonpath={.clusters[0].cluster.server}']);
      ensure(localUrl(k8sApiServer, true) === k8sApiServer, 'runner-k8s-local-api');
      runnerServiceAccount = 'j2-mcp-' + runId;
      const rbac = { apiVersion: 'v1', kind: 'List', items: [
        { apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name: runnerServiceAccount, namespace: config.kind.namespace } },
        { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'Role', metadata: { name: runnerServiceAccount, namespace: config.kind.namespace },
          rules: [{ apiGroups: [''], resources: ['pods'], verbs: ['get', 'list'] }] },
        { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'RoleBinding', metadata: { name: runnerServiceAccount, namespace: config.kind.namespace },
          subjects: [{ kind: 'ServiceAccount', name: runnerServiceAccount, namespace: config.kind.namespace }],
          roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: runnerServiceAccount } },
      ] };
      await command('kubectl', ['--kubeconfig', config.kind.observerKubeconfigFile, 'apply', '-f', '-'],
        { input: JSON.stringify(rbac) });
      const k8sToken = await command('kubectl', ['--kubeconfig', config.kind.observerKubeconfigFile,
        '-n', config.kind.namespace, 'create', 'token', runnerServiceAccount, '--duration=1h']);
      ensure(k8sToken.length > 0, 'runner-k8s-token');
      const caData = kubeconfig(config.kind.kubeconfigFile, config).caData;
      const k8sTokenFile = path.join(runnerDir, 'k8s.token');
      const k8sCaFile = path.join(runnerDir, 'k8s-ca.crt');
      fs.writeFileSync(k8sTokenFile, k8sToken + '\n', { mode: 0o600, flag: 'wx' });
      fs.writeFileSync(k8sCaFile, Buffer.from(caData, 'base64'), { mode: 0o600, flag: 'wx' });
      const runnerConfig = {
        controlPlane: { url: stack.apiUrl }, stateDir, name: runnerName, pollWaitSec: 1, heartbeatSec: 5,
        kinds: { 'k8s.http': { enabled: true, apiServer: k8sApiServer, tokenFile: k8sTokenFile, caFile: k8sCaFile,
          allow: { 'infrastructure.observe': ['GET /api/v1/namespaces/*/pods'] } } },
      };
      fs.writeFileSync(runnerConfigFile, JSON.stringify(runnerConfig), { mode: 0o600, flag: 'wx' });
      await command(runnerBinary, ['--config', runnerConfigFile, 'check']);
      await command(runnerBinary, ['--config', runnerConfigFile, 'register', '--token-file', tokenFile]);
      fs.unlinkSync(tokenFile);
      runnerProcess = spawn(runnerBinary, ['--config', runnerConfigFile, 'run'], {
        stdio: 'ignore', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: runnerDir },
      });
      const processStarted = new Promise(resolve => {
        runnerProcess.once('spawn', () => { runnerSpawned = true; resolve(true); });
        runnerProcess.once('error', () => { runnerSpawnError = true; resolve(false); });
        runnerProcess.once('exit', () => { runnerExited = true; });
        runnerProcess.once('close', () => { runnerClosed = true; });
      });
      ensure(await processStarted, 'runner-process-spawn-failed');
      const liveRunner = await until(async () => {
        ensure(runnerSpawned && !runnerSpawnError && !runnerExited && !runnerClosed, 'runner-process-exited');
        const roster = ok(await browserRequest(a, '/api/platform/v1/runners', undefined, 'GET', workspaceId));
        return roster.runners?.find(value => value.name === runnerName);
      }, value => value?.status === 'active' && value.connection?.state === 'online' &&
        value.capabilities?.includes('k8s.http'));
      runnerId = liveRunner.id;

      const input = { provider: 'kubernetes', mode: 'runner', runnerId, server: config.kind.server,
        namespaces: [config.kind.namespace], label: 'J2 MCP runner ' + runId };
      const beforeConnections = ok(await browserRequest(a, '/api/platform/v1/connections', undefined, 'GET', workspaceId));
      const beforeOperations = ok(await browserRequest(a, '/api/platform/v1/operations?limit=200', undefined, 'GET', workspaceId));
      const draft = await mcp(stack, linked.token, 'tools/call', { name: 'zenith_plan_runner_connection', arguments: {
        target: { workspaceId, projectId: project.id }, action: 'connection.createRunner', input,
      } });
      ensure(draft.data?.action === 'connection.createRunner' && draft.data.requiredRole === 'admin' &&
        draft.data.requiresBrowserConfirmation === true && draft.data.approved === false && draft.data.executed === false,
        'mcp-runner-plan-read-only');
      ensure(draft.untrusted_data?.content?.request?.action === 'connection.createRunner' &&
        sameJson(draft.untrusted_data.content.request.input, input), 'mcp-runner-plan-exact-request');
      const handoff = new URL(draft.data.browserUrl);
      ensure(handoff.origin === stack.apiUrl && handoff.pathname === '/platform/connections/confirm' && handoff.search === '',
        'mcp-runner-plan-local-handoff');
      const fragment = JSON.parse(decodeURIComponent(handoff.hash.slice(1)));
      ensure(fragment.version === 1 && fragment.workspaceId === workspaceId &&
        fragment.request?.action === 'connection.createRunner' &&
        sameJson(fragment.request.input, input), 'mcp-runner-plan-exact-handoff');

      // The linked A credential can plan, but the browser-only mutation route rejects it.
      const agentMutation = await jsonRequest(stack.apiUrl + '/api/platform/v1/connections', {
        method: 'POST', headers: { authorization: 'Bearer ' + linked.token, 'x-zenith-workspace': workspaceId }, body: input,
      });
      ensure([401, 403].includes(agentMutation.status), 'linked-agent-cannot-create');
      const noSideEffectConnections = ok(await browserRequest(a, '/api/platform/v1/connections', undefined, 'GET', workspaceId));
      const noSideEffectOperations = ok(await browserRequest(a, '/api/platform/v1/operations?limit=200', undefined, 'GET', workspaceId));
      ensure(sameJson(noSideEffectConnections.connections?.map(value => value.id).sort(),
        beforeConnections.connections?.map(value => value.id).sort()) &&
        sameJson(noSideEffectOperations.operations?.map(value => value.id).sort(),
        beforeOperations.operations?.map(value => value.id).sort()), 'mcp-runner-plan-no-side-effect');

      // B is the distinct authenticated admin already invited in this J2 run.
      await b.goto(draft.data.browserUrl);
      await b.getByRole('heading', { name: 'Review connection change', exact: true }).waitFor();
      await b.getByRole('heading', { name: 'Create runner connection', exact: true }).waitFor();
      await b.getByText(runnerId, { exact: true }).waitFor();
      const review = b.getByRole('checkbox', { name: /I reviewed these exact identifiers/ });
      const confirm = b.getByRole('button', { name: 'Confirm create runner connection', exact: true });
      ensure(!(await review.isChecked()) && await confirm.isDisabled(), 'human-review-default-closed');
      await review.check();
      const createdResponse = b.waitForResponse(value => value.url().endsWith('/api/platform/v1/connections') &&
        value.request().method() === 'POST');
      await confirm.click();
      const createdHttp = await createdResponse;
      ensure(createdHttp.status() === 201, 'human-confirm-create-runner');
      const createdBody = await createdHttp.json();
      ensure(createdBody?.ok === true && typeof createdBody.data?.connectionId === 'string', 'human-create-response');
      runnerConnectionId = createdBody.data.connectionId;
      // Scoped: the boot splash is also a status region while it lifts.
      await b.getByRole('region', { name: 'Connection confirmation', exact: true }).getByRole('status').waitFor();
      const after = ok(await browserRequest(a, '/api/platform/v1/connections', undefined, 'GET', workspaceId));
      ensure(after.connections?.some(value => value.id === runnerConnectionId && value.mode === 'runner' &&
        value.provider === 'kubernetes' && value.runnerId === runnerId), 'independent-runner-connection-readback');
      runnerCaseSucceeded = true;
      });
    });
    let operationId, deploymentId;
    await step('browser-proposal', async () => {
      await a.goto(stack.apiUrl + '/p/' + project.slug + '?env=' + encodeURIComponent(environmentId));
      await a.getByRole('button', { name: /pending change.*Review/ }).click();
      await a.getByLabel('Type production to confirm deploying to production', { exact: true }).fill('production');
      const response = a.waitForResponse(value => value.url().endsWith('/api/actions/deploy.apply') && value.request().method() === 'POST');
      await a.getByRole('button', { name: 'Request approval for production', exact: true }).click();
      const answer = await (await response).json();
      const data = answer.result?.data;
      ensure(answer.result?.ok && data?.deploymentId && data?.operationId, 'default-browser-workflow-proposal');
      operationId = data.operationId; deploymentId = data.deploymentId;
      const detail = await getDetail(operationId);
      ensure(detail.operation.status === 'awaiting_approval' && detail.operation.principal.id === users[0], 'browser-requester');
    });
    if (UX_ENABLED) await uxCase('ux01-operation-review-a11y', async () => {
      uxStage = 'ui';
      await uxA.goto(stack.apiUrl + '/platform/operations/' + operationId);
      await uxA.getByRole('heading', { name: 'Operation details', exact: true }).first().waitFor();
      ensure(await uxA.getByRole('heading', { name: 'Operation details', exact: true }).count() === 1, 'ux01-operation-heading');
      await uxA.getByRole('region', { name: 'Progress', exact: true }).first().waitFor();
      ensure(await uxA.getByRole('region', { name: 'Progress', exact: true }).count() === 1, 'ux01-progress-region');
      ensure((await uxA.locator('[data-testid="journey-live"]:visible').innerText()).length > 0, 'ux01-progress-status');
      ensure(await uxA.getByRole('button', { name: 'Cancel operation', exact: true }).isEnabled(), 'ux01-cancel-enabled');
      ensure(await uxA.getByRole('button', { name: /^Approve / }).first().isDisabled(), 'ux01-requester-approval-disabled');
      await auditUx(uxA, 'operation-requester-review', axeSource, uxCases.find(row => row.id === 'ux01-operation-review-a11y').scans);
    });
    await step('self-approval-refused', async () => {
      const detail = await getDetail(operationId);
      const response = await browserRequest(a, '/api/platform/v1/operations/' + operationId + '/approve', approvalBody(detail), 'POST', workspaceId);
      ensure(response.status === 403 && response.data.error?.code === 'separation_of_duties', 'self-approval');
      await a.goto(stack.apiUrl + '/platform/operations/' + operationId);
      ensure(await a.getByRole('button', { name: /^Approve / }).isDisabled(), 'self-ui-approval');
    });
    await step('bearer-approval-refused', async () => {
      const response = await jsonRequest(stack.apiUrl + '/api/platform/v1/operations/' + operationId + '/approve', {
        method: 'POST', headers: { authorization: 'Bearer ' + linked.token, origin: stack.apiUrl, 'x-zenith-workspace': workspaceId },
        body: approvalBody(await getDetail(operationId)),
      });
      ensure([401, 403].includes(response.status), 'bearer-human-approval');
      ensure((await getDetail(operationId)).operation.status === 'awaiting_approval', 'bearer-approval-changed-state');
    });
    await step('stale-semantics-refused', async () => {
      await approve(operationId);
      // The product's existing deployment caller owns workflow startup.
      await action(b, 'deploy.approve', { deploymentId }, { projectId: project.id, environmentId });
      const detail = await until(() => getDetail(operationId),
        value => value.operation.status === 'awaiting_approval' && value.operation.approvalRound > 0);
      const body = approvalBody(detail);
      ensure(/^[a-f0-9]{64}$/.test(body.planDigest ?? '') && /^[a-f0-9]{64}$/.test(body.semanticsDigest ?? ''), 'plan-and-semantics-required');
      const wrong = body.semanticsDigest[0] === '0' ? '1' : '0';
      const response = await browserRequest(b, '/api/platform/v1/operations/' + operationId + '/approve',
        { ...body, semanticsDigest: wrong + body.semanticsDigest.slice(1) }, 'POST', workspaceId);
      ensure(response.status === 409 && response.data.error?.code === 'semantics_mismatch', 'stale-semantics-approval');
      ensure((await getDetail(operationId)).operation.status === 'awaiting_approval', 'stale-semantics-changed-state');
    });
    if (UX_ENABLED) await uxCase('ux01-replan-reapproval-a11y', async () => {
      const notice = uxB.getByRole('alert').filter({ hasText: 'Plan changed: approval is required again' });
      await notice.waitFor({ timeout: 10_000 });
      ensure((await uxB.locator('[data-testid="journey-live"]:visible').innerText()).length > 0, 'ux01-reapproval-status');
      await auditUx(uxB, 'operation-reapproval-required', axeSource, uxCases.find(row => row.id === 'ux01-replan-reapproval-a11y').scans);
    });
    await step('browser-kind-execution-readback', async () => {
      await approve(operationId, true);
      const detail = await until(() => getDetail(operationId), value => ['succeeded', 'failed', 'uncertain'].includes(value.operation.status));
      ensure(detail.operation.status === 'succeeded', 'default-browser-execution');
      readbacks.kind = await kindReadback(config, 1, witnessNonce);
    });
    if (UX_ENABLED) await uxCase('ux01-legacy-projection-a11y', async () => {
      uxStage = 'ui';
      await uxA.goto(stack.apiUrl + '/platform/operations/' + operationId);
      const stage = (await uxA.locator('[data-testid="journey-live"]:visible').innerText()).split('. ')[0];
      await uxA.goto(stack.apiUrl + '/platform/deployments/' + deploymentId);
      await uxA.getByRole('heading', { name: 'Deployment', exact: true }).first().waitFor();
      ensure(await uxA.getByRole('heading', { name: 'Deployment', exact: true }).count() === 1, 'ux01-deployment-heading');
      ensure((await uxA.locator('[data-testid="journey-live"]:visible').innerText()).split('. ')[0] === stage, 'ux01-legacy-projection');
      await auditUx(uxA, 'linked-workflow-deployment', axeSource, uxCases.find(row => row.id === 'ux01-legacy-projection-a11y').scans);
    });
    await step('rest-proposal-execution-readback', async () => {
      await scale('rest', 2); readbacks.kind = await kindReadback(config, 2, witnessNonce);
    });
    await step('mcp-proposal-execution-readback', async () => {
      await scale('mcp', 1); readbacks.kind = await kindReadback(config, 1, witnessNonce);
    });
    let machineEnv;
    await step('machine-browser-consent', async () => {
      // The customer machine runs beside the deployed witness, so it binds that environment's resource row.
      machineEnv = environmentId;
      // Enrollment currently has an admin API, not a UI form. Exercise the real
      // same-origin browser consent API and verify the resulting saved binding.
      const token = ok(await browserRequest(a, '/api/platform/v1/runners/tokens', {
        kind: 'machine', ttlMinutes: 10, binding: { environmentId: machineEnv, address: witnessAddress },
      }, 'POST', workspaceId));
      ensure(token.shownOnce && token.workspaceId === workspaceId, 'enrollment-consent');
      machine = new Machine(config, stack, runId);
      await machine.start(token.token, machineEnv, witnessAddress);
      await machine.registered(a, workspaceId);
    });
    await step('machine-independent-approval-readback', async () => {
      const runbookId = 'j2-' + runId, target = { transport: 'zenithd', targetId: machine.id,
        environmentId: machineEnv, resourceId: await witnessResourceId(), address: witnessAddress };
      const published = ok(await browserRequest(a, '/api/platform/v1/runbooks', { runbookId,
        definition: { schemaVersion: 1, name: 'J2 witness', steps: [{ id: 'write', title: 'Write owned witness marker',
          operation: 'machine.exec', args: { argv: ['/usr/local/bin/witness', 'write', witnessNonce], timeoutSec: 10 },
          timeoutSec: 15, maxOutputBytes: 4096, onFailure: 'abort' }] },
      }, 'POST', workspaceId));
      ensure(published.version?.definitionDigest, 'signed-runbook');
      const run = ok(await browserRequest(a, '/api/platform/v1/runbooks/' + runbookId + '/runs',
        { targets: [target], maxParallelTargets: 1, maxRunDurationSec: 120 }, 'POST', workspaceId)).run;
      ensure(run.status === 'pending_approval', 'machine-run-approval-required');
      const self = await browserRequest(a, '/api/platform/v1/runbooks/runs/' + run.id + '/approve',
        { bindingDigest: run.bindingDigest }, 'POST', workspaceId);
      ensure(self.status === 403, 'machine-run-self-approval');
      const runApprover = UX_ENABLED ? uxB : b;
      await runApprover.goto(stack.apiUrl + '/platform/runbooks/runs/' + run.id);
      if (UX_ENABLED) await uxCase('ux01-runbook-approval-progress-a11y', async () => {
        await runApprover.getByRole('region', { name: 'Run progress', exact: true }).first().waitFor();
        ensure(await runApprover.getByRole('region', { name: 'Run progress', exact: true }).count() === 1, 'ux01-runbook-progress');
        await runApprover.getByRole('heading', { name: 'Exact effect', exact: true }).first().waitFor();
      ensure(await runApprover.getByRole('heading', { name: 'Exact effect', exact: true }).count() === 1, 'ux01-runbook-effect');
        await auditUx(runApprover, 'runbook-pending-approval', axeSource, uxCases.find(row => row.id === 'ux01-runbook-approval-progress-a11y').scans);
      });
      const approved = runApprover.waitForResponse(value => value.url().endsWith('/runbooks/runs/' + run.id + '/approve') && value.request().method() === 'POST');
      await runApprover.getByRole('button', { name: 'Approve this run', exact: true }).click();
      ensure((await approved).ok(), 'machine-ui-approval');
      const complete = await until(async () => ok(await browserRequest(a, '/api/platform/v1/runbooks/runs/' + run.id, undefined, 'GET', workspaceId)),
        value => ['succeeded', 'failed', 'uncertain', 'expired'].includes(value.run.status));
      ensure(complete.run.status === 'succeeded' && complete.steps.length === 1 && complete.steps[0].status === 'succeeded', 'machine-run-success');
      if (UX_ENABLED) {
        await runApprover.reload();
        ensure((await runApprover.locator('[data-testid="journey-live"]:visible').innerText()).length > 0, 'ux01-runbook-terminal-progress');
      }
      readbacks.machine = await machine.read(witnessNonce);
      // A run step records its own step key; the broker operation is joined through the run's audit.
      const stepOperationId = complete.audit?.find(event => event.event === 'run.step.authorized')?.detail?.operationId;
      ensure(typeof stepOperationId === 'string' && stepOperationId.startsWith('op_'), 'machine-step-operation-join');
      const events = await mcp(stack, linked.token, 'tools/call', { name: 'zenith_get_operation_events',
        arguments: { workspaceId, operationId: stepOperationId } });
      ensure(events.data.count > 0 && events.data.events?.length > 0, 'machine-events-readback-empty');
      ensure(!JSON.stringify(events).includes(machine.credential), 'model-visible-credential');
      // One registered machine binds a resource at a time: B revokes the customer machine before the health machine
      // takes the witness binding, and the native agent must exit as revoked (3). Rejoin later reuses this identity volume.
      const handoff = ok(await browserRequest(b, '/api/platform/v1/machines/' + machine.id + '/revoke', {}, 'POST', workspaceId));
      ensure(handoff.id === machine.id && handoff.status === 'revoked', 'machine-revocation');
      const stoppedAgent = await until(async () => JSON.parse(await command('docker', ['inspect', machine.container])),
        value => value[0].State.Running === false);
      ensure(stoppedAgent.length === 1 && stoppedAgent[0].Config.Labels?.['io.zenith.journey'] === runId &&
        stoppedAgent[0].State.ExitCode === 3, 'machine-native-revoked-exit-code');
    });
    if (UX_ENABLED) await uxCase('ux01-cancel-operation-a11y', async () => {
      const pending = await mcp(stack, linked.token, 'tools/call', { name: 'zenith_scale_service',
        arguments: { target: { workspaceId, projectId: project.id, environmentId }, serviceId, replicas: 2, idempotencyKey: nonce() } });
      ensure(pending.data.status === 'awaiting_approval' && pending.data.executed === false, 'ux01-cancel-pending');
      const cancelId = pending.data.operationId;
      await uxA.goto(stack.apiUrl + '/platform/operations/' + cancelId);
      ensure((await uxA.locator('[data-testid="journey-live"]:visible').innerText()).includes('Awaiting approval'), 'ux01-cancel-state');
      ensure(await uxA.getByRole('button', { name: 'Cancel operation', exact: true }).isEnabled(), 'ux01-cancel-control');
      const scans = uxCases.find(row => row.id === 'ux01-cancel-operation-a11y').scans;
      await auditUx(uxA, 'operation-pending-cancel', axeSource, scans);
      const response = uxA.waitForResponse(value => value.url().endsWith('/operations/' + cancelId + '/cancel') && value.request().method() === 'POST');
      await uxA.getByRole('button', { name: 'Cancel operation', exact: true }).click();
      ensure((await response).ok(), 'ux01-cancel-response');
      const terminal = await until(() => getDetail(cancelId), value => value.operation.status === 'cancelled');
      ensure(terminal.operation.status === 'cancelled', 'ux01-cancel-readback');
      await uxA.reload();
      ensure((await uxA.locator('[data-testid="journey-live"]:visible').innerText()).includes('Cancelled'), 'ux01-cancel-terminal-ui');
      await auditUx(uxA, 'operation-cancelled', axeSource, scans);
    });
    if (UX_ENABLED) await uxCase('ux01-readiness-a11y', async () => {
      await uxA.goto(stack.apiUrl + '/platform/readiness');
      await uxA.getByRole('heading', { name: /readiness/i }).first().waitFor();
      ensure(await uxA.getByRole('heading', { name: /readiness/i }).count() === 1, 'ux01-readiness-heading');
      await auditUx(uxA, 'platform-readiness', axeSource, uxCases.find(row => row.id === 'ux01-readiness-a11y').scans);
    });
    await step('machine-health-provenance-readback', async () => {
      // Bind a second owned zenithd to the already-deployed resource in the
      // production environment. This reaches the worker's real system.metrics
      // capability and readMachineHealth path; no test transport is injected.
      const healthToken = ok(await browserRequest(a, '/api/platform/v1/runners/tokens', {
        kind: 'machine', ttlMinutes: 10, binding: { environmentId, address: witnessAddress },
      }, 'POST', workspaceId));
      ensure(healthToken.shownOnce && healthToken.workspaceId === workspaceId, 'health-machine-consent');
      healthMachine = new Machine(config, stack, runId + '-obs');
      await healthMachine.start(healthToken.token, environmentId, witnessAddress);
      await healthMachine.registered(a, workspaceId);

      const metricsRaw = await mcp(stack, linked.token, 'tools/call', { name: 'zenith_query_metrics', arguments: {
        target: { workspaceId, projectId: project.id, environmentId }, serviceId,
        metrics: ['cpu.utilization'], lastMinutes: 5,
      } }, true);
      const metrics = metricsRaw.data?.result?.structuredContent;
      ensure(metricsRaw.status === 200 && metrics?.ok === true && metrics.simulated === false, 'default-metrics-api');
      const envelope = metrics.data?.telemetry;
      ensure(envelope?.signal === 'metric' && envelope.scope?.workspaceId === workspaceId &&
        envelope.scope?.projectId === project.id && envelope.scope?.environmentId === environmentId &&
        envelope.scope?.addresses?.includes(witnessAddress) && Date.parse(envelope.observedAt) > 0 &&
        ['fresh', 'stale', 'empty', 'unknown', 'inaccessible'].includes(envelope.state), 'default-metrics-provenance');
      ensure(!JSON.stringify(metrics).includes(linked.token) && !JSON.stringify(metrics).includes(healthToken.token), 'metrics-token-redaction');

      healthResourceId = await witnessResourceId();

      const proposed = ok(await jsonRequest(stack.apiUrl + '/api/platform/v1/capabilities/propose', {
        method: 'POST', headers: { authorization: 'Bearer ' + linked.token, 'x-zenith-workspace': workspaceId },
        body: { capability: 'system.metrics', scope: { workspaceId, projectId: project.id, environmentId, resourceId: healthResourceId },
          input: {}, idempotencyKey: nonce() },
      }));
      const operationId = proposed.operation?.id;
      // A read-only health probe is allowed by policy; a human approves it only when policy asks.
      ensure(['awaiting_approval', 'approved'].includes(proposed.operation?.status) && operationId, 'health-operation-proposal');
      if (proposed.operation.status === 'awaiting_approval') await approve(operationId, true);
      const reviewed = await getDetail(operationId);
      await mcp(stack, linked.token, 'tools/call', { name: 'zenith_execute_approved_operation', arguments: {
        workspaceId, operationId, expectedDigest: reviewed.operation.proposalDigest,
      } });
      let workflowProgress = null;
      const terminal = await until(async () => {
        // Capture genuine live progress when the read races ahead of completion;
        // a fast, valid terminal result remains valid without an intermediate
        // sample. The optional observation is recorded explicitly below.
        const [detail, projectionRaw] = await Promise.all([
          getDetail(operationId),
          mcp(stack, linked.token, 'tools/call', { name: 'zenith_get_operation', arguments: { workspaceId, operationId } }, true),
        ]);
        const projection = projectionRaw.data?.result?.structuredContent;
        const live = projection?.ok === true ? projection.data : undefined;
        if (live?.operation?.id === operationId && live.operation.workspaceId === workspaceId &&
            live.operation.status === 'running' && live.progress?.steps?.length) {
          ensure(live.progress.steps.every(item => ['pending', 'running', 'done', 'failed', 'skipped'].includes(item.status)), 'health-workflow-projection');
          workflowProgress ??= live.progress;
        }
        return detail;
      }, value => ['succeeded', 'failed', 'uncertain'].includes(value.operation.status), 30_000);
      ensure(terminal.operation.id === operationId && terminal.operation.workspaceId === workspaceId, 'health-operation-binding');
      const foreign = await mcp(stack, linked.token, 'tools/call', { name: 'zenith_get_operation', arguments: {
        workspaceId: nonce(), operationId,
      } }, true);
      const foreignEnvelope = foreign.data?.result?.structuredContent;
      ensure(foreign.status === 200 && foreignEnvelope?.ok === false && foreignEnvelope.error?.code === 'not_found', 'health-operation-tenant-refusal');
      ensure(terminal.operation.status === 'succeeded', 'health-operation-terminal');
      const finalRead = await mcp(stack, linked.token, 'tools/call', { name: 'zenith_get_operation', arguments: { workspaceId, operationId } });
      ensure(finalRead.data.operation.status === 'succeeded' && finalRead.data.operation.id === operationId &&
        !JSON.stringify(finalRead).includes(linked.token) && !JSON.stringify(finalRead).includes(healthToken.token), 'health-operation-api-redaction');

      const sql = "select coalesce(json_agg(json_build_object('id',e.id,'workspaceId',e.workspace_id,'operationId',e.operation_id,'kind',e.kind,'simulated',e.simulated,'createdAt',e.created_at,'summary',e.summary,'operationStatus',o.status,'projectId',o.project_id,'environmentId',o.environment_id,'resourceId',o.resource_id,'capability',o.capability)), '[]'::json)::text from platform.evidence e join platform.operations o on o.workspace_id = e.workspace_id and o.id = e.operation_id where e.workspace_id = :'workspace_id' and e.operation_id = :'operation_id' and o.project_id = :'project_id' and o.environment_id = :'environment_id' and o.resource_id = :'resource_id' and e.kind = 'observation' and e.summary->>'kind' = 'machine_health' and e.summary->>'capability' = 'system.metrics'";
      const sqlVariables = { workspace_id: workspaceId, project_id: project.id, operation_id: operationId,
        environment_id: environmentId, resource_id: healthResourceId };
      const rows = JSON.parse(await psql(sql, sqlVariables));
      ensure(rows.length === 1, 'health-evidence-unique-owner-row');
      const evidence = rows[0], telemetry = evidence.summary?.telemetry;
      ensure(evidence.workspaceId === workspaceId && evidence.operationId === operationId && evidence.kind === 'observation' && evidence.simulated === false &&
        evidence.operationStatus === 'succeeded' && evidence.projectId === project.id && evidence.environmentId === environmentId &&
        evidence.resourceId === healthResourceId && evidence.capability === 'system.metrics' &&
        evidence.summary.address === witnessAddress && telemetry?.signal === 'health' &&
        telemetry.scope?.workspaceId === workspaceId && telemetry.scope?.environmentId === environmentId &&
        telemetry.scope?.addresses?.length === 1 && telemetry.scope.addresses[0] === witnessAddress &&
        Date.parse(telemetry.observedAt) > 0 && telemetry.provenance?.length === 1 &&
        telemetry.provenance[0].source === 'machines.zenithd' && telemetry.provenance[0].provider === 'zenithd' &&
        ['fresh', 'stale'].includes(telemetry.state) && !JSON.stringify(evidence).includes(healthMachine.credential), 'health-evidence-provenance');
      ensure(JSON.parse(await psql(sql, { ...sqlVariables, workspace_id: nonce() })).length === 0, 'health-evidence-tenant-filter');
      readbacks.obs02 = sha256({ operationId, status: terminal.operation.status, workflowProgressObserved: workflowProgress !== null,
        progress: workflowProgress,
        metricScope: envelope.scope, metricState: envelope.state, healthScope: telemetry.scope,
        healthState: telemetry.state, healthSource: telemetry.provenance[0].source, createdAt: evidence.createdAt });
    });
    await step('customer-credential-absence', async () => {
      await machine.credentialAbsent(process.env.ZENITH_JOURNEY_SCRATCH, healthMachine ? [healthMachine.credential] : []);
    });
    if (UX_ENABLED) await uxCase('ux01-uncertainty-a11y', async () => {
      ensure(healthMachine?.id && healthResourceId && healthMachine.environmentId === environmentId &&
        healthMachine.address === witnessAddress && /^[a-f0-9]{24}$/.test(runId), 'ux01-uncertainty-health-binding');
      const fixtureStarted = performance.now(), elapsed = () => Math.floor(performance.now() - fixtureStarted);
      uxStage = 'preflight';
      const window = readUxExclusiveWindow({ stack, source, config });
      uxOriginalWindow = { id: window.id, digest: window.digest };
      const preflight = await runbookInventory(undefined);
      ensure(preflight.window.id === window.id && preflight.window.digest === window.digest &&
        preflight.claimableRunIds.length === 0 && preflight.activeRunIds.length === 0 && preflight.activeScheduleIds.length === 0, 'ux01-uncertainty-preflight');
      const schedulerBefore = await runbookJobRow();
      captureUxObservation('preflight', { window, inventory: { observedAt: preflight.observedAt, claimableRunIds: preflight.claimableRunIds,
        activeRunIds: preflight.activeRunIds, activeScheduleIds: preflight.activeScheduleIds, sha256: preflight.sha256 }, schedulerBefore: captureJob(schedulerBefore) });
      const runbookId = 'j2-uncertainty-' + runId;
      const definition = { schemaVersion: 1, name: 'J2 uncertain witness hold', steps: [{ id: 'hold', title: 'Hold owned witness marker',
        operation: 'machine.exec', args: { argv: ['/usr/local/bin/witness', 'hold', witnessNonce], timeoutSec: 60 },
        timeoutSec: 60, maxOutputBytes: 4096, onFailure: 'abort' }] };
      const published = ok(await browserRequest(a, '/api/platform/v1/runbooks', { runbookId, definition }, 'POST', workspaceId));
      ensure(published.version?.definitionDigest && Number.isSafeInteger(published.version.version) && published.version.version > 0, 'ux01-uncertainty-signed-version');
      const target = { transport: 'zenithd', targetId: healthMachine.id, environmentId, resourceId: healthResourceId, address: witnessAddress };
      uxStage = 'request';
      // An ambiguous create response may still mean the run was committed; latch before the request.
      healthMachine.uncertaintyCustody = true;
      const request = ok(await browserRequest(a, '/api/platform/v1/runbooks/' + runbookId + '/runs', {
        targets: [target], maxParallelTargets: 1, maxRunDurationSec: 300,
      }, 'POST', workspaceId)).run;
      captureUxObservation('requested-run', { id: request.id, runbookId, version: request.version, status: request.status,
        requestedBy: request.requestedBy, bindingDigest: request.bindingDigest, window });
      ensure(request.status === 'pending_approval' && request.requestedBy === 'user:' + users[0] && request.bindingDigest, 'ux01-uncertainty-pending-run');
      const self = await browserRequest(a, '/api/platform/v1/runbooks/runs/' + request.id + '/approve',
        { bindingDigest: request.bindingDigest }, 'POST', workspaceId);
      ensure(self.status === 403, 'ux01-uncertainty-self-approval-refusal');
      uxStage = 'approval';
      const beforeApprove = await runbookInventory(request.id);
      ensure(beforeApprove.window.id === window.id && beforeApprove.window.digest === window.digest &&
        beforeApprove.claimableRunIds.length === 0 && beforeApprove.activeRunIds.length === 0 && beforeApprove.activeScheduleIds.length === 0, 'ux01-uncertainty-approval-window');
      const runApprover = uxB;
      await runApprover.goto(stack.apiUrl + '/platform/runbooks/runs/' + request.id);
      const approvalResponse = runApprover.waitForResponse(value => value.url().endsWith('/runbooks/runs/' + request.id + '/approve') && value.request().method() === 'POST');
      await runApprover.getByRole('button', { name: 'Approve this run', exact: true }).click();
      const approvedResponse = await approvalResponse;
      ensure(approvedResponse.status() === 200, 'ux01-uncertainty-independent-approval');
      const approvedRun = await getRunbookRun(request.id);
      ensure(['approved', 'running'].includes(approvedRun.run.status) && approvedRun.run.bindingDigest === request.bindingDigest, 'ux01-uncertainty-approved-binding');
      const approvals = await psqlRead(`select coalesce(json_agg(json_build_object('requestedBy',requested_by,'approverId',approver_id,'bindingDigest',binding_digest) order by created_at), '[]'::json)::text
        from platform.machine_runbook_approvals where workspace_id=:'workspace_id' and binding_digest=:'binding_digest'`,
        { workspace_id: workspaceId, binding_digest: request.bindingDigest });
      ensure(approvals.length === 1 && approvals[0].requestedBy === 'user:' + users[0] && approvals[0].approverId === 'user:' + users[1] &&
        approvals[0].requestedBy !== approvals[0].approverId && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(users[0]) &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(users[1]), 'ux01-uncertainty-approval-identities');
      captureUxObservation('approval-accountability', { requestedBy: approvals[0].requestedBy, approverId: approvals[0].approverId,
        requesterAuthenticatedId: users[0], approverAuthenticatedId: users[1], bindingDigest: request.bindingDigest,
        selfApprovalStatus: self.status, independentApprovalStatus: approvedResponse.status() });
      ensure(approvals[0].requestedBy !== approvals[0].approverId, 'ux01-uncertainty-approval-identities');
      captureUxObservation('approval-complete', { request: { id: request.id, status: approvedRun.run.status,
        requestedBy: request.requestedBy, bindingDigest: request.bindingDigest }, approval: approvals[0],
        requesterAuthenticatedId: users[0], approverAuthenticatedId: users[1] });
      uxStage = 'execution-observation';

      const rawPoll = async () => {
        const windowRead = readUxExclusiveWindow({ stack, source, config });
        ensure(windowRead.id === window.id && windowRead.digest === window.digest, 'ux01-window-changed');
        const inventory = await runbookInventory(request.id);
        ensure(inventory.window.id === window.id && inventory.window.digest === window.digest, 'ux01-window-changed');
        const body = await getRunbookRun(request.id), audit = await runbookAudit(request.id);
        ensure(audit.length > 0 && auditChainValid(audit), 'ux01-uncertainty-audit-chain');
        const authorization = audit.filter(event => event.event === 'run.step.authorized');
        ensure(authorization.length <= 1, 'ux01-uncertainty-single-authorization');
        const join = authorization[0];
        const authorizationObservedAt = join ? elapsed() : undefined;
        const release = audit.find(event => event.event === 'run.released');
        const releaseObservedAt = release ? elapsed() : undefined;
        if (!join) return { inventory, body, audit, join, authorizationObservedAt, release, releaseObservedAt };
        const detail = await getDetail(join.detail.operationId);
        const machineRows = await machineRequests(join.detail.operationId, healthMachine.id);
        const requestObservedAt = machineRows.length === 1 ? elapsed() : undefined;
        const marker = await healthMachine.readUncertaintyMarker(witnessNonce).catch(() => null);
        const markerObservedAt = marker?.nonceMatch ? elapsed() : undefined;
        return { inventory, body, audit, join, authorizationObservedAt, release, releaseObservedAt, detail,
          machineRows, requestObservedAt, marker, markerObservedAt };
      };
      const jobAgeMs = row => {
        ensure(row && row.startedAt && row.observedAt && new Date(row.startedAt).toISOString() === row.startedAt &&
          new Date(row.observedAt).toISOString() === row.observedAt, 'ux01-scheduler-observation-time');
        return Date.parse(row.observedAt) - Date.parse(row.startedAt);
      };
      const matchesRunningFence = row => row?.job === 'runbooks' && row.source === 'temporal' && row.status === 'running' &&
        row.fence === schedulerRunningRow?.fence && jobAgeMs(row) >= 0 && jobAgeMs(row) < 15_000;
      const handoffReady = observed => {
        const stepRow = observed.body.steps?.find(value => value.targetIndex === 0 && value.id === 'hold') ??
          observed.body.steps?.find(value => value.targetIndex === 0 && value.stepId === 'hold');
        const join = observed.join;
        if (!join || observed.release || observed.body.run?.status !== 'running' || stepRow?.status !== 'started' ||
            join.detail.runbook !== runbookId || join.detail.version !== published.version.version ||
            join.detail.definitionDigest !== published.version.definitionDigest || join.detail.binding !== request.bindingDigest ||
            join.detail.target !== 0 || join.detail.step !== 'hold' || join.detail.stepOperationId !== stepRow.operationId ||
            stepRow.operationId !== 'rbs_' + createHash('sha256').update(`${request.id}\0${0}\0hold`).digest('hex').slice(0, 48) ||
            observed.detail?.operation?.status !== 'running' || observed.detail.operation.id !== join.detail.operationId ||
            observed.detail.operation.workspaceId !== workspaceId || observed.detail.operation.projectId !== project.id ||
            observed.detail.operation.environmentId !== environmentId || observed.detail.operation.resourceId !== healthResourceId ||
            observed.detail.operation.capability !== 'machine.exec') return null;
        const runbookStep = observed.detail.operation.proposal?.input?.runbookStep;
        const expectedTarget = { workspaceId, ...target };
        if (runbookStep?.runId !== request.id || runbookStep.stepId !== 'hold' || runbookStep.targetIndex !== 0 ||
            runbookStep.bindingDigest !== request.bindingDigest || !sameJson(runbookStep.target, expectedTarget) ||
            join.detail.operationId === join.detail.stepOperationId) return null;
        const rows = observed.machineRows;
        if (rows?.length !== 1 || rows[0].workspaceId !== workspaceId || rows[0].machineId !== healthMachine.id ||
            rows[0].operationId !== join.detail.operationId || rows[0].operation !== 'machine.exec' ||
            rows[0].capability !== 'machine.exec' || rows[0].status !== 'running' || !rows[0].startedAt ||
            new Date(rows[0].startedAt).toISOString() !== rows[0].startedAt || rows[0].settledAt !== null ||
            !observed.marker?.nonceMatch || !Number.isSafeInteger(observed.requestObservedAt) ||
            !Number.isSafeInteger(observed.markerObservedAt) || observed.requestObservedAt > observed.markerObservedAt) return null;
        return { observed, stepRow, runbookStep, requestRow: rows[0] };
      };
      let authorizationAt, requestStartedAt, markerObservedAt, abortAt, uncertainReadbackAt, uiAt;
      let handoff;
      let schedulerRunningRow;
      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline) {
        const job = await runbookJobRow();
        if (schedulerRunningRow && job?.fence !== schedulerRunningRow.fence) throw new Error('journey:ux01-scheduler-fence-changed');
        if (!schedulerRunningRow && job?.source === 'temporal' && job.status === 'running' && job.fence !== schedulerBefore?.fence) {
          schedulerRunningRow = job;
          captureUxObservation('scheduler-running', captureJob(job));
        }
        const observed = await rawPoll();
        ensure(observed.inventory.claimableRunIds.length === 0 && observed.inventory.activeRunIds.length === 0 && observed.inventory.activeScheduleIds.length === 0,
          'ux01-uncertainty-foreign-work');
        const candidateHandoff = handoffReady(observed);
        if (candidateHandoff) {
          ensure(schedulerRunningRow, 'ux01-scheduler-running-fence-required');
          const jobAfterMarkerRead = await runbookJobRow();
          ensure(matchesRunningFence(jobAfterMarkerRead), 'ux01-uncertainty-marker-budget-expired');
          const boundary = await rawPoll();
          ensure(boundary.inventory.claimableRunIds.length === 0 && boundary.inventory.activeRunIds.length === 0 && boundary.inventory.activeScheduleIds.length === 0,
            'ux01-uncertainty-foreign-work');
          const boundaryHandoff = handoffReady(boundary);
          const jobAfterBoundary = await runbookJobRow();
          ensure(boundaryHandoff && matchesRunningFence(jobAfterBoundary), 'ux01-uncertainty-live-boundary-lost');
          authorizationAt = boundary.authorizationObservedAt;
          requestStartedAt = boundary.requestObservedAt;
          markerObservedAt = boundary.markerObservedAt;
          handoff = { ...boundaryHandoff, schedulerAtMarker: jobAfterMarkerRead, schedulerAtBoundary: jobAfterBoundary };
          captureUxObservation('pre-abort-boundary', {
            schedulerRunning: captureJob(schedulerRunningRow), schedulerAfterMarker: captureJob(jobAfterMarkerRead),
            schedulerAfterEvidence: captureJob(jobAfterBoundary),
            run: captureRun(boundary.body), authorizationObservedAt: boundary.authorizationObservedAt,
            authorization: boundary.join, broker: captureOperation(boundary.detail), request: boundary.machineRows[0],
            requestObservedAt: boundary.requestObservedAt, marker: boundary.marker, markerObservedAt: boundary.markerObservedAt,
            releaseObserved: Boolean(boundary.release),
          });
          break;
        }
        await pause(100);
      }
      ensure(handoff && schedulerRunningRow && authorizationAt !== undefined && requestStartedAt !== undefined && markerObservedAt !== undefined &&
        authorizationAt <= requestStartedAt && requestStartedAt <= markerObservedAt,
        'ux01-uncertainty-running-marker-boundary');
      // The candidate observes only the existing critical Temporal job; it never invokes a global pass.
      let aborted;
      const abortDeadline = Date.now() + 30_000;
      while (Date.now() < abortDeadline) {
        const currentWindow = readUxExclusiveWindow({ stack, source, config });
        ensure(currentWindow.id === window.id && currentWindow.digest === window.digest, 'ux01-window-changed');
        const current = await rawPoll();
        ensure(current.inventory.claimableRunIds.length === 0 && current.inventory.activeRunIds.length === 0 && current.inventory.activeScheduleIds.length === 0,
          'ux01-uncertainty-foreign-work');
        const released = current.audit.find(event => event.event === 'run.released');
        if (released && released.detail?.reason !== 'caller_abort') throw new Error('journey:ux01-non-caller-abort-release');
        if (released) {
          abortAt = current.releaseObservedAt;
          aborted = current;
          captureUxObservation('caller-abort-observed', { run: captureRun(current.body), release: current.release,
            releaseObservedAt: current.releaseObservedAt, scheduler: captureJob(await runbookJobRow()) });
          break;
        }
        await pause(100);
      }
      ensure(aborted && aborted.body.run.status === 'running', 'ux01-uncertainty-caller-abort');
      let schedulerAfter;
      const schedulerFinishDeadline = Date.now() + 30_000;
      while (Date.now() < schedulerFinishDeadline) {
        const currentJob = await runbookJobRow();
        ensure(currentJob?.fence === schedulerRunningRow.fence, 'ux01-uncertainty-scheduler-fence-changed');
        if (currentJob.source === 'temporal' && currentJob.status === 'ok' && currentJob.finishedAt) {
          schedulerAfter = currentJob;
          break;
        }
        ensure(currentJob.source === 'temporal' && currentJob.status === 'running', 'ux01-uncertainty-critical-job-not-running');
        await pause(100);
      }
      ensure(schedulerAfter?.job === 'runbooks' && schedulerAfter.source === 'temporal' &&
        schedulerAfter.status === 'ok' && schedulerAfter.finishedAt && schedulerAfter.fence === schedulerRunningRow.fence &&
        Number(schedulerAfter.counts?.executed) === 1,
        'ux01-uncertainty-critical-job-provenance');
      captureUxObservation('scheduler-terminal', { running: captureJob(schedulerRunningRow), terminal: captureJob(schedulerAfter) });
      const uncertain = await getRunbookRun(request.id), auditAfter = await runbookAudit(request.id);
      captureUxObservation('uncertainty-readback', { run: captureRun(uncertain),
        release: auditAfter.find(event => event.event === 'run.released'), scheduler: captureJob(schedulerAfter) });
      ensure(auditChainValid(auditAfter), 'ux01-uncertainty-audit-chain');
      const stepUncertain = uncertain.steps?.find(value => value.targetIndex === 0 && (value.id === 'hold' || value.stepId === 'hold'));
      const releaseRows = auditAfter.filter(event => event.event === 'run.released' && event.detail?.reason === 'caller_abort');
      ensure(uncertain.run.status === 'running' && stepUncertain?.status === 'uncertain' && stepUncertain.errorCode === 'uncertain' &&
        releaseRows.length === 1 && releaseRows[0].createdAt, 'ux01-uncertainty-runbook-readback');
      const operationId = handoff.observed.join.detail.operationId;
      const brokerAfter = await getDetail(operationId);
      captureUxObservation('uncertain-broker-readback', { operation: captureOperation(brokerAfter),
        operationId, workspaceId });
      ensure(brokerAfter.operation.status === 'uncertain' && brokerAfter.operation.id === operationId, 'ux01-uncertainty-broker-readback');
      uncertainReadbackAt = elapsed();
      ensure(abortAt <= uncertainReadbackAt, 'ux01-uncertainty-readback-order');

      uxStage = 'ui';
      await uxA.goto(stack.apiUrl + '/platform/operations/' + operationId);
      await uxA.getByRole('heading', { name: 'Operation details', exact: true }).first().waitFor();
      ensure(new URL(uxA.url()).origin === stack.apiUrl && new URL(uxA.url()).pathname === '/platform/operations/' + operationId &&
        await uxA.getByRole('heading', { name: 'Operation details', exact: true }).count() === 1,
        'ux01-uncertainty-route-identity');
      const live = uxA.locator('[data-testid="journey-live"]:visible');
      await live.waitFor();
      ensure(await uxA.getByRole('region', { name: 'Progress', exact: true }).count() === 1 &&
        await live.getAttribute('role') === 'status' && await live.getAttribute('aria-live') === 'polite' &&
        await live.getAttribute('aria-atomic') === 'true', 'ux01-uncertainty-live-region');
      const liveText = await live.innerText();
      ensure(liveText.includes('Outcome uncertain') && liveText.includes('Zenith cannot prove whether this change happened. It will not guess and will not retry on its own.'),
        'ux01-uncertainty-honest-state');
      const callout = 'Outcome uncertain: do not assume it failed or succeeded';
      ensure(await uxA.getByText(callout, { exact: true }).count() === 1, 'ux01-uncertainty-callout');
      const nextSteps = [
        'Do not retry yet: the change may already have been applied.',
        'Open the resource state and wait for the next reconciliation, or check the cloud console directly.',
        'When you know the real state, propose a new operation for whatever is still missing.',
      ];
      const calloutRoot = uxA.getByText(callout, { exact: true }).locator('..').locator('..');
      const listItems = await calloutRoot.locator('ol > li').allInnerTexts();
      ensure(sameJson(listItems.map(value => value.trim()), nextSteps), 'ux01-uncertainty-next-steps');
      ensure((await uxA.getByText('Outcome unknown', { exact: true }).count()) >= 1 &&
        await uxA.getByRole('button', { name: 'Cancel operation', exact: true }).isDisabled() &&
        await uxA.getByText('Only an operation that has not started can be cancelled here.', { exact: true }).count() === 1,
        'ux01-uncertainty-disabled-controls');
      const uiRead = ok(await browserRequest(uxA, '/api/platform/v1/operations/' + operationId, undefined, 'GET', workspaceId));
      ensure(uiRead.operation.id === operationId && uiRead.operation.workspaceId === workspaceId && uiRead.operation.status === 'uncertain',
        'ux01-uncertainty-ui-api-identity');
      captureUxObservation('ui-api-before-scan', { operationId, status: uiRead.operation.status, workspaceId,
        route: new URL(uxA.url()).pathname, callout, nextSteps });
      const scans = uxCases.find(row => row.id === 'ux01-uncertainty-a11y').scans;
      await auditUx(uxA, 'operation-uncertain', axeSource, scans);
      const uiAfterScan = ok(await browserRequest(uxA, '/api/platform/v1/operations/' + operationId, undefined, 'GET', workspaceId));
      ensure(uiAfterScan.operation.id === operationId && uiAfterScan.operation.workspaceId === workspaceId &&
        uiAfterScan.operation.status === 'uncertain', 'ux01-uncertainty-ui-final-api');
      captureUxObservation('ui-api-after-scan', { operationId, status: uiAfterScan.operation.status, workspaceId });
      uxStage = 'closeout';
      uiAt = elapsed();

      // Close the actual run through the supported cancellation API; the normal scheduler reclaims it after its real lease.
      const cancelWindow = readUxExclusiveWindow({ stack, source, config });
      ensure(cancelWindow.id === uxOriginalWindow?.id && cancelWindow.digest === uxOriginalWindow?.digest, 'ux01-window-changed');
      const cancelResponse = await browserRequest(a, '/api/platform/v1/runbooks/runs/' + request.id + '/cancel',
        { reason: 'J2 uncertainty fixture closeout' }, 'POST', workspaceId);
      ensure(cancelResponse.status === 200, 'ux01-uncertainty-run-cancel-request');
      let closedRun;
      const closeDeadline = Date.now() + 360_000;
      while (Date.now() < closeDeadline) {
        const currentWindow = readUxExclusiveWindow({ stack, source, config });
        ensure(currentWindow.id === window.id && currentWindow.digest === window.digest, 'ux01-window-changed');
        const inventory = await runbookInventory(request.id);
        ensure(inventory.claimableRunIds.length === 0 && inventory.activeRunIds.length === 0 && inventory.activeScheduleIds.length === 0, 'ux01-uncertainty-closeout-foreign-work');
        const observed = await getRunbookRun(request.id);
        if (observed.run.status === 'cancelled') { closedRun = observed; break; }
        await pause(500);
      }
      ensure(closedRun?.steps?.filter(value => value.targetIndex === 0 && (value.id === 'hold' || value.stepId === 'hold')).length === 1 &&
        closedRun.steps.find(value => value.targetIndex === 0 && (value.id === 'hold' || value.stepId === 'hold')).status === 'uncertain',
        'ux01-uncertainty-cancelled-closeout');
      const stillUncertain = await getDetail(operationId);
      ensure(stillUncertain.operation.status === 'uncertain', 'ux01-uncertainty-broker-retained');
      const marker = await healthMachine.readUncertaintyMarker(witnessNonce);
      const beforeRevokeWindow = readUxExclusiveWindow({ stack, source, config });
      const latestInventory = await runbookInventory(request.id);
      ensure(beforeRevokeWindow.id === uxOriginalWindow?.id && beforeRevokeWindow.digest === uxOriginalWindow?.digest &&
        latestInventory.window.id === uxOriginalWindow.id && latestInventory.window.digest === uxOriginalWindow.digest &&
        latestInventory.claimableRunIds.length === 0 && latestInventory.activeRunIds.length === 0 && latestInventory.activeScheduleIds.length === 0,
        'ux01-uncertainty-pre-cleanup-window');
      const revoked = ok(await browserRequest(a, '/api/platform/v1/machines/' + healthMachine.id + '/revoke', {}, 'POST', workspaceId));
      ensure(revoked.id === healthMachine.id && revoked.status === 'revoked', 'ux01-uncertainty-machine-revoke');
      const machineRoster = ok(await browserRequest(a, '/api/platform/v1/machines', undefined, 'GET', workspaceId));
      const revokedReadback = machineRoster.machines?.find(value => value.id === healthMachine.id);
      ensure(revokedReadback?.status === 'revoked' && revokedReadback.environmentId === environmentId &&
        revokedReadback.address === witnessAddress, 'ux01-uncertainty-machine-revoke-readback');
      healthMachine.revocationConfirmed = true;
      const preStopWindow = readUxExclusiveWindow({ stack, source, config });
      const preStopInventory = await runbookInventory(request.id);
      ensure(preStopWindow.id === uxOriginalWindow?.id && preStopWindow.digest === uxOriginalWindow?.digest &&
        preStopInventory.window.id === uxOriginalWindow.id && preStopInventory.window.digest === uxOriginalWindow.digest &&
        preStopInventory.claimableRunIds.length === 0 && preStopInventory.activeRunIds.length === 0 &&
        preStopInventory.activeScheduleIds.length === 0, 'ux01-uncertainty-pre-stop-window');
      await healthMachine.quiesceOwned();
      const [stopped] = JSON.parse(await docker(['inspect', healthMachine.container]));
      ensure(/^[a-f0-9]{64}$/.test(stopped.Id?.replace(/^sha256:/, '') ?? '') &&
        stopped.Config.Labels?.['io.zenith.journey'] === healthMachine.runId && healthMachine.runId === runId + '-obs' &&
        stopped.State.Running === false,
        'ux01-uncertainty-container-containment');
      const finalRequests = await machineRequests(operationId, healthMachine.id), finalRun = await getRunbookRun(request.id);
      const finalAudit = await runbookAudit(request.id), finalBroker = await getDetail(operationId);
      ensure(finalRequests.length === 1 && finalAudit.filter(event => event.event === 'run.step.authorized').length === 1 &&
        auditChainValid(finalAudit) && finalRun.run.status === 'cancelled' &&
        finalRun.steps.find(value => value.targetIndex === 0 && (value.id === 'hold' || value.stepId === 'hold')).status === 'uncertain' &&
        finalBroker.operation.status === 'uncertain', 'ux01-uncertainty-final-joins');
      const finalWindow = readUxExclusiveWindow({ stack, source, config });
      ensure(finalWindow.id === uxOriginalWindow?.id && finalWindow.digest === uxOriginalWindow?.digest, 'ux01-window-changed');
      const closeoutObserved = elapsed();
      ensure(authorizationAt <= requestStartedAt && requestStartedAt <= markerObservedAt && markerObservedAt < abortAt &&
        abortAt <= uncertainReadbackAt && uncertainReadbackAt <= uiAt && uiAt < closeoutObserved, 'ux01-uncertainty-monotonic-order');
      healthMachine.uncertaintyContainmentProved = true;
      captureUxObservation('closeout', { requests: finalRequests, run: captureRun(finalRun),
        audit: finalAudit, broker: captureOperation(finalBroker), machine: { id: revokedReadback.id, status: revokedReadback.status,
          environmentId: revokedReadback.environmentId, address: revokedReadback.address },
        container: { id: stopped.Id, labels: { journey: stopped.Config.Labels?.['io.zenith.journey'] }, running: stopped.State.Running },
        window: finalWindow, inventory: { observedAt: latestInventory.observedAt, claimableRunIds: latestInventory.claimableRunIds,
          activeRunIds: latestInventory.activeRunIds, activeScheduleIds: latestInventory.activeScheduleIds } });
      uxStage = 'private-evidence-snapshot';
      persistUxPrivateDocument('.uncertainty-private.snapshot.json');
      healthMachine.uncertaintyEvidenceDurable = true;
      uxStage = 'closeout';
      const auditAuthorization = finalAudit.filter(event => event.event === 'run.step.authorized');
      const authorization = auditAuthorization[0];
      const finalStep = finalRun.steps.find(value => value.targetIndex === 0 && (value.id === 'hold' || value.stepId === 'hold'));
      const definitionDigest = published.version.definitionDigest;
      const actualTarget = handoff.observed.detail.operation.proposal.input.runbookStep.target;
      uxUncertaintyEvidence = {
        source: { commit: source.commit, sourceDigest: source.sourceDigest, imageDigest: config.machine.image.split('@sha256:')[1], fixtureRunId: runId },
        scheduler: { mode: 'existing_critical_job', budgetMs: 15000, preflightSha256: preflight.sha256,
          claimableRunIds: preflight.claimableRunIds, dueScheduleIds: preflight.activeScheduleIds, exclusiveWindowId: window.id },
        approval: { requesterId: users[0], approverId: users[1],
          bindingDigest: request.bindingDigest, selfApprovalStatus: self.status, approvalStatus: approvedResponse.status() },
        run: { id: request.id, runbookId, version: published.version.version, definitionDigest,
          bindingDigest: request.bindingDigest, workspaceId, projectId: project.id, environmentId, resourceId: healthResourceId,
          targetIndex: 0, statusBefore: handoff.observed.body.run.status, statusAfter: uncertain.run.status, releasedReason: releaseRows[0].detail.reason },
        step: { id: 'hold', targetIndex: 0, statusBefore: handoff.stepRow.status, statusAfter: stepUncertain.status,
          errorCode: stepUncertain.errorCode, deterministicOperationId: handoff.stepRow.operationId },
        audit: { sha256: canonicalDigest(finalAudit), authorizationCount: auditAuthorization.length,
          operationId, stepOperationId: authorization.detail.stepOperationId },
        broker: { operationId, statusBefore: 'running', statusAfter: stillUncertain.operation.status,
          workspaceId: stillUncertain.operation.workspaceId, projectId: stillUncertain.operation.projectId,
          environmentId: stillUncertain.operation.environmentId, resourceId: stillUncertain.operation.resourceId,
          runbookStep: { runId: request.id, stepId: 'hold', targetIndex: 0, target: actualTarget, bindingDigest: request.bindingDigest } },
        request: { id: handoff.requestRow.id, machineId: handoff.requestRow.machineId, workspaceId: handoff.requestRow.workspaceId,
          operationId: handoff.requestRow.operationId, operation: handoff.requestRow.operation, capability: handoff.requestRow.capability,
          statusBefore: handoff.requestRow.status, startedAt: handoff.requestRow.startedAt, settledAt: handoff.requestRow.settledAt },
        marker: marker,
        order: { authorization: authorizationAt, requestStarted: requestStartedAt, markerObserved: markerObservedAt,
          abort: abortAt, uncertainReadback: uncertainReadbackAt, ui: uiAt },
        ui: { operationId, persistedStatus: uiAfterScan.operation.status, uncertainState: true, callout, nextSteps },
        closeout: { runStatus: finalRun.run.status, stepStatus: finalStep.status, brokerStatus: finalBroker.operation.status,
          machineId: healthMachine.id, machineStatus: revokedReadback.status, containerId: stopped.Id.replace(/^sha256:/, ''),
          containerRunLabel: stopped.Config.Labels['io.zenith.journey'], containerRunning: stopped.State.Running,
          requestCount: finalRequests.length, authorizationCount: auditAuthorization.length, observed: closeoutObserved },
      };
      ensure(uxUncertaintyEvidence.run.statusBefore === 'running' && uxUncertaintyEvidence.run.statusAfter === 'running' &&
        uxUncertaintyEvidence.step.statusBefore === 'started' && uxUncertaintyEvidence.step.statusAfter === 'uncertain' &&
        uxUncertaintyEvidence.audit.stepOperationId === uxUncertaintyEvidence.step.deterministicOperationId &&
        uxUncertaintyEvidence.audit.operationId !== uxUncertaintyEvidence.audit.stepOperationId &&
        uxUncertaintyEvidence.request.statusBefore === 'running' && uxUncertaintyEvidence.request.settledAt === null &&
        uxUncertaintyEvidence.closeout.machineStatus === 'revoked' && uxUncertaintyEvidence.closeout.containerRunning === false,
        'ux01-uncertainty-closed-provenance');
      captureUxObservation('monotonic-order', { authorization: authorizationAt, requestStarted: requestStartedAt,
        markerObserved: markerObservedAt, abort: abortAt, uncertainReadback: uncertainReadbackAt, ui: uiAt, closeout: closeoutObserved });
      uxStage = 'complete';

    });
    await step('connection-rotation-readback', async () => {
      const rotated = ok(await browserRequest(b, '/api/platform/v1/connections/' + project.connectionId + '/rotate',
        { patch: { credentialRef: 'vault:J2_NEW_KUBE' }, promote: false }, 'POST', workspaceId));
      ensure(rotated.ok && rotated.data?.status === 'verified' && rotated.data?.verified === true, 'rotation-candidate-verification');
      const rotationId = rotated.data.rotationId;
      ok(await browserRequest(b, '/api/platform/v1/connections/' + project.connectionId + '/rotation/promote',
        { rotationId }, 'POST', workspaceId));
      // Destroy ONLY the named old local fixture identity. New traffic must use
      // the rotated credential; a successful response alone cannot prove it.
      await command('kubectl', ['--kubeconfig', config.kind.observerKubeconfigFile, '--context', config.kind.context,
        '-n', config.kind.namespace, 'delete', 'serviceaccount', 'j2-deployer-old']);
      await scale('mcp', 2); readbacks.rotatedKind = await kindReadback(config, 2, witnessNonce);
    });
    await step('connection-revocation-no-fallback', async () => {
      const pending = await mcp(stack, linked.token, 'tools/call', { name: 'zenith_scale_service',
        arguments: { target: { workspaceId, projectId: project.id, environmentId }, serviceId, replicas: 1, idempotencyKey: nonce() } });
      await approve(pending.data.operationId, true);
      await b.goto(stack.apiUrl + '/platform/connections');
      const card = b.getByRole('listitem').filter({ hasText: 'J2 kind ' + runId });
      await card.getByRole('button', { name: 'Revoke', exact: true }).click();
      await card.getByLabel('Type the connection id to confirm', { exact: true }).fill(project.connectionId);
      const revoked = b.waitForResponse(value => value.url().endsWith('/connections/' + project.connectionId + '/revoke') && value.request().method() === 'POST');
      await card.getByRole('button', { name: 'Revoke connection', exact: true }).click();
      const revokedResponse = await revoked;
      ensure(revokedResponse.ok() && (await revokedResponse.json()).ok === true, 'connection-browser-revocation');
      const connection = ok(await browserRequest(a, '/api/platform/v1/connections/' + project.connectionId,
        undefined, 'GET', workspaceId)).connection;
      ensure(connection.status === 'revoked' && connection.revokedAt, 'connection-terminal-revocation');
      const execute = await mcp(stack, linked.token, 'tools/call', { name: 'zenith_execute_approved_operation',
        arguments: { workspaceId, operationId: pending.data.operationId, expectedDigest: pending.data.proposalDigest } }, true);
      const envelope = execute.data?.result?.structuredContent;
      ensure(execute.status < 500 && !execute.data?.error, 'revocation-engine-or-protocol-failure');
      if (execute.status >= 400 || execute.data?.result?.isError || envelope?.ok === false) {
        ensure(envelope?.ok === false && ['connection_revoked', 'connection_unavailable', 'binding_revoked'].includes(envelope.error?.code),
          'revocation-authority-refusal-required');
      } else {
        ensure(envelope?.ok === true && envelope.simulated === false && envelope.truncated === false &&
          envelope.unavailable?.length === 0 && envelope.data?.workflow?.id, 'revocation-real-workflow-required');
        const terminal = await until(() => getDetail(pending.data.operationId),
          value => ['failed', 'uncertain', 'succeeded'].includes(value.operation.status));
        ensure(terminal.operation.status === 'failed' && /no usable provider connection|connection.*revoked|binding.*revoked/i.test(terminal.operation.error ?? ''),
          'revocation-dispatch-terminal');
      }
      await pause(2000);
      await kindReadback(config, 2, witnessNonce);
      const verify = await browserRequest(a, '/api/platform/v1/connections/' + project.connectionId + '/verify', {}, 'POST', workspaceId);
      ensure(verify.status < 500 && verify.data.ok === false && /revoked/i.test(verify.data.error ?? ''), 'revoked-verification');
      // The witness binding's current machine is the health machine; the customer machine was revoked at handoff.
      if (!healthMachine.revocationConfirmed) {
        const machineRevocationResponse = ok(await browserRequest(b, '/api/platform/v1/machines/' + healthMachine.id + '/revoke', {}, 'POST', workspaceId));
        ensure(machineRevocationResponse.id === healthMachine.id && machineRevocationResponse.status === 'revoked', 'machine-revocation');
        healthMachine.revocationConfirmed = true;
        const stoppedAgent = await until(async () => JSON.parse(await command('docker', ['inspect', healthMachine.container])),
          value => value[0].State.Running === false);
        ensure(stoppedAgent.length === 1 && stoppedAgent[0].Config.Labels?.['io.zenith.journey'] === healthMachine.runId &&
          stoppedAgent[0].State.ExitCode === 3, 'machine-native-revoked-exit-code');
      }
      const roster = ok(await browserRequest(a, '/api/platform/v1/machines', undefined, 'GET', workspaceId)).machines;
      for (const id of [machine.id, healthMachine.id]) {
        const row = roster.find(value => value.id === id);
        ensure(row?.status === 'revoked' && row.revokedAt, 'machine-revocation-durable-readback');
      }
    });
    await step('machine-fresh-token-native-rejoin', async () => {
      const oldId = machine.id;
      const oldName = machine.container;
      // Set uncertainty before the POST: a lost response cannot prove no token was issued.
      machine.freshTokenState = 'unconfirmed';
      const issued = ok(await browserRequest(a, '/api/platform/v1/runners/tokens', {
        kind: 'machine', ttlMinutes: 1, binding: { environmentId: machineEnv, address: witnessAddress },
      }, 'POST', workspaceId));
      ensure(issued.kind === 'machine' && issued.shownOnce && issued.workspaceId === workspaceId && Date.parse(issued.expiresAt) > Date.now(),
        'machine-fresh-token-consent');
      await machine.rejoin(issued.token);
      ensure(machine.rejoinedId && machine.rejoinedId !== oldId && machine.container !== oldName, 'machine-fresh-native-identity');
      const joined = await machine.registered(a, workspaceId);
      ensure(joined.id === machine.rejoinedId && joined.id !== oldId && joined.connection?.state === 'online', 'machine-rejoin-real-heartbeat');
      const rows = ok(await browserRequest(a, '/api/platform/v1/machines', undefined, 'GET', workspaceId)).machines;
      const oldRow = rows.find(value => value.id === oldId), newRow = rows.find(value => value.id === machine.rejoinedId);
      ensure(oldRow?.status === 'revoked' && oldRow.revokedAt && newRow?.status === 'active' && newRow.environmentId === machineEnv &&
        newRow.address === witnessAddress && newRow.lastHeartbeatAt && Date.parse(newRow.lastHeartbeatAt) >= Date.parse(newRow.registeredAt),
        'machine-old-revoked-new-bound-active');
      // Only this same-bound control-plane row readback proves native token consumption.
      machine.freshTokenState = 'consumed-confirmed';
      readbacks.machineRejoin = sha256({ oldId, oldStatus: oldRow.status, oldRevokedAt: Boolean(oldRow.revokedAt),
        freshId: newRow.id, freshStatus: newRow.status, environmentId: newRow.environmentId, address: newRow.address,
        registeredAt: newRow.registeredAt, lastHeartbeatAt: newRow.lastHeartbeatAt,
        identityChanged: newRow.id !== oldRow.id, connectionOnline: joined.connection.state === 'online' });
    });
  } catch { failed = true; }
  finally {
    try {
      await step('cleanup', async () => {
        const cleanupFailures = [];
        const attempt = async (id, work) => {
          try { await work(); } catch { cleanupFailures.push(id); }
        };
        if (runnerCustodyMarker) {
          if (runnerProcess) await stopRunner();
          if (!runnerCaseSucceeded) throw new Error('journey:runner-setup-or-case-retained');
        }
        if (runnerConnectionId && b && workspaceId) await attempt('runner-connection-revoke', async () => {
          const result = ok(await browserRequest(b, '/api/platform/v1/connections/' + runnerConnectionId + '/revoke',
            { confirm: runnerConnectionId, reason: 'J2 journey cleanup' }, 'POST', workspaceId));
          ensure(result.ok === true, 'runner-connection-revoke');
        });
        if (!runnerId && runnerName && a && workspaceId) await attempt('runner-id-readback-for-cleanup', async () => {
          const roster = ok(await browserRequest(a, '/api/platform/v1/runners', undefined, 'GET', workspaceId));
          runnerId = roster.runners?.find(value => value.name === runnerName)?.id;
        });
        if (runnerId && a && workspaceId) await attempt('runner-registration-revoke', async () => {
          const result = ok(await browserRequest(a, '/api/platform/v1/runners/' + runnerId + '/revoke', {}, 'POST', workspaceId));
          ensure(result.id === runnerId && result.status === 'revoked', 'runner-registration-revoke');
        });
        if (runnerServiceAccount) {
          ensure(typeof config?.kind?.observerKubeconfigFile === 'string', 'runner-rbac-kubeconfig-required');
          for (const kind of ['rolebinding', 'role', 'serviceaccount']) await command('kubectl', [
            '--kubeconfig', config.kind.observerKubeconfigFile, '-n', config.kind.namespace,
            'delete', kind, runnerServiceAccount, '--ignore-not-found=true',
          ]);
        }
        if (runnerDir && fs.existsSync(runnerDir)) await attempt('runner-private-files-cleanup', async () => {
          fs.rmSync(runnerDir, { recursive: true, force: true });
          ensure(!fs.existsSync(runnerDir), 'runner-private-files-remain');
        });
        let healthRevoked = !healthMachine || healthMachine.revocationConfirmed === true;
        if (healthMachine?.id && a && workspaceId && !healthRevoked) await attempt('health-machine-revoke', async () => {
          const revoked = ok(await browserRequest(a, '/api/platform/v1/machines/' + healthMachine.id + '/revoke', {}, 'POST', workspaceId));
          ensure(revoked.id === healthMachine.id && revoked.status === 'revoked', 'health-machine-revocation');
          healthRevoked = true; healthMachine.revocationConfirmed = true;
        });
        if (healthMachine && !healthRevoked) {
          await healthMachine.quiesceOwned();
          throw new Error('journey:health-machine-revocation-unconfirmed-retain');
        }
        // A cleanup helper rejection may mean Docker is still settling its command.
        if (healthMachine && healthRevoked) {
          if (healthMachine.uncertaintyCustody) {
            uxStage = 'outer-cleanup';
            ensure(healthMachine.uncertaintyContainmentProved && healthMachine.uncertaintyEvidenceDurable && uxUncertaintyEvidence?.closeout?.containerRunning === false,
              'ux01-uncertainty-cleanup-custody');
            const cleanupWindow = readUxExclusiveWindow({ stack, source, config });
            ensure(cleanupWindow.id === uxOriginalWindow?.id && cleanupWindow.digest === uxOriginalWindow?.digest &&
              cleanupWindow.id === process.env.ZENITH_UX01_EXCLUSIVE_WINDOW_ID, 'ux01-window-changed');
            const cleanupInventory = await runbookInventory(uxUncertaintyEvidence.run.id);
            ensure(cleanupInventory.window.id === uxOriginalWindow.id && cleanupInventory.window.digest === uxOriginalWindow.digest &&
              cleanupInventory.claimableRunIds.length === 0 && cleanupInventory.activeRunIds.length === 0 && cleanupInventory.activeScheduleIds.length === 0,
              'ux01-uncertainty-cleanup-window');
            healthMachine.uncertaintyCustody = false;
            try { await healthMachine.cleanup(); }
            catch (error) { healthMachine.uncertaintyCustody = true; throw error; }
          } else {
            await healthMachine.cleanup();
          }
          if (healthMachine.uncertaintyContainmentProved) { uxOuterCleanupComplete = true; uxStage = 'complete'; }
        }
        let machinesRevoked = !machine;
        if (machine && a && workspaceId) await attempt('machine-revoke-owned-identities', async () => {
          await machine.revokeOwnedMachines(a, workspaceId);
          machinesRevoked = true;
        });
        const tokenLifecycleCertain = !machine || machine.freshTokenState === 'not-requested' ||
          machine.freshTokenState === 'consumed-confirmed';
        // Unknown token issuance/consumption or failed revocation retains the owned fixture.
        if (machine && (!machinesRevoked || !tokenLifecycleCertain)) {
          await machine.quiesceOwned();
          throw new Error(!machinesRevoked ? 'journey:machine-revocation-unconfirmed-retain' :
            'journey:machine-token-lifecycle-unconfirmed-retain');
        }
        // A helper rejection may mean a Docker creator is still settling; propagate before later cleanup.
        if (machine && machinesRevoked && tokenLifecycleCertain) await machine.cleanup();
        if (linked && a) await attempt('linked-agent-revoke', async () => {
          ok(await browserRequest(a, '/api/integrations/agent/link/revoke', { credentialId: linked.credentialId }));
        });
        for (const id of users) await attempt('auth-user-delete', async () => {
          ok(await jsonRequest(stack.supabaseUrl + '/auth/v1/admin/users/' + id, { method: 'DELETE', headers: adminHeaders(stack) }));
        });
        if (a) await attempt('browser-context-a-close', () => a.context().close());
        if (b) await attempt('browser-context-b-close', () => b.context().close());
        if (uxBrowser) await attempt('ux01-chrome-close', () => uxBrowser.close());
        ensure(cleanupFailures.length === 0, 'cleanup-incomplete');
        if (runnerCustodyMarker) {
          fs.lstatSync(runnerCustodyMarker);
          fs.unlinkSync(runnerCustodyMarker);
          runnerCustodyMarker = undefined;
        }
      });
    } catch { if (UX_ENABLED) markUxFailure(); failed = true; }
    if (UX_ENABLED && uxUncertaintyEvidence && !uxOuterCleanupComplete) {
      markUxFailure();
      uxStage = 'outer-cleanup-failed';
    }
    if (UX_ENABLED && uxPrivateObservations.length > 0) {
      try {
        persistUxPrivateDocument('.uncertainty-private.json');
      } catch { uxStage = 'private-evidence-final-write'; markUxFailure(); failed = true; }
    }
    const result = { ...source, checks: facts, readbacks };
    // A failed step makes the projected status failed, so its receipt names the real failing check;
    // without it the runner can only record a generic prerequisites failure.
    if (process.env.ZENITH_JOURNEY_RECEIPT && (!failed || facts.some(fact => fact.status === 'failed'))) {
      writeReceipt(process.env.ZENITH_JOURNEY_RECEIPT, result);
    }
    // Separate UX receipt: the existing 16-id J2 receipt vocabulary is unchanged.
    if (UX_ENABLED) {
      const uxInput = { source: { commit: source.commit, sourceDigest: source.sourceDigest, dirty: source.dirty },
        cases: uxCases, uncertainty: uxUncertaintyEvidence ?? null };
      try { writeUxReceipt(process.env.ZENITH_UX01_RECEIPT, uxInput); }
      catch (error) {
        // A refused receipt keeps its own input beside it (owner-private, never a receipt) so the refusal can be replayed.
        fs.writeFileSync(process.env.ZENITH_UX01_RECEIPT + '.rejected.json', JSON.stringify(uxInput, null, 2), { mode: 0o600, flag: 'wx' });
        throw error;
      }
    }
    ensure(!failed && receipt(result).status === 'passed', 'journey-incomplete');
  }
});
