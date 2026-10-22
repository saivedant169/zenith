import fs from 'node:fs';
import path from 'node:path';

export const CHECKS = Object.freeze([
  'prerequisites', 'auth-admin-mailpit', 'two-operator-workspace', 'browser-proposal',
  'self-approval-refused', 'bearer-approval-refused', 'stale-semantics-refused',
  'browser-kind-execution-readback', 'rest-proposal-execution-readback',
  'mcp-proposal-execution-readback', 'machine-browser-consent',
  'machine-independent-approval-readback', 'machine-health-provenance-readback', 'machine-fresh-token-native-rejoin', 'customer-credential-absence',
  'connection-rotation-readback', 'connection-revocation-no-fallback', 'cleanup',
]);
const STATUSES = new Set(['passed', 'failed', 'skipped', 'not_run']);
const hash = (value, length) => typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
const version = value => typeof value === 'string' && /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]{1,40})?$/.test(value) ? value : 'unrecorded';

/** Evidence is projected from a closed vocabulary. Never copy diagnostics, ids,
 * paths, names, mail, headers, argv, provider results or arbitrary strings. */
export function receipt(input = {}) {
  const facts = input.checks ?? [];
  if (!Array.isArray(facts) || facts.length > CHECKS.length) throw new Error('journey:receipt-checks');
  const seen = new Set();
  for (const fact of facts) {
    if (!fact || !CHECKS.includes(fact.id) || !STATUSES.has(fact.status) || seen.has(fact.id)) throw new Error('journey:receipt-checks');
    seen.add(fact.id);
  }
  const checks = CHECKS.map(id => ({ id, status: facts.find(fact => fact.id === id)?.status ?? 'not_run' }));
  const counts = Object.fromEntries([...STATUSES].map(status => [status, checks.filter(check => check.status === status).length]));
  const complete = counts.passed === CHECKS.length && ['kind', 'machine', 'rotatedKind', 'obs02', 'machineRejoin'].every(target => hash(input.readbacks?.[target], 64));
  const bound = hash(input.commit, 40) && hash(input.sourceDigest, 64) && typeof input.dirty === 'boolean';
  // macOS ARM64, or Linux on its own architecture; the Docker engine must report the same architecture.
  const host = input.platform === 'darwin' && input.arch === 'arm64' ? 'macOS ARM64'
    : input.platform === 'linux' && input.arch === 'x64' ? 'Linux AMD64' : input.platform === 'linux' && input.arch === 'arm64' ? 'Linux ARM64' : 'unsupported';
  const engineArch = { arm64: 'aarch64', x64: 'x86_64' }[input.arch];
  const environment = {
    host, architectureEvidence: host !== 'unsupported' && input.dockerArch === engineArch ? 'native' : 'unconfirmed',
    node: version(input.node), docker: version(input.docker), profile: input.profile === 'default' ? 'default' : 'lean',
    scope: 'disposable local Supabase Auth, Mailpit, PostgreSQL, Temporal, zenithd and kind',
  };
  const status = complete && bound && environment.architectureEvidence === 'native' ? 'passed'
    : counts.failed > 0 ? 'failed' : counts.skipped > 0 ? 'skipped' : 'incomplete';
  // A dirty tree can be rehearsed, but is never coherent-commit ledger evidence.
  const ledgerEligible = status === 'passed' && input.dirty === false;
  return {
    schemaVersion: 1, requirementIds: ['PROD-PKG-05', 'PROD-DUR-03', 'PROD-DUR-04', 'PROD-LIFE-01', 'PROD-MACH-05', 'PROD-OBS-02', 'PROD-MACH-04', 'PROD-PKG-02'],
    kind: 'local_engine', status, productionReady: false, ledgerEligible,
    commit: hash(input.commit, 40) ? input.commit : null,
    sourceDigest: hash(input.sourceDigest, 64) ? input.sourceDigest : null,
    dirty: typeof input.dirty === 'boolean' ? input.dirty : null,
    environment, counts, checks,
    // Only verifier-owned sha256 values, never a result body.
    readbacks: ['kind', 'machine', 'rotatedKind', 'obs02', 'machineRejoin'].flatMap(target => hash(input.readbacks?.[target], 64) ? [{ target, sha256: input.readbacks[target] }] : []),
    evidence: ledgerEligible ? {
      level: 'local_engine', commit: input.commit,
      command: 'ZENITH_DEFAULT_JOURNEY=1 node scripts/acceptance/default-journey.mjs --config <private-config> --receipt <evidence-file>',
      environment: `${environment.host}; native ${input.arch === 'x64' ? 'AMD64' : 'ARM64'} Docker ${environment.docker}; Node ${environment.node}; ${environment.profile}; disposable local installation`,
      result: `${counts.passed} passed /${counts.failed} failed /${counts.skipped} skipped /${counts.not_run} not run`,
      logs: 'docs/build/production/evidence/PROD-PKG-05/default-journey.json',
    } : null,
  };
}

export function writeReceipt(file, input) {
  const output = receipt(input);
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  // Refuse symlinks and replacement of existing evidence.
  fs.writeFileSync(file, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  return output;
}
