/** Automated twin of authorize.mjs for the disposable Keycloak fixture only.
 * authorize.mjs does the real DCR, S256 PKCE, loopback callback and code exchange; this drives the
 * REAL Keycloak login and consent pages in Chromium as the runtime-generated interop user from
 * credentials.json. No password grant, minted JWT or TLS bypass: Chromium trusts only the fixture
 * leaf by SPKI pin (as tests/e2e/default does) and Node must trust tls/ca.crt via NODE_EXTRA_CA_CERTS
 * (source zenith.env). Usage: ZENITH_TEST_OAUTH_ISSUER=1 node authorize-playwright.mjs <fixture dir> */
import { X509Certificate, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { authorize } from "./authorize.mjs";

export const OBTAINED = "automated browser, disposable user";

export async function authorizeWithBrowser(dir) {
  const root = resolve(dir);
  const { username, password } = JSON.parse(await readFile(resolve(root, "credentials.json"), "utf8"));
  const cert = new X509Certificate(await readFile(resolve(root, "tls", "server.crt")));
  const spki = createHash("sha256").update(cert.publicKey.export({ type: "spki", format: "der" })).digest("base64");
  let step = "launch";
  const present = async ({ url, redirect }) => {
    const browser = await chromium.launch({ executablePath: process.env.ZENITH_TEST_BROWSER_BIN || undefined,
      args: [`--ignore-certificate-errors-spki-list=${spki}`] });
    try {
      const page = await (await browser.newContext({ ignoreHTTPSErrors: false })).newPage();
      page.setDefaultTimeout(30_000);
      const callback = (target) => target.href.startsWith(`${redirect}?`);
      step = "login"; await page.goto(url.href);
      await page.locator("#username").fill(username);
      await page.locator("#password").fill(password);
      await page.locator("#kc-login").click();
      step = "consent"; // The realm requires consent: the screen must appear and list the requested scopes.
      await page.locator('[name="accept"]').waitFor();
      const text = await page.locator("body").innerText();
      for (const scope of ["zenith:read", "zenith:plan", "zenith:logs"]) if (!text.includes(scope)) throw new Error("Consent screen omits a requested scope");
      await page.locator('[name="accept"]').click();
      step = "callback"; await page.waitForURL(callback);
    } finally { await browser.close(); }
  };
  try { await authorize(root, { present, obtained: OBTAINED }); }
  catch (error) { throw new Error(`failed at step: ${step}`, { cause: error }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) throw new Error("Usage: node authorize-playwright.mjs <fixture directory>");
  try { await authorizeWithBrowser(process.argv[2]); }
  catch (error) { console.error(`Automated OAuth authorization ${error.message}; credential-bearing responses were omitted`); process.exitCode = 1; }
}
