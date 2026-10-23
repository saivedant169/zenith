#!/usr/bin/env node
/**
 * PROD-UX-01: two fresh, admitted workspace admins WITHOUT a verified authenticator, for tests/auth/mfa-browser.test.ts.
 *
 *   ZENITH_DEFAULT_JOURNEY=1 node tests/e2e/default/mfa-fixtures.mjs --config <private J2 journey.json>
 *     --receipt <the J2 receipt path, for the source binding> --out <new file in a 0700 directory>
 *
 * Uses the J2 harness itself: the owned J1 stack's prerequisites, Mailpit-confirmed operators and a real browser
 * sign-in that creates each operator's own disposable workspace. Passwords are generated here and written only
 * to the 0600 fixture file; nothing is printed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { Config, browserRequest, ensure, ok, operator, prerequisites, privateFile } from './support.mjs';
import { sourceBinding } from '../../../scripts/acceptance/source-binding.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export async function main(argv = process.argv.slice(2)) {
  ensure(process.env.ZENITH_DEFAULT_JOURNEY === '1', 'mfa-fixtures-opt-in');
  const args = {};
  while (argv.length) { const flag = argv.shift(), value = argv.shift(); ensure(flag?.startsWith('--') && value, 'mfa-fixtures-usage'); args[flag.slice(2)] = value; }
  ensure(args.config && args.receipt && args.out, 'mfa-fixtures-usage');
  const out = path.resolve(args.out), parent = fs.lstatSync(path.dirname(out));
  ensure(parent.isDirectory() && !parent.isSymbolicLink() && (parent.mode & 0o777) === 0o700 && parent.uid === process.getuid() &&
    !fs.existsSync(out) && !out.startsWith(root + path.sep), 'mfa-fixtures-file-custody');
  const source = { platform: process.platform, arch: process.arch, node: process.versions.node,
    ...sourceBinding(root, path.relative(root, path.resolve(args.receipt)).split(path.sep).join('/')) };
  const config = Config.parse(JSON.parse(privateFile(path.resolve(args.config))));
  const stack = await prerequisites(config, source);
  const browser = await chromium.launch({ headless: true, ...(process.env.ZENITH_JOURNEY_CHROMIUM_SPKI ? { args: [`--ignore-certificate-errors-spki-list=${process.env.ZENITH_JOURNEY_CHROMIUM_SPKI}`] } : {}) });
  const identities = [], users = [];
  try {
    for (const letter of ['m', 'n']) {
      const user = await operator(stack, config.mailpitUrl, letter, users);
      const page = await (await browser.newContext()).newPage();
      await page.goto(stack.apiUrl + '/login?next=/overview');
      await page.getByLabel('Email', { exact: true }).fill(user.email);
      await page.getByLabel('Password', { exact: true }).fill(user.password);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page.waitForURL(url => url.origin === new URL(stack.apiUrl).origin && url.pathname !== '/login');
      const workspace = ok(await browserRequest(page, '/api/workspace', { name: 'Zenith MFA ' + letter + ' ' + Date.now() })).workspace;
      ensure(typeof workspace?.id === 'string', 'mfa-fixtures-workspace');
      ok(await browserRequest(page, '/api/bootstrap'));
      identities.push({ email: user.email, password: user.password, workspaceId: workspace.id });
    }
  } finally { await browser.close(); }
  fs.writeFileSync(out, JSON.stringify({ origin: new URL(stack.apiUrl).origin, identities }), { mode: 0o600, flag: 'wx' });
  process.stdout.write(JSON.stringify({ identities: identities.length }) + '\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write((error instanceof Error && /^journey:[a-z0-9-]+$/.test(error.message) ? error.message : 'mfa-fixtures-failed') + '\n'); process.exitCode = 1; });
}
