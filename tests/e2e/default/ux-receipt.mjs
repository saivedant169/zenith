import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { CHECKS, receipt as projectJourneyReceipt } from './receipt.mjs';

export const UX_VIEWPORTS = Object.freeze([{ width: 1280, height: 900 }, { width: 375, height: 900 }]);
export const UX_VIEWPORT_LABELS = Object.freeze(UX_VIEWPORTS.map(value => `${value.width}x${value.height}`));
export const UX_TAGS = Object.freeze(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']);
export const UX_CASES = Object.freeze([
  { id: 'ux01-operation-review-a11y', pages: ['operation-requester-review'] },
  { id: 'ux01-independent-approval-a11y', pages: ['operation-before-independent-approval', 'operation-after-independent-approval'] },
  { id: 'ux01-replan-reapproval-a11y', pages: ['operation-reapproval-required'] },
  { id: 'ux01-cancel-operation-a11y', pages: ['operation-pending-cancel', 'operation-cancelled'] },
  { id: 'ux01-legacy-projection-a11y', pages: ['linked-workflow-deployment'] },
  { id: 'ux01-runbook-approval-progress-a11y', pages: ['runbook-pending-approval'] },
  { id: 'ux01-readiness-a11y', pages: ['platform-readiness'] },
  { id: 'ux01-uncertainty-a11y', pages: ['operation-uncertain'] },
]);
export const UX_IDS = Object.freeze(UX_CASES.map(value => value.id));
const CASE_IDS = new Set(UX_IDS);
const LEGACY_UX_CASES = Object.freeze(UX_CASES.map((item, index) => index === UX_CASES.length - 1 ? { ...item, pages: [] } : item));
const STATUSES = new Set(['passed', 'failed', 'not_run']);
const HEX40 = /^[a-f0-9]{40}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const invalid = () => { throw new Error('ux01:receipt-invalid'); };
const exactKeys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join('\0') === [...expected].sort().join('\0');

function projectSource(source) {
  return {
    commit: HEX40.test(source?.commit ?? '') ? source.commit : null,
    sourceDigest: HEX64.test(source?.sourceDigest ?? '') ? source.sourceDigest : null,
    dirty: typeof source?.dirty === 'boolean' ? source.dirty : null,
  };
}

/**
 * @typedef {'passed' | 'failed' | 'not_run'} UxInputStatus
 * @typedef {{id: string, impact?: string | null}} UxInputViolation
 * @typedef {{pageId: string, viewport: string, violations: UxInputViolation[], horizontalOverflow: boolean}} UxInputScan
 * @typedef {{id: string, status: UxInputStatus, scans: UxInputScan[]}} UxInputCase
 * @typedef {{commit?: string, sourceDigest?: string, dirty?: boolean}} UxInputSource
 * @typedef {{source?: UxInputSource, cases?: UxInputCase[], uncertainty?: unknown}} UxReceiptInput
 */

/** Projects only the closed J2 UX vocabulary and the existing scan row shape.
 * @param {UxReceiptInput} input
 */
export function makeUxReceipt(input = {}) {
  const { source, cases, uncertainty = null } = input;
  if (!Array.isArray(cases) || cases.length !== UX_CASES.length) invalid();
  const seen = new Set();
  const rows = cases.map(row => {
    if (!row || !CASE_IDS.has(row.id) || seen.has(row.id) || !STATUSES.has(row.status) || !Array.isArray(row.scans)) invalid();
    seen.add(row.id);
    return { id: row.id, status: row.status, scans: row.scans.map(scan => ({
      pageId: scan?.pageId,
      viewport: scan?.viewport,
      violations: Array.isArray(scan?.violations) ? scan.violations.map(value => ({ id: value?.id, ...(value?.impact === undefined ? {} : { impact: value.impact }) })) : scan?.violations,
      horizontalOverflow: scan?.horizontalOverflow,
    })) };
  });
  if (seen.size !== UX_CASES.length) invalid();
  const counts = Object.fromEntries(['passed', 'failed', 'not_run'].map(status => [status, rows.filter(row => row.status === status).length]));
  const receipt = {
    schemaVersion: 2,
    requirementId: 'PROD-UX-01',
    kind: 'actual_browser',
    browser: 'Google Chrome via Playwright',
    viewports: [...UX_VIEWPORT_LABELS],
    axeTags: [...UX_TAGS],
    source: projectSource(source),
    counts,
    result: counts.failed ? 'failed' : counts.not_run ? 'incomplete' : 'passed',
    cases: rows,
    uncertainty,

  };
  validateUxReceipt(receipt);
  return receipt;
}

/** Checks receipt shape, closed uncertainty provenance, and historical incomplete evidence. */
const ID_RE = /^[A-Za-z0-9_-]{1,200}$/;
const RUNBOOK_ID_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const FIXTURE_RUN_ID_RE = /^[a-f0-9]{24}$/;
const CONTAINER_ID_RE = /^[a-f0-9]{64}$/;
const isoTimestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const elapsedMs = value => Number.isSafeInteger(value) && value >= 0;
const identifier = value => typeof value === 'string' && ID_RE.test(value);
const digest = value => typeof value === 'string' && HEX64.test(value);

function validateUncertainty(value, receiptSource) {
  const keys = ['source', 'scheduler', 'approval', 'run', 'step', 'audit', 'broker', 'request', 'marker', 'order', 'ui', 'closeout'];
  if (!exactKeys(value, keys) || !exactKeys(value.source, ['commit', 'sourceDigest', 'imageDigest', 'fixtureRunId']) ||
      !exactKeys(value.scheduler, ['mode', 'budgetMs', 'preflightSha256', 'claimableRunIds', 'dueScheduleIds', 'exclusiveWindowId']) ||
      !exactKeys(value.approval, ['requesterId', 'approverId', 'bindingDigest', 'selfApprovalStatus', 'approvalStatus']) ||
      !exactKeys(value.run, ['id', 'runbookId', 'version', 'definitionDigest', 'bindingDigest', 'workspaceId', 'projectId', 'environmentId', 'resourceId', 'targetIndex', 'statusBefore', 'statusAfter', 'releasedReason']) ||
      !exactKeys(value.step, ['id', 'targetIndex', 'statusBefore', 'statusAfter', 'errorCode', 'deterministicOperationId']) ||
      !exactKeys(value.audit, ['sha256', 'authorizationCount', 'operationId', 'stepOperationId']) ||
      !exactKeys(value.broker, ['operationId', 'statusBefore', 'statusAfter', 'workspaceId', 'projectId', 'environmentId', 'resourceId', 'runbookStep']) ||
      !exactKeys(value.broker.runbookStep, ['runId', 'stepId', 'targetIndex', 'target', 'bindingDigest']) ||
      !exactKeys(value.broker.runbookStep.target, ['workspaceId', 'transport', 'targetId', 'environmentId', 'resourceId', 'address']) ||
      !exactKeys(value.request, ['id', 'machineId', 'workspaceId', 'operationId', 'operation', 'capability', 'statusBefore', 'startedAt', 'settledAt']) ||
      !exactKeys(value.marker, ['sha256', 'nonceMatch']) ||
      !exactKeys(value.order, ['authorization', 'requestStarted', 'markerObserved', 'abort', 'uncertainReadback', 'ui']) ||
      !exactKeys(value.ui, ['operationId', 'persistedStatus', 'uncertainState', 'callout', 'nextSteps']) ||
      !exactKeys(value.closeout, ['runStatus', 'stepStatus', 'brokerStatus', 'machineId', 'machineStatus', 'containerId', 'containerRunLabel', 'containerRunning', 'requestCount', 'authorizationCount', 'observed'])) invalid();

  const { source, scheduler, approval, run, step, audit, broker, request, marker, order, ui, closeout } = value;
  if (typeof source.commit !== 'string' || !HEX40.test(source.commit) || !digest(source.sourceDigest) || !digest(source.imageDigest) ||
      typeof source.fixtureRunId !== 'string' || !FIXTURE_RUN_ID_RE.test(source.fixtureRunId) || source.commit !== receiptSource.commit || source.sourceDigest !== receiptSource.sourceDigest ||
      !['existing_critical_job', 'authenticated_fallback'].includes(scheduler.mode) || scheduler.budgetMs !== 15000 ||
      !digest(scheduler.preflightSha256) || !Array.isArray(scheduler.claimableRunIds) || scheduler.claimableRunIds.length !== 0 ||
      !Array.isArray(scheduler.dueScheduleIds) || scheduler.dueScheduleIds.length !== 0 || !identifier(scheduler.exclusiveWindowId) ||
      !identifier(approval.requesterId) || !identifier(approval.approverId) || approval.requesterId === approval.approverId ||
      approval.bindingDigest !== run.bindingDigest || approval.selfApprovalStatus !== 403 || approval.approvalStatus !== 200 ||
      !identifier(run.id) || typeof run.runbookId !== 'string' || !RUNBOOK_ID_RE.test(run.runbookId) || !Number.isSafeInteger(run.version) || run.version < 1 ||
      !digest(run.definitionDigest) || !digest(run.bindingDigest) || !identifier(run.workspaceId) || !identifier(run.projectId) ||
      !identifier(run.environmentId) || !identifier(run.resourceId) || run.targetIndex !== 0 || run.statusBefore !== 'running' ||
      run.statusAfter !== 'running' || run.releasedReason !== 'caller_abort' || step.id !== 'hold' || step.targetIndex !== 0 ||
      step.statusBefore !== 'started' || step.statusAfter !== 'uncertain' || step.errorCode !== 'uncertain' ||
      !identifier(step.deterministicOperationId) || !digest(audit.sha256) || audit.authorizationCount !== 1 ||
      !identifier(audit.operationId) || !identifier(audit.stepOperationId) || audit.stepOperationId !== step.deterministicOperationId ||
      !identifier(broker.operationId) || broker.operationId === step.deterministicOperationId || broker.statusBefore !== 'running' ||
      broker.statusAfter !== 'uncertain' || broker.workspaceId !== run.workspaceId || broker.projectId !== run.projectId ||
      broker.environmentId !== run.environmentId || broker.resourceId !== run.resourceId ||
      !identifier(broker.runbookStep.runId) || broker.runbookStep.runId !== run.id || broker.runbookStep.stepId !== step.id ||
      broker.runbookStep.targetIndex !== 0 || broker.runbookStep.bindingDigest !== run.bindingDigest ||
      broker.runbookStep.target.workspaceId !== run.workspaceId || broker.runbookStep.target.transport !== 'zenithd' ||
      !identifier(broker.runbookStep.target.targetId) || broker.runbookStep.target.environmentId !== run.environmentId ||
      broker.runbookStep.target.resourceId !== run.resourceId || broker.runbookStep.target.address !== 'container_service/witness' ||
      !identifier(request.id) || request.machineId !== broker.runbookStep.target.targetId || request.workspaceId !== run.workspaceId ||
      request.operation !== 'machine.exec' || request.capability !== 'machine.exec' || request.statusBefore !== 'running' ||
      !isoTimestamp(request.startedAt) || request.settledAt !== null ||
      !digest(marker.sha256) || marker.nonceMatch !== true ||
      audit.operationId !== broker.operationId || broker.operationId !== request.operationId || request.operationId !== ui.operationId ||
      !['authorization', 'requestStarted', 'markerObserved', 'abort', 'uncertainReadback', 'ui'].every(key => elapsedMs(order[key])) ||
      !(order.authorization <= order.requestStarted && order.requestStarted <= order.markerObserved &&
        order.markerObserved < order.abort && order.abort <= order.uncertainReadback && order.uncertainReadback <= order.ui) ||
      ui.persistedStatus !== 'uncertain' || ui.uncertainState !== true ||
      ui.callout !== 'Outcome uncertain: do not assume it failed or succeeded' || !Array.isArray(ui.nextSteps) ||
      JSON.stringify(ui.nextSteps) !== JSON.stringify([
        'Do not retry yet: the change may already have been applied.',
        'Open the resource state and wait for the next reconciliation, or check the cloud console directly.',
        'When you know the real state, propose a new operation for whatever is still missing.',
      ]) || closeout.runStatus !== 'cancelled' || closeout.stepStatus !== 'uncertain' || closeout.brokerStatus !== 'uncertain' ||
      closeout.machineId !== request.machineId || closeout.machineStatus !== 'revoked' || typeof closeout.containerId !== 'string' || !CONTAINER_ID_RE.test(closeout.containerId) ||
      closeout.containerRunLabel !== `${source.fixtureRunId}-obs` || closeout.containerRunning !== false || closeout.requestCount !== 1 ||
      closeout.authorizationCount !== 1 || !elapsedMs(closeout.observed) || closeout.observed <= order.ui) invalid();

  const expectedStepOperation = `rbs_${createHash('sha256').update(`${run.id}\0${0}\0hold`).digest('hex').slice(0, 48)}`;
  if (step.deterministicOperationId !== expectedStepOperation) invalid();
}

function validateReceipt(value, schemaVersion) {
  const old = schemaVersion === 1;
  const topKeys = ['schemaVersion', 'requirementId', 'kind', 'browser', 'viewports', 'axeTags', 'source', 'counts', 'result', 'cases', ...(old ? [] : ['uncertainty'])];
  if (!exactKeys(value, topKeys) || value.schemaVersion !== schemaVersion || value.requirementId !== 'PROD-UX-01' || value.kind !== 'actual_browser' ||
      value.browser !== 'Google Chrome via Playwright' || JSON.stringify(value.viewports) !== JSON.stringify(UX_VIEWPORT_LABELS) ||
      JSON.stringify(value.axeTags) !== JSON.stringify(UX_TAGS) || !exactKeys(value.source, ['commit', 'sourceDigest', 'dirty']) ||
      !(value.source.commit === null || (typeof value.source.commit === 'string' && HEX40.test(value.source.commit))) ||
      !(value.source.sourceDigest === null || (typeof value.source.sourceDigest === 'string' && HEX64.test(value.source.sourceDigest))) ||
      !(value.source.dirty === null || typeof value.source.dirty === 'boolean') ||
      !exactKeys(value.counts, ['passed', 'failed', 'not_run']) || !Array.isArray(value.cases) || value.cases.length !== UX_CASES.length) invalid();
  const seen = new Set();
  const specs = old ? LEGACY_UX_CASES : UX_CASES;
  for (const [index, row] of value.cases.entries()) {
    if (!exactKeys(row, ['id', 'status', 'scans']) || row.id !== UX_IDS[index] || !CASE_IDS.has(row.id) || seen.has(row.id) ||
        !STATUSES.has(row.status) || !Array.isArray(row.scans) || (old && index === UX_CASES.length - 1 && row.status !== 'not_run')) invalid();
    seen.add(row.id);
    const spec = specs.find(item => item.id === row.id);
    if (row.status === 'not_run' && row.scans.length !== 0) invalid();
    const expected = spec.pages.flatMap(pageId => UX_VIEWPORT_LABELS.map(viewport => ({ pageId, viewport })));
    if (row.scans.length > expected.length || (row.status === 'passed' && row.scans.length !== expected.length)) invalid();
    row.scans.forEach((scan, scanIndex) => {
      const pair = expected[scanIndex];
      if (!pair || !exactKeys(scan, ['pageId', 'viewport', 'violations', 'horizontalOverflow']) ||
          scan.pageId !== pair.pageId || scan.viewport !== pair.viewport || !Array.isArray(scan.violations) ||
          typeof scan.horizontalOverflow !== 'boolean') invalid();
      for (const violation of scan.violations) {
        if (!violation || Array.isArray(violation) || typeof violation !== 'object' ||
            !['id', 'id,impact'].includes(Object.keys(violation).sort().join(',')) || typeof violation.id !== 'string' ||
            (violation.impact !== undefined && violation.impact !== null && typeof violation.impact !== 'string')) invalid();
      }
      if (row.status === 'passed' && (scan.violations.length !== 0 || scan.horizontalOverflow)) invalid();
    });
  }
  if (seen.size !== UX_CASES.length) invalid();
  const counts = Object.fromEntries(['passed', 'failed', 'not_run'].map(status => [status, value.cases.filter(row => row.status === status).length]));
  const result = counts.failed ? 'failed' : counts.not_run ? 'incomplete' : 'passed';
  if (JSON.stringify(value.counts) !== JSON.stringify(counts) || value.result !== result) invalid();
  if (old) {
    if (value.result !== 'incomplete' || JSON.stringify(counts) !== JSON.stringify({ passed: 7, failed: 0, not_run: 1 })) invalid();
  } else {
    const uncertaintyCase = value.cases.find(row => row.id === 'ux01-uncertainty-a11y');
    if (value.uncertainty !== null) validateUncertainty(value.uncertainty, value.source);
    if (uncertaintyCase.status === 'passed' && value.uncertainty === null) invalid();
  }
  return value;
}

/** Checks receipt structure without promoting incomplete/failed observations. */
export function validateUxReceipt(value) {
  if (value?.schemaVersion === 1) return validateReceipt(value, 1);
  if (value?.schemaVersion === 2) return validateReceipt(value, 2);
  invalid();
}

function validateCompletedJourney(value) {
  if (!exactKeys(value, ['schemaVersion', 'requirementIds', 'kind', 'status', 'productionReady', 'ledgerEligible', 'commit', 'sourceDigest', 'dirty', 'environment', 'counts', 'checks', 'readbacks', 'evidence']) ||
      value.schemaVersion !== 1 || JSON.stringify(value.requirementIds) !== JSON.stringify(['PROD-PKG-05', 'PROD-DUR-03', 'PROD-DUR-04', 'PROD-LIFE-01', 'PROD-MACH-05', 'PROD-OBS-02', 'PROD-MACH-04', 'PROD-PKG-02']) ||
      value.kind !== 'local_engine' || value.status !== 'passed' || value.productionReady !== false || value.ledgerEligible !== true || value.dirty !== false ||
      !HEX40.test(value.commit ?? '') || !HEX64.test(value.sourceDigest ?? '') ||
      !exactKeys(value.environment, ['host', 'architectureEvidence', 'node', 'docker', 'profile', 'scope']) ||
      value.environment.host !== 'macOS ARM64' || value.environment.architectureEvidence !== 'native' ||
      !exactKeys(value.counts, ['passed', 'failed', 'skipped', 'not_run']) || !Array.isArray(value.checks) || value.checks.length !== CHECKS.length ||
      value.counts.passed !== CHECKS.length || value.counts.failed !== 0 || value.counts.skipped !== 0 || value.counts.not_run !== 0 ||
      !Array.isArray(value.readbacks) || value.readbacks.length !== 5 || JSON.stringify(value.readbacks.map(row => row?.target)) !== JSON.stringify(['kind', 'machine', 'rotatedKind', 'obs02', 'machineRejoin']) ||
      !exactKeys(value.evidence, ['level', 'commit', 'command', 'environment', 'result', 'logs']) ||
      value.evidence.level !== 'local_engine' || value.evidence.commit !== value.commit) invalid();
  const ids = new Set();
  for (const [index, check] of value.checks.entries()) {
    if (!exactKeys(check, ['id', 'status']) || check.id !== CHECKS[index] || ids.has(check.id) || check.status !== 'passed') invalid();
    ids.add(check.id);
  }
  if (ids.size !== CHECKS.length || value.readbacks.some(row => !exactKeys(row, ['target', 'sha256']) || !HEX64.test(row.sha256 ?? ''))) invalid();
  const projected = projectJourneyReceipt({
    commit: value.commit, sourceDigest: value.sourceDigest, dirty: value.dirty,
    platform: 'darwin', arch: 'arm64', dockerArch: 'aarch64',
    node: value.environment.node, docker: value.environment.docker,
    checks: value.checks,
    readbacks: Object.fromEntries(value.readbacks.map(row => [row.target, row.sha256])),
  });
  if (JSON.stringify(projected) !== JSON.stringify(value)) invalid();
}

/** Requires all eight audited UX groups and their closed uncertainty provenance. */
export function assertUxAcceptance(ux, journey) {
  validateUxReceipt(ux);
  validateCompletedJourney(journey);
  if (ux.schemaVersion !== 2 || ux.result !== 'passed' || ux.counts.passed !== 8 || ux.counts.failed !== 0 || ux.counts.not_run !== 0 ||
      ux.source.commit !== journey.commit || ux.source.sourceDigest !== journey.sourceDigest || ux.source.dirty !== false || ux.source.commit === null ||
      ux.source.sourceDigest === null || ux.cases.filter(row => row.status === 'passed').length !== 8 || ux.uncertainty === null) invalid();
  return true;
}

export function writeUxReceipt(file, input) {
  const output = makeUxReceipt(input);
  const destination = path.resolve(file);
  const parent = fs.lstatSync(path.dirname(destination));
  if (typeof process.getuid !== 'function' || !parent.isDirectory() || parent.isSymbolicLink() ||
      parent.uid !== process.getuid() || (parent.mode & 0o777) !== 0o700) {
    throw new Error('ux01:private-receipt-required');
  }
  fs.writeFileSync(destination, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  return output;
}
