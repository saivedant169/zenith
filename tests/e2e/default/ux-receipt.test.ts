import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CHECKS, receipt as projectJourneyReceipt } from './receipt.mjs';
import { assertUxAcceptance, makeUxReceipt, writeUxReceipt, UX_CASES, UX_TAGS, UX_VIEWPORT_LABELS, validateCompletedJourney, validateUxReceipt } from './ux-receipt.mjs';

const source = { commit: 'a'.repeat(40), sourceDigest: 'b'.repeat(64), dirty: false };
type UxCaseStatus = 'passed' | 'failed' | 'not_run';
type UxInputCase = {
  id: string;
  status: UxCaseStatus;
  scans: { pageId: string; viewport: string; violations: { id: string; impact?: string | null }[]; horizontalOverflow: boolean }[];
};
type UxReceiptCase = {
  id: string;
  status: UxCaseStatus;
  scans: { pageId: string; viewport: string; violations: { id: string; impact?: string | null }[]; horizontalOverflow: boolean }[];
};
type UxUncertaintyEvidence = {
  source: { commit: string; sourceDigest: string; imageDigest: string; fixtureRunId: string };
  scheduler: { mode: string; budgetMs: number; preflightSha256: string; claimableRunIds: string[]; dueScheduleIds: string[]; exclusiveWindowId: string };
  approval: { requesterId: string; approverId: string; bindingDigest: string; selfApprovalStatus: number; approvalStatus: number };
  run: { id: string; runbookId: string; version: number; definitionDigest: string; bindingDigest: string; workspaceId: string; projectId: string; environmentId: string; resourceId: string; targetIndex: number; statusBefore: string; statusAfter: string; releasedReason: string };
  step: { id: string; targetIndex: number; statusBefore: string; statusAfter: string; errorCode: string; deterministicOperationId: string };
  audit: { sha256: string; authorizationCount: number; operationId: string; stepOperationId: string };
  broker: { operationId: string; statusBefore: string; statusAfter: string; workspaceId: string; projectId: string; environmentId: string; resourceId: string; runbookStep: { runId: string; stepId: string; targetIndex: number; target: { workspaceId: string; transport: string; targetId: string; environmentId: string; resourceId: string; address: string }; bindingDigest: string } };
  request: { id: string; machineId: string; workspaceId: string; operationId: string; operation: string; capability: string; statusBefore: string; startedAt: string; settledAt: string | null };
  marker: { sha256: string; nonceMatch: boolean };
  order: { authorization: number; requestStarted: number; markerObserved: number; abort: number; uncertainReadback: number; ui: number };
  ui: { operationId: string; persistedStatus: string; uncertainState: boolean; callout: string; nextSteps: string[] };
  closeout: { runStatus: string; stepStatus: string; brokerStatus: string; machineId: string; machineStatus: string; containerId: string; containerRunLabel: string; containerRunning: boolean; requestCount: number; authorizationCount: number; observed: number };
};
type UxInput = { source: typeof source; cases: UxInputCase[]; uncertainty: UxUncertaintyEvidence | null };
const uncertaintyEvidence = (): UxUncertaintyEvidence => {
  const runId = '11111111-1111-4111-8111-111111111111';
  const machineId = 'machine_test';
  const operationId = 'operation_broker_test';
  const bindingDigest = 'f'.repeat(64);
  const fixtureRunId = 'd'.repeat(24);
  return {
    source: { commit: source.commit, sourceDigest: source.sourceDigest, imageDigest: 'c'.repeat(64), fixtureRunId },
    scheduler: { mode: 'existing_critical_job', budgetMs: 15000, preflightSha256: '2'.repeat(64), claimableRunIds: [], dueScheduleIds: [], exclusiveWindowId: 'ux01_window_test' },
    approval: { requesterId: 'admin_requester', approverId: 'admin_approver', bindingDigest, selfApprovalStatus: 403, approvalStatus: 200 },
    run: { id: runId, runbookId: 'j2-123456789012345678901234', version: 1, definitionDigest: 'e'.repeat(64), bindingDigest,
      workspaceId: 'workspace_test', projectId: 'project_test', environmentId: 'environment_test', resourceId: 'resource_test', targetIndex: 0,
      statusBefore: 'running', statusAfter: 'running', releasedReason: 'caller_abort' },
    step: { id: 'hold', targetIndex: 0, statusBefore: 'started', statusAfter: 'uncertain', errorCode: 'uncertain',
      deterministicOperationId: `rbs_${createHash('sha256').update(`${runId}\0${0}\0hold`).digest('hex').slice(0, 48)}` },
    audit: { sha256: '1'.repeat(64), authorizationCount: 1, operationId, stepOperationId: `rbs_${createHash('sha256').update(`${runId}\0${0}\0hold`).digest('hex').slice(0, 48)}` },
    broker: { operationId, statusBefore: 'running', statusAfter: 'uncertain', workspaceId: 'workspace_test', projectId: 'project_test',
      environmentId: 'environment_test', resourceId: 'resource_test', runbookStep: { runId, stepId: 'hold', targetIndex: 0,
        target: { workspaceId: 'workspace_test', transport: 'zenithd', targetId: machineId, environmentId: 'environment_test', resourceId: 'resource_test', address: 'container_service/witness' }, bindingDigest } },
    request: { id: 'request_test', machineId, workspaceId: 'workspace_test', operationId, operation: 'machine.exec', capability: 'machine.exec',
      statusBefore: 'running', startedAt: '2026-10-11T00:00:00.000Z', settledAt: null },
    marker: { sha256: '3'.repeat(64), nonceMatch: true },
    order: { authorization: 1, requestStarted: 2, markerObserved: 3, abort: 4, uncertainReadback: 5, ui: 6 },
    ui: { operationId, persistedStatus: 'uncertain', uncertainState: true, callout: 'Outcome uncertain: do not assume it failed or succeeded', nextSteps: [
      'Do not retry yet: the change may already have been applied.',
      'Open the resource state and wait for the next reconciliation, or check the cloud console directly.',
      'When you know the real state, propose a new operation for whatever is still missing.',
    ] },
    closeout: { runStatus: 'cancelled', stepStatus: 'uncertain', brokerStatus: 'uncertain', machineId, machineStatus: 'revoked',
      containerId: '4'.repeat(64), containerRunLabel: `${fixtureRunId}-obs`, containerRunning: false, requestCount: 1, authorizationCount: 1, observed: 7 },
  };
};
const uxInput = (): UxInput => ({ source, uncertainty: null, cases: UX_CASES.map(spec => {
  const status: UxCaseStatus = spec.id === 'ux01-uncertainty-a11y' ? 'not_run' : 'passed';
  return { id: spec.id, status, scans: status === 'not_run' ? [] : spec.pages.flatMap(pageId => UX_VIEWPORT_LABELS.map(viewport => ({
    pageId, viewport, violations: [], horizontalOverflow: false,
  }))) };
}) });
const completeUxInput = (): UxInput => {
  const input = uxInput();
  const uncertaintyCase = input.cases.find(row => row.id === 'ux01-uncertainty-a11y');
  if (!uncertaintyCase) throw new Error('UX input is missing the uncertainty case.');
  uncertaintyCase.status = 'passed';
  uncertaintyCase.scans = UX_VIEWPORT_LABELS.map(viewport => ({ pageId: 'operation-uncertain', viewport, violations: [], horizontalOverflow: false }));
  input.uncertainty = uncertaintyEvidence();
  return input;
};
const journey = () => projectJourneyReceipt({
  commit: source.commit, sourceDigest: source.sourceDigest, dirty: source.dirty,
  platform: 'darwin', arch: 'arm64', dockerArch: 'aarch64', node: '22.23.3', docker: '28.5.0',
  checks: CHECKS.map(id => ({ id, status: 'passed' })),
  readbacks: Object.fromEntries(['kind', 'machine', 'rotatedKind', 'obs02', 'machineRejoin'].map(target => [target, randomBytes(32).toString('hex')])),
  telemetryStates: { metric: 'unknown', log: 'empty', event: 'fresh', trace: 'unknown', health: 'fresh', healthSilent: 'unknown', healthRevoked: 'inaccessible' },
});

describe('PROD-UX-01 actual-browser receipt contract', () => {
  it('refuses to create a receipt in an owned but non-private parent', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zenith-ux01-receipt-'));
    const file = path.join(directory, 'ux.json');
    try {
      fs.chmodSync(directory, 0o755);
      expect(() => writeUxReceipt(file, uxInput())).toThrow('ux01:private-receipt-required');
      expect(fs.existsSync(file)).toBe(false);
    } finally {
      fs.chmodSync(directory, 0o700);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('preserves the existing scan shape and makes the unimplemented uncertainty case incomplete', () => {
    const receipt = makeUxReceipt(uxInput());
    expect(receipt).toMatchObject({ requirementId: 'PROD-UX-01', kind: 'actual_browser', result: 'incomplete',
      counts: { passed: 7, failed: 0, not_run: 1 }, axeTags: [...UX_TAGS], viewports: [...UX_VIEWPORT_LABELS] });
    const uncertainty = receipt.cases.find((row: UxReceiptCase) => row.id === 'ux01-uncertainty-a11y');
    if (!uncertainty) throw new Error('UX receipt is missing the uncertainty case.');
    expect(uncertainty).toMatchObject({ status: 'not_run', scans: [] });
    const operationReview = receipt.cases.find((row: UxReceiptCase) => row.id === 'ux01-operation-review-a11y');
    if (!operationReview) throw new Error('UX receipt is missing the operation review case.');
    const firstScan = operationReview.scans[0];
    if (!firstScan) throw new Error('UX operation review case is missing its first viewport scan.');
    expect(firstScan).toEqual({
      pageId: 'operation-requester-review', viewport: '1280x900', violations: [], horizontalOverflow: false,
    });
    expect(validateUxReceipt(receipt)).toBe(receipt);
  });

  it('rejects duplicate, invented or semantically reordered case and scan identities', () => {
    const duplicate = uxInput(); duplicate.cases[1].id = duplicate.cases[0].id;
    expect(() => makeUxReceipt(duplicate)).toThrow('ux01:receipt-invalid');
    const reordered = uxInput(); [reordered.cases[0], reordered.cases[1]] = [reordered.cases[1], reordered.cases[0]];
    expect(() => makeUxReceipt(reordered)).toThrow('ux01:receipt-invalid');
    const forgedPage = makeUxReceipt(uxInput());
    forgedPage.cases[0].scans[0].pageId = 'unregistered-page';
    expect(() => validateUxReceipt(forgedPage)).toThrow('ux01:receipt-invalid');
    const repeatedScan = uxInput(); repeatedScan.cases[0].scans[1].viewport = '1280x900';
    expect(() => makeUxReceipt(repeatedScan)).toThrow('ux01:receipt-invalid');
  });

  it('joins only a clean, complete J2 receipt with all eight browser evidence groups', () => {
    const browser = makeUxReceipt(completeUxInput());
    expect(assertUxAcceptance(browser, journey())).toBe(true);
    expect(() => assertUxAcceptance(browser, { ...journey(), sourceDigest: 'c'.repeat(64) })).toThrow('ux01:receipt-invalid');
    expect(() => assertUxAcceptance(browser, { ...journey(), dirty: true, ledgerEligible: false })).toThrow('ux01:receipt-invalid');
    const tamperedJourney = journey(); tamperedJourney.counts.passed -= 1;
    expect(() => assertUxAcceptance(browser, tamperedJourney)).toThrow('ux01:receipt-invalid');
    const uncertaintyPassed = uxInput();
    const uncertaintyCase = uncertaintyPassed.cases.find(row => row.id === 'ux01-uncertainty-a11y');
    if (!uncertaintyCase) throw new Error('UX input is missing the uncertainty case.');
    uncertaintyCase.status = 'passed';
    expect(() => makeUxReceipt(uncertaintyPassed)).toThrow('ux01:receipt-invalid');
  });

  it('requires a closed, joined uncertainty proof and both uncertainty viewport scans to pass', () => {
    const complete = makeUxReceipt(completeUxInput());
    expect(complete).toMatchObject({ schemaVersion: 2, result: 'passed', counts: { passed: 8, failed: 0, not_run: 0 }, uncertainty: { marker: { nonceMatch: true } } });
    expect(complete.cases.find((row: UxReceiptCase) => row.id === 'ux01-uncertainty-a11y')?.scans).toHaveLength(2);
    expect(assertUxAcceptance(complete, journey())).toBe(true);

    const { uncertainty: legacyProof, ...legacyFields } = makeUxReceipt(uxInput());
    expect(legacyProof).toBeNull();
    const oldSevenScreen = { ...legacyFields, schemaVersion: 1 };
    expect(validateUxReceipt(oldSevenScreen)).toBe(oldSevenScreen);
    expect(() => assertUxAcceptance(oldSevenScreen, journey())).toThrow('ux01:receipt-invalid');

    const noProof = completeUxInput(); noProof.uncertainty = null;
    expect(() => makeUxReceipt(noProof)).toThrow('ux01:receipt-invalid');
    for (const count of [0, 1]) {
      const partial = completeUxInput();
      const row = partial.cases.find(item => item.id === 'ux01-uncertainty-a11y');
      if (!row) throw new Error('UX input is missing the uncertainty case.');
      row.scans = row.scans.slice(0, count);
      expect(() => makeUxReceipt(partial)).toThrow('ux01:receipt-invalid');
    }
    const duplicateViewport = completeUxInput();
    const duplicateRow = duplicateViewport.cases.find(item => item.id === 'ux01-uncertainty-a11y');
    if (!duplicateRow) throw new Error('UX input is missing the uncertainty case.');
    const firstUncertaintyScan = duplicateRow.scans[0];
    if (!firstUncertaintyScan) throw new Error('UX uncertainty case is missing its first viewport scan.');
    duplicateRow.scans[1] = { ...firstUncertaintyScan };
    expect(() => makeUxReceipt(duplicateViewport)).toThrow('ux01:receipt-invalid');
  });

  it('rejects malformed or mismatched causal uncertainty evidence', () => {
    const rejects = (mutate: (proof: UxUncertaintyEvidence) => void) => {
      const input = completeUxInput();
      const proof = input.uncertainty;
      if (!proof) throw new Error('UX input is missing uncertainty evidence.');
      mutate(proof);
      expect(() => makeUxReceipt(input)).toThrow('ux01:receipt-invalid');
    };
    rejects(proof => { proof.source.commit = 'bad'; });
    rejects(proof => { proof.source.imageDigest = 'bad'; });
    rejects(proof => { proof.scheduler.mode = 'manual'; });
    rejects(proof => { proof.scheduler.budgetMs = 10000; });
    rejects(proof => { proof.scheduler.claimableRunIds = ['foreign_run']; });
    rejects(proof => { proof.scheduler.dueScheduleIds = ['foreign_schedule']; });
    rejects(proof => { proof.approval.requesterId = proof.approval.approverId; });
    rejects(proof => { proof.approval.bindingDigest = '0'.repeat(64); });
    rejects(proof => { proof.run.statusAfter = 'cancelled'; });
    rejects(proof => { proof.step.deterministicOperationId = 'operation_broker_test'; });
    rejects(proof => { proof.audit.sha256 = 'bad'; });
    rejects(proof => { proof.audit.operationId = 'different_operation'; });
    rejects(proof => { proof.audit.authorizationCount = 2; });
    rejects(proof => { proof.broker.operationId = proof.step.deterministicOperationId; });
    rejects(proof => { proof.broker.runbookStep.runId = 'different_run'; });
    rejects(proof => { proof.broker.runbookStep.target.targetId = 'different_machine'; });
    rejects(proof => { proof.broker.runbookStep.target.resourceId = 'different_resource'; });
    rejects(proof => { proof.request.statusBefore = 'queued'; });
    rejects(proof => { proof.request.startedAt = 'not-a-time'; });
    rejects(proof => { proof.request.startedAt = '2026-10-11T00:00:00Z'; });
    rejects(proof => { Reflect.set(proof.request, 'startedAt', null); });
    rejects(proof => { proof.request.operationId = 'different_operation'; });
    rejects(proof => { proof.request.settledAt = '2026-10-11T00:00:01.000Z'; });
    rejects(proof => { proof.marker.sha256 = 'bad'; });
    rejects(proof => { proof.marker.nonceMatch = false; });
    rejects(proof => { proof.order.abort = proof.order.markerObserved; });
    rejects(proof => { proof.ui.uncertainState = false; });
    rejects(proof => { proof.ui.callout = 'Outcome unknown'; });
    rejects(proof => { proof.ui.nextSteps[1] = 'Retry the operation.'; });
    rejects(proof => { proof.closeout.machineStatus = 'active'; });
    rejects(proof => { proof.closeout.runStatus = 'running'; });
    rejects(proof => { proof.closeout.containerRunning = true; });
    rejects(proof => { proof.closeout.requestCount = 2; });

    const mismatchedCounts = makeUxReceipt(completeUxInput());
    mismatchedCounts.counts.passed = 7;
    expect(() => validateUxReceipt(mismatchedCounts)).toThrow('ux01:receipt-invalid');

    const extraKey = completeUxInput();
    if (!extraKey.uncertainty) throw new Error('UX input is missing uncertainty evidence.');
    Reflect.set(extraKey.uncertainty.marker, 'nonce', 'must-not-be-projected');
    expect(() => makeUxReceipt(extraKey)).toThrow('ux01:receipt-invalid');
    const missingKey = completeUxInput();
    if (!missingKey.uncertainty) throw new Error('UX input is missing uncertainty evidence.');
    Reflect.deleteProperty(missingKey.uncertainty.closeout, 'containerId');
    expect(() => makeUxReceipt(missingKey)).toThrow('ux01:receipt-invalid');

    const violation = completeUxInput();
    const violationCase = violation.cases.find(item => item.id === 'ux01-uncertainty-a11y');
    if (!violationCase) throw new Error('UX input is missing the uncertainty case.');
    const violationScan = violationCase.scans[0];
    if (!violationScan) throw new Error('UX uncertainty case is missing its first viewport scan.');
    violationScan.violations.push({ id: 'color-contrast', impact: 'serious' });
    expect(() => makeUxReceipt(violation)).toThrow('ux01:receipt-invalid');
    const overflow = completeUxInput();
    const overflowCase = overflow.cases.find(item => item.id === 'ux01-uncertainty-a11y');
    if (!overflowCase) throw new Error('UX input is missing the uncertainty case.');
    const overflowScan = overflowCase.scans[0];
    if (!overflowScan) throw new Error('UX uncertainty case is missing its first viewport scan.');
    overflowScan.horizontalOverflow = true;
    expect(() => makeUxReceipt(overflow)).toThrow('ux01:receipt-invalid');
    const failedPartial = completeUxInput();
    const failedCase = failedPartial.cases.find(item => item.id === 'ux01-uncertainty-a11y');
    if (!failedCase) throw new Error('UX input is missing the uncertainty case.');
    failedCase.status = 'failed';
    failedCase.scans = [{ pageId: 'operation-uncertain', viewport: '1280x900',
      violations: [{ id: 'color-contrast', impact: 'serious' }], horizontalOverflow: false }];
    failedPartial.uncertainty = null;
    const retainedFailure = makeUxReceipt(failedPartial);
    expect(retainedFailure).toMatchObject({ result: 'failed', counts: { passed: 7, failed: 1, not_run: 0 } });
    expect(retainedFailure.cases.find((row: UxReceiptCase) => row.id === 'ux01-uncertainty-a11y')).toMatchObject({
      status: 'failed', scans: [{ pageId: 'operation-uncertain', viewport: '1280x900', violations: [{ id: 'color-contrast', impact: 'serious' }] }],
    });
  });
  it("joins a real two-architecture Linux J2 receipt, including its recorded telemetry states", () => {
    for (const arch of ["amd64", "arm64"]) {
      const journey = JSON.parse(fs.readFileSync(`docs/build/production/evidence/PROD-OBS-02/2026-10-23-00aad583-clean-host-j2-${arch}.json`, "utf8"));
      expect(() => validateCompletedJourney(journey)).not.toThrow();
      expect(() => validateCompletedJourney({ ...journey, telemetryStates: { ...journey.telemetryStates, metric: "not-a-state" } })).toThrow(/receipt-invalid/);
      expect(() => validateCompletedJourney({ ...journey, environment: { ...journey.environment, host: "Windows AMD64" } })).toThrow(/receipt-invalid/);
    }
  });
});

