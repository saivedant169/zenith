/** Real local Supabase + Playwright + axe. Opt-in only; NO identity/provider/request mocks. */
import { readFile } from "node:fs/promises";
import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";

interface Fixture {
  origin: string;
  identities: { email: string; password: string; workspaceId: string }[];
}
let browser: Browser, fixture: Fixture, axeSource: string;
const enabled = process.env.ZENITH_MFA_BROWSER === "1";
const gated = describe.skipIf(!enabled);

function totp(secret: string, offset = 0): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of secret.toUpperCase().replace(/=+$/, "")) {
    const n = alphabet.indexOf(char);
    if (n < 0) throw new Error("Auth returned an invalid TOTP setup key.");
    bits += n.toString(2).padStart(5, "0");
  }
  const bytes = Buffer.from(bits.match(/.{8}/g)?.map((byte) => parseInt(byte, 2)) ?? []);
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000) + offset));
  const mac = createHmac("sha1", bytes).update(counter).digest();
  const start = mac[mac.length - 1] & 15;
  return String((mac.readUInt32BE(start) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

async function audit(page: Page) {
  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await page.addScriptTag({ content: axeSource });
    const violations = await page.evaluate(async () => {
      const axe = (window as unknown as { axe: { run: (context: Document, options: unknown) => Promise<{ violations: { id: string; impact: string }[] }> } }).axe;
      const result = await axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] } });
      // Do not return node HTML; enrollment markup contains a private setup key.
      return result.violations.map(({ id, impact }) => ({ id, impact }));
    });
    expect(violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
}

async function probe(page: Page, workspaceId: string, path: string, body: unknown, method = "POST") {
  return page.evaluate(async ({ workspaceId, path, body, method }) => {
    const response = await fetch(path, { method, credentials: "same-origin", headers: { "content-type": "application/json", "x-zenith-workspace": workspaceId }, body: JSON.stringify(body) });
    return response.status;
  }, { workspaceId, path, body, method });
}

async function login(page: Page, identity: Fixture["identities"][number]) {
  await page.goto(`${fixture.origin}/login`);
  await page.getByLabel("Email", { exact: true }).fill(identity.email);
  await page.getByLabel("Password", { exact: true }).fill(identity.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
  await page.goto(`${fixture.origin}/platform`);
  // The fixture must already be admitted and an admin in its disposable workspace.
  expect(await page.getByRole("link", { name: "Verify your authenticator", exact: true }).count()).toBeGreaterThan(0);
}

gated("MFA browser acceptance (not run unless ZENITH_MFA_BROWSER=1; needs real local Supabase and Chrome)", () => {
  beforeAll(async () => {
    const file = process.env.ZENITH_MFA_BROWSER_FIXTURES_FILE;
    const executablePath = process.env.ZENITH_MFA_BROWSER_EXECUTABLE;
    if (!file || !executablePath) throw new Error("Opted-in MFA browser acceptance needs ZENITH_MFA_BROWSER_FIXTURES_FILE and ZENITH_MFA_BROWSER_EXECUTABLE.");
    fixture = JSON.parse(await readFile(file, "utf8")) as Fixture;
    const url = new URL(fixture.origin);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.origin !== fixture.origin) throw new Error("MFA acceptance only operates a disposable loopback installation.");
    if (fixture.identities?.length !== 2 || fixture.identities.some((user) => !user.email || !user.password || !user.workspaceId) || fixture.identities[0].email === fixture.identities[1].email) throw new Error("Provide two distinct disposable admitted workspace admins.");
    axeSource = (await import("axe-core")).default.source;
    // Optional: trust exactly the owned stack's edge leaf (base64 SHA-256 of its SPKI), as the J2 journey does.
    const spki = process.env.ZENITH_MFA_BROWSER_SPKI;
    if (spki !== undefined && !/^[A-Za-z0-9+/]{43}=$/.test(spki)) throw new Error("ZENITH_MFA_BROWSER_SPKI must be one base64 SHA-256 SPKI pin.");
    browser = await (await import("playwright-core")).chromium.launch({ executablePath, headless: true, ...(spki ? { args: [`--ignore-certificate-errors-spki-list=${spki}`] } : {}) });
  }, 60_000);
  afterAll(async () => { await browser?.close(); });
  it.each([0, 1])("operator %i cannot mutate at AAL1 and can complete real TOTP enrollment and later step-up", async (index) => {
    const identity = fixture.identities[index];
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const consoleErrors: string[] = [];
    page.on("pageerror", (error) => consoleErrors.push(error.name));
    try {
      await login(page, identity);
      expect(await probe(page, identity.workspaceId, "/api/auth/mfa/verify", {})).toBe(403);
      expect(await probe(page, identity.workspaceId, "/api/platform/v1/operations/mfa-refusal-probe/approve", {})).toBe(403);
      expect(await probe(page, identity.workspaceId, "/api/workspace/mfa", {}, "PUT")).toBe(403);
      await page.goto(`${fixture.origin}/account/mfa/enrol?next=%2Fplatform%2Fsettings`);
      await page.getByRole("button", { name: "Set up authenticator", exact: true }).click();
      const setup = page.getByLabel("Setup key", { exact: true });
      await setup.waitFor(); const secret = await setup.inputValue();
      expect(secret.length > 10).toBe(true); await audit(page);
      // Reach the OTP field and submit with the keyboard, not a scripted SDK call.
      const input = page.getByLabel("Six-digit authenticator code", { exact: true });
      await input.focus(); await input.fill(totp(secret)); await input.press("Enter");
      await page.getByRole("heading", { name: "Authenticator verified", exact: true }).waitFor();
      expect(await probe(page, identity.workspaceId, "/api/auth/mfa/verify", {})).toBe(200);
      expect(await setup.count()).toBe(0); await audit(page);
      await page.getByRole("link", { name: "Return to review", exact: true }).click();
      // A client-side Link navigates after the click resolves; wait for the exact destination.
      await page.waitForURL((url) => url.pathname === "/platform/settings");
      await page.getByLabel("Require verification for all changes by people", { exact: true }).check();
      await page.getByLabel("Verification lifetime (seconds)", { exact: true }).fill("300");
      await page.getByLabel("Verification lifetime (seconds)", { exact: true }).press("Enter");
      await page.getByRole("status").filter({ hasText: "MFA controls saved at version" }).waitFor();
      const saved = await page.evaluate(async () => { const response = await fetch("/api/workspace/mfa", { credentials: "same-origin" }); return response.json() as Promise<{ requireForAllMutations: boolean; maxAgeSeconds: number; version: number }> });
      expect(saved.requireForAllMutations).toBe(true); expect(saved.maxAgeSeconds).toBe(300); expect(saved.version).toBeGreaterThan(0); await audit(page);
      // A new password session is AAL1 even though the account has an enrolled factor.
      await context.clearCookies(); await login(page, identity);
      expect(await probe(page, identity.workspaceId, "/api/auth/mfa/verify", {})).toBe(403);
      // Auth servers can reject reuse of a TOTP that enrolled the factor. Await the next period.
      await new Promise((resolve) => setTimeout(resolve, 30_100 - (Date.now() % 30_000)));
      await page.goto(`${fixture.origin}/account/mfa/challenge?next=%2Fplatform%2Fsettings`);
      await page.getByLabel("Six-digit authenticator code", { exact: true }).waitFor(); await audit(page);
      const validCodes = new Set([-1, 0, 1].map((offset) => totp(secret, offset)));
      let wrong = "000000"; while (validCodes.has(wrong)) wrong = String(Number(wrong) + 1).padStart(6, "0");
      await page.getByLabel("Six-digit authenticator code", { exact: true }).fill(wrong);
      await page.getByRole("button", { name: "Verify authenticator", exact: true }).click();
      await page.getByRole("alert").filter({ hasText: "could not be verified" }).waitFor();
      expect(await page.getByLabel("Six-digit authenticator code", { exact: true }).inputValue()).toBe("");
      expect(await probe(page, identity.workspaceId, "/api/auth/mfa/verify", {})).toBe(403);
      await page.getByLabel("Six-digit authenticator code", { exact: true }).fill(totp(secret));
      await page.getByLabel("Six-digit authenticator code", { exact: true }).press("Enter");
      await page.getByRole("heading", { name: "Authenticator verified", exact: true }).waitFor();
      expect(await probe(page, identity.workspaceId, "/api/auth/mfa/verify", {})).toBe(200);
      // A malformed privileged body must now reach existing validation (400), not mutate anything.
      expect(await probe(page, identity.workspaceId, "/api/platform/v1/operations/mfa-refusal-probe/approve", {})).toBe(400);
      expect(consoleErrors).toEqual([]);
    } finally { await context.close(); }
  }, 180_000);
});
