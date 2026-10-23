import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { CHECKS, receipt } from './receipt.mjs';

type ReadbackFixture = {
  kind: string;
  machine: string;
  rotatedKind: string;
  obs02: string;
  machineRejoin?: string;
};

const input = () => {
  const readbacks: ReadbackFixture = {
    kind: randomBytes(32).toString('hex'), machine: randomBytes(32).toString('hex'),
    rotatedKind: randomBytes(32).toString('hex'), obs02: randomBytes(32).toString('hex'),
    machineRejoin: randomBytes(32).toString('hex'),
  };
  return {
    commit: randomBytes(20).toString('hex'), sourceDigest: randomBytes(32).toString('hex'), dirty: false,
    platform: 'darwin', arch: 'arm64', dockerArch: 'aarch64', node: '22.23.3', docker: '28.5.0',
    checks: CHECKS.map(id => ({ id, status: 'passed' })), readbacks,
  };
};

describe('default journey evidence projection (contract only)', () => {
  it('emits ledger format only for a complete native clean-tree run', () => {
    const result = receipt(input());
    expect(result.status).toBe('passed');
    expect(result.ledgerEligible).toBe(true);
    expect(result.counts).toEqual({ passed: CHECKS.length, failed: 0, skipped: 0, not_run: 0 });
    expect(result.evidence?.level).toBe('local_engine');
    expect(result.productionReady).toBe(false);
  });
  it('labels a native Linux AMD64 default-profile run honestly and refuses a mismatched engine', () => {
    const linux = receipt({ ...input(), platform: 'linux', arch: 'x64', dockerArch: 'x86_64', profile: 'default' });
    expect(linux.status).toBe('passed');
    expect(linux.environment).toMatchObject({ host: 'Linux AMD64', architectureEvidence: 'native', profile: 'default' });
    expect(linux.evidence?.environment).toContain('Linux AMD64; native AMD64 Docker');
    const emulated = receipt({ ...input(), platform: 'linux', arch: 'x64', dockerArch: 'aarch64' });
    expect(emulated.environment.architectureEvidence).toBe('unconfirmed');
    expect(emulated.status).not.toBe('passed');
    expect(receipt({ ...input(), platform: 'win32', arch: 'x64', dockerArch: 'x86_64' }).environment.host).toBe('unsupported');
    expect(receipt(input()).environment).toMatchObject({ host: 'macOS ARM64', architectureEvidence: 'native', profile: 'lean' });
  });
  it('does not retain nested secrets, paths, arbitrary keys or hostile diagnostics', () => {
    const canary = randomBytes(24).toString('base64url');
    const result = receipt({ ...input(), password: canary, token: canary,
      environment: { HOME: `/Users/${canary}`, Authorization: canary },
      readbacks: { kind: canary, machine: randomBytes(32).toString('hex'), arbitrary: canary },
      checks: CHECKS.map(id => ({ id, status: 'passed', stderr: canary, error: { secret: canary } })),
    });
    expect(JSON.stringify(result)).not.toContain(canary);
    expect(result.readbacks).toHaveLength(1);
  });
  it.each(['failed', 'skipped', 'not_run'])('never turns a %s check into passing evidence', status => {
    const fixture = input();
    fixture.checks[3].status = status;
    const result = receipt(fixture);
    expect(result.status).not.toBe('passed');
    expect(result.evidence).toBeNull();
    expect(result.counts.passed).toBe(CHECKS.length - 1);
  });
  it('reports partial progress with exact not-run counts', () => {
    const result = receipt({ ...input(), checks: [{ id: 'prerequisites', status: 'passed' }, { id: 'auth-admin-mailpit', status: 'failed' }] });
    expect(result.counts).toEqual({ passed: 1, failed: 1, skipped: 0, not_run: CHECKS.length - 2 });
  });
  it.each([
    [{ id: 'invented', status: 'passed' }],
    [{ id: 'prerequisites', status: 'unsupported' }],
    [{ id: 'prerequisites', status: 'passed' }, { id: 'prerequisites', status: 'passed' }],
  ])('rejects untrusted check identity/status and duplicate counting (case %j)', (...checks) => {
    // Vitest expands the row; preserve the actual list of facts.
    expect(() => receipt({ ...input(), checks })).toThrow('journey:receipt-checks');
  });
  it.each([
    { dirty: true }, { commit: '' }, { sourceDigest: '' }, { dockerArch: 'x86_64' }, { platform: 'win32' },
  ])('withholds ledger evidence from an unbound, dirty or nonnative run (case %j)', patch => {
    expect(receipt({ ...input(), ...patch }).ledgerEligible).toBe(false);
  });
  it('scrubs untrusted version text', () => {
    const secret = randomBytes(24).toString('hex');
    expect(JSON.stringify(receipt({ ...input(), node: secret, docker: `/Users/${secret}` }))).not.toContain(secret);
  });
});

describe('default journey opt-in gate', () => {
  it('skips without reading a config, credentials or starting a subprocess', async () => {
    const { run } = await import('../../../scripts/acceptance/default-journey.mjs');
    const previous = process.env.ZENITH_DEFAULT_JOURNEY;
    delete process.env.ZENITH_DEFAULT_JOURNEY;
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      expect(run(['--config', 'file-that-must-not-be-read'])).toBe(0);
      const data = JSON.parse(String(spy.mock.calls[0][0]));
      expect(data.status).toBe('skipped');
      expect(data.counts).toEqual({ passed: 0, failed: 0, skipped: 1, not_run: CHECKS.length - 1 });
      expect(data.evidence).toBeNull();
    } finally {
      spy.mockRestore();
      if (previous === undefined) delete process.env.ZENITH_DEFAULT_JOURNEY;
      else process.env.ZENITH_DEFAULT_JOURNEY = previous;
    }
  });
  it('requires all independent readback hashes for passing evidence', () => {
    expect(receipt({ ...input(), readbacks: {} }).status).toBe('incomplete');
  });
  it('requires a SHA-256 machine-rejoin readback while preserving the other four hashes', () => {
    const fixture = input();
    delete fixture.readbacks.machineRejoin;
    const result = receipt(fixture);
    expect(result.status).toBe('incomplete');
    expect(result.readbacks.map(value => value.target)).toEqual(['kind', 'machine', 'rotatedKind', 'obs02']);
  });
  it('records only closed-vocabulary PROD-OBS-02 envelope states and no free-text log pointer', () => {
    const result = receipt({ ...input(), telemetryStates: { metric: 'unknown', log: 'fresh', event: 'not-a-state', healthSilent: 'unknown', healthRevoked: 'inaccessible', extra: 'fresh', reason: 'secret text' } });
    expect(result.telemetryStates).toEqual({ metric: 'unknown', log: 'fresh', healthSilent: 'unknown', healthRevoked: 'inaccessible' });
    expect(JSON.stringify(result)).not.toContain('secret text');
    expect(result.evidence?.logs ?? null).toBeNull();
  });
});

