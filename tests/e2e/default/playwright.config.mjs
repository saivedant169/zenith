import path from 'node:path';
import { defineConfig } from '@playwright/test';
// Optional: trust exactly the owned stack's edge leaf (base64 SHA-256 of its SPKI) without
// changing an OS trust store. Any other certificate error still fails the journey.
const spki = process.env.ZENITH_JOURNEY_CHROMIUM_SPKI;
if (spki !== undefined && !/^[A-Za-z0-9+/]{43}=$/.test(spki)) throw new Error('journey:chromium-spki-pin');
export default defineConfig({
  testDir: '.', testMatch: '**/*.spec.mjs', workers: 1, fullyParallel: false,
  retries: 0, timeout: 900_000, expect: { timeout: 30_000 },
  reporter: [['dot']], outputDir: path.join(process.env.ZENITH_JOURNEY_SCRATCH ?? '/tmp/zenith-journey-unused', 'playwright'),
  use: { browserName: 'chromium', headless: true, trace: 'off', screenshot: 'off', video: 'off',
    actionTimeout: 30_000, navigationTimeout: 60_000, ignoreHTTPSErrors: false,
    ...(spki ? { launchOptions: { args: [`--ignore-certificate-errors-spki-list=${spki}`] } } : {}) },
});
