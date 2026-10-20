import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { CHECKS, receipt as projectJourneyReceipt } from './receipt.mjs';

type JourneyCheckInput = { id: string; status: string };
type JourneyReadbackInput = { target: string; sha256: string };
type JourneyCheck = { id: string; status: string };
type JourneyReadback = { target: string; sha256: string };
type JourneyReceipt = {
  status: string;
  productionReady: boolean;
  ledgerEligible: boolean;
  requirementIds: string[];
  checks: JourneyCheck[];
  readbacks: JourneyReadback[];
};
type JsonRecord = Record<string, unknown>;

const enabled = process.env.ZENITH_TEST_J2_RECEIPT === '1';
const gated = describe.skipIf(!enabled);

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isArrayOf<T>(value: unknown, guard: (item: unknown) => item is T): value is T[] {
  return Array.isArray(value) && value.every((item: unknown) => guard(item));
}

function isJourneyCheckInput(value: unknown): value is JourneyCheckInput {
  return isRecord(value) && typeof value.id === 'string' && typeof value.status === 'string';
}

function isJourneyReadbackInput(value: unknown): value is JourneyReadbackInput {
  return isRecord(value) && typeof value.target === 'string' && typeof value.sha256 === 'string';
}

function isJourneyReceipt(value: unknown): value is JourneyReceipt {
  return isRecord(value) && typeof value.status === 'string' && typeof value.productionReady === 'boolean' &&
    typeof value.ledgerEligible === 'boolean' && Array.isArray(value.requirementIds) &&
    value.requirementIds.every((id: unknown) => typeof id === 'string') &&
    isArrayOf(value.checks, isJourneyCheckInput) && isArrayOf(value.readbacks, isJourneyReadbackInput);
}

function actualReceipt(): JourneyReceipt {
  try {
    const value = process.env.ZENITH_JOURNEY_RECEIPT;
    if (!value || !path.isAbsolute(value) || typeof process.getuid !== 'function') throw new Error();
    const file = path.resolve(value);
    const relative = path.relative(path.resolve(process.cwd()), file);
    if (!(relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))) throw new Error();
    const parent = fs.lstatSync(path.dirname(file)), stat = fs.lstatSync(file);
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid() || (parent.mode & 0o777) !== 0o700 ||
        !stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) throw new Error();
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!isRecord(parsed) || !isRecord(parsed.environment) ||
        !isArrayOf(parsed.checks, isJourneyCheckInput) || !isArrayOf(parsed.readbacks, isJourneyReadbackInput)) throw new Error();
    const projected: unknown = projectJourneyReceipt({
      commit: typeof parsed.commit === 'string' ? parsed.commit : undefined,
      sourceDigest: typeof parsed.sourceDigest === 'string' ? parsed.sourceDigest : undefined,
      dirty: typeof parsed.dirty === 'boolean' ? parsed.dirty : undefined,
      platform: 'darwin', arch: 'arm64', dockerArch: 'aarch64',
      node: typeof parsed.environment.node === 'string' ? parsed.environment.node : undefined,
      docker: typeof parsed.environment.docker === 'string' ? parsed.environment.docker : undefined,
      checks: parsed.checks,
      readbacks: Object.fromEntries(parsed.readbacks.map(row => [row.target, row.sha256] as const)),
    });
    if (JSON.stringify(projected) !== JSON.stringify(parsed) || !isJourneyReceipt(projected)) throw new Error();
    return projected;
  } catch { throw new Error('j2:private-receipt-required'); }
}

function requirePassedCheck(id: string, readback: string) {
  const value = actualReceipt();
  expect(value.status).toBe('passed');
  expect(value.productionReady).toBe(false);
  expect(value.ledgerEligible).toBe(true);
  expect(value.checks).toHaveLength(CHECKS.length);
  expect(value.checks.find(row => row.id === id)?.status).toBe('passed');
  expect(value.readbacks.find(row => row.target === readback)?.sha256).toMatch(/^[a-f0-9]{64}$/);
}

gated('PROD-OBS-02 actual J2 receipt', () => {
  it('requires the completed owned machine-health provenance check for OBS-02', () => {
    const value = actualReceipt();
    expect(value.requirementIds).toContain('PROD-OBS-02');
    requirePassedCheck('machine-health-provenance-readback', 'obs02');
  });
});

gated('PROD-MACH-04 actual J2 receipt', () => {
  it('requires the completed native fresh-token rejoin check for MACH-04', () => {
    const value = actualReceipt();
    expect(value.requirementIds).toContain('PROD-MACH-04');
    requirePassedCheck('machine-fresh-token-native-rejoin', 'machineRejoin');
  });
});
