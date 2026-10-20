import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { receipt, writeReceipt } from '../../tests/e2e/default/receipt.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fail = id => { throw new Error('journey:' + id); };
export function enabled(env = process.env) { return env.ZENITH_DEFAULT_JOURNEY === '1'; }
export function run(args = process.argv.slice(2)) {
  // No filesystem, credential, subprocess or network access before explicit opt-in.
  if (!enabled()) {
    process.stdout.write(JSON.stringify(receipt({ checks: [{ id: 'prerequisites', status: 'skipped' }] })) + '\n');
    return 0;
  }
  let config, output, scratch, scratchRemovalAuthorized = false;
  while (args.length) {
    const flag = args.shift(), value = args.shift();
    if (!value) fail('usage');
    if (flag === '--config') config = path.resolve(value);
    else if (flag === '--receipt') output = path.resolve(value);
    else fail('usage');
  }
  if (!config || !output || fs.existsSync(output)) fail('usage-or-existing-receipt');
  const source = { platform: process.platform, arch: process.arch, node: process.versions.node, checks: [] };
  try {
    if (Number(process.versions.node.split('.')[0]) !== 22) fail('node22-required');
    const git = args => {
      const child = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
      if (child.status !== 0) fail('source-binding');
      return child.stdout;
    };
    const evidencePath = path.relative(root, output).split(path.sep).join('/');
    // Same source-byte binding as the installer, including untracked harness files.
    // The one new receipt is an output, not a change to the tested source.
    const bind = () => {
      const hash = createHash('sha256');
      for (const file of git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean).sort()) {
        if (file === evidencePath) continue;
        hash.update(file).update('\0');
        const full = path.join(root, file);
        if (!fs.existsSync(full)) hash.update('deleted\0');
        else hash.update(fs.lstatSync(full).isSymbolicLink() ? fs.readlinkSync(full) : fs.readFileSync(full)).update('\0');
      }
      const dirty = git(['status', '--porcelain', '--untracked-files=all']).split('\n').filter(Boolean)
        .some(line => line.slice(3).trim() !== evidencePath);
      return { commit: git(['rev-parse', 'HEAD']).trim(), dirty, sourceDigest: hash.digest('hex') };
    };
    const initial = bind();
    Object.assign(source, initial);
    const require = createRequire(path.join(root, 'package.json'));
    let cli;
    try { cli = require.resolve('@playwright/test/cli'); } catch { fail('playwright-test-runner-missing'); }
    // macOS commonly aliases /var to /private/var. Use the real temp parent
    // so privateFile's symlink guard does not reject our own generated file.
    scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'zenith-default-journey-')); fs.chmodSync(scratch, 0o700);
    const sourceFile = path.join(scratch, 'source.json');
    fs.writeFileSync(sourceFile, JSON.stringify(source), { mode: 0o600 });
    // Capture diagnostics privately: Playwright errors can contain cookies, mail links or tokens.
    const child = spawnSync(process.execPath, [cli, 'test', '--config', 'tests/e2e/default/playwright.config.mjs', '--workers=1'], {
      cwd: root, timeout: 1_020_000, maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, ZENITH_JOURNEY_CONFIG: config, ZENITH_JOURNEY_RECEIPT: output,
        ZENITH_JOURNEY_SOURCE: sourceFile, ZENITH_JOURNEY_SCRATCH: scratch },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Kept only in the owner-private scratch, never printed: Playwright output can contain cookies, mail links or tokens.
    fs.writeFileSync(path.join(scratch, 'playwright.private.log'), `${child.stdout ?? ''}\n${child.stderr ?? ''}`, { mode: 0o600 });
    if (child.error || child.signal || child.status === null) fail('child-settlement-unconfirmed');
    if (!fs.existsSync(output)) fail('no-receipt');
    let result = JSON.parse(fs.readFileSync(output, 'utf8'));
    if (!Array.isArray(result.checks) || typeof result.status !== 'string') fail('receipt-invalid');
    if (JSON.stringify(bind()) !== JSON.stringify(initial)) {
      // Replace only this invocation's newly created receipt; never preserve
      // a claimed pass after the tested source changed under a running stack.
      fs.unlinkSync(output);
      result = writeReceipt(output, { ...source, checks: result.checks.map(check =>
        check.id === 'prerequisites' ? { id: check.id, status: 'failed' } : check) });
    }
    const candidateCheckFailed = result.checks.some(check =>
      ['two-operator-workspace', 'cleanup'].includes(check.id) && check.status === 'failed');
    // A journey that did not pass keeps its private scratch (and diagnostics) for the operator.
    scratchRemovalAuthorized = !candidateCheckFailed && result.status === 'passed';
    if (!scratchRemovalAuthorized) process.stdout.write(`journey:private-diagnostics ${scratch}\n`);
    process.stdout.write(JSON.stringify({ status: result.status, counts: result.counts, ledgerEligible: result.ledgerEligible }) + '\n');
    return child.status === 0 && result.status === 'passed' ? 0 : 1;
  } catch {
    if (!fs.existsSync(output)) writeReceipt(output, { ...source, checks: [{ id: 'prerequisites', status: 'failed' }] });
    process.stdout.write('journey:failed; inspect the sanitized receipt and prerequisite runbook\n');
    return 1;
  } finally {
    if (scratch && scratchRemovalAuthorized) {
      let markerAbsent = false;
      try { fs.lstatSync(path.join(scratch, 'RETAIN-RUNNER-CUSTODY')); }
      catch (error) { markerAbsent = error?.code === 'ENOENT'; }
      if (markerAbsent) fs.rmSync(scratch, { recursive: true, force: true });
    }
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = run(); } catch { process.stderr.write('journey:usage-or-output-refused\n'); process.exitCode = 1; }
}
