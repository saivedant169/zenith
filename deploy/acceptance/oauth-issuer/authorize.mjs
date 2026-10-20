/** Mac-only browser handoff: real DCR + authorization code + S256 PKCE.
 * No password grant or synthesized JWT. A human completes consent by default.
 * authorize-playwright.mjs is the automated path: it drives the real Keycloak login and consent
 * pages in a browser as the runtime-generated disposable interop user (never a real person). */
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { discoverAuthorizationServerMetadata, registerClient } from "@modelcontextprotocol/client";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { ISSUER } from "./prepare.mjs";

async function defaultPresent({ url }) {
  console.log("In Zenith Integrations authorize this exact client ID and issuer for the intended workspace/projects and read/plan/logs. Then open:");
  console.log(url.href); // local authorization URL contains no credentials or tokens
}

export function validateCallback(callback, expectedState, expectedIssuer = ISSUER) {
  if (callback.searchParams.get("state") !== expectedState) throw new Error("OAuth state mismatch");
  if (callback.searchParams.get("iss") !== expectedIssuer) throw new Error("OAuth issuer mismatch");
  const code = callback.searchParams.get("code");
  if (!code || callback.searchParams.has("error")) throw new Error("OAuth authorization refused");
  return code;
}

/** `present` shows the authorization URL to whoever signs in (default: print it for a human);
 * `obtained` is recorded in tokens.json and provenance.json. */
export async function authorize(dir, { present = defaultPresent, obtained = "human browser consent" } = {}) {
  if (process.env.ZENITH_TEST_OAUTH_ISSUER !== "1") throw new Error("Set ZENITH_TEST_OAUTH_ISSUER=1 on the Mac verifier");
  const root = resolve(dir);
  const realm = JSON.parse(await readFile(resolve(root, "realm.json"), "utf8"));
  const binding = realm.clientScopes.find((scope) => scope.name === "zenith-binding");
  const resource = binding.protocolMappers.find((mapper) => mapper.protocolMapper === "oidc-audience-mapper").config["included.custom.audience"];
  const metadata = await discoverAuthorizationServerMetadata(ISSUER);
  if (!metadata || metadata.issuer !== ISSUER || !metadata.code_challenge_methods_supported?.includes("S256")) throw new Error("Issuer discovery/PKCE contract mismatch");
  for (const endpoint of [metadata.authorization_endpoint, metadata.token_endpoint, metadata.jwks_uri, metadata.registration_endpoint]) {
    if (!endpoint || !endpoint.startsWith(`${ISSUER}/`)) throw new Error("Issuer endpoints must stay within the local fixture");
  }
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  let settle;
  let reject;
  const callback = new Promise((yes, no) => { settle = yes; reject = no; });
  void callback.catch(() => {});
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") { response.writeHead(404).end(); return; }
    try {
      const code = validateCallback(url, state);
      response.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" }).end("Local authorization received. Return to the verifier terminal.");
      settle(code);
    } catch (error) { response.writeHead(400).end("Invalid authorization callback"); reject(error); }
  });
  await new Promise((yes) => server.listen(0, "127.0.0.1", yes));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No callback listener");
  const redirect = `http://127.0.0.1:${address.port}/callback`;
  const timer = setTimeout(() => reject(new Error("Browser consent timed out after 5 minutes")), 300_000);
  try {
    const client = await registerClient(ISSUER, { metadata, clientMetadata: {
      client_name: "Zenith local official conformance", redirect_uris: [redirect], token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
      // No registration `scope`: Keycloak would then replace the realm defaults (zenith-binding: audience + member claim) with the listed optional scopes.
    } });
    const url = new URL(metadata.authorization_endpoint);
    url.search = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: redirect,
      scope: "zenith:read zenith:plan zenith:logs", resource, state, code_challenge: challenge, code_challenge_method: "S256" }).toString();
    console.log(`Registered public client: ${client.client_id}`);
    const [code] = await Promise.all([callback, present({ url, client, redirect })]);
    const result = await fetch(metadata.token_endpoint, { method: "POST", redirect: "error",
      headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({
        grant_type: "authorization_code", client_id: client.client_id, redirect_uri: redirect, code, code_verifier: verifier, resource,
      }) });
    if (!result.ok) throw new Error(`Local token exchange refused HTTP ${result.status}`);
    const tokens = await result.json();
    const { payload } = await jwtVerify(tokens.access_token, createRemoteJWKSet(new URL(metadata.jwks_uri)), {
      issuer: ISSUER, audience: resource, algorithms: ["RS256"], requiredClaims: ["sub", "iat", "exp", "aud", "iss"],
    });
    if (payload.azp !== client.client_id || payload.zenith_subject !== realm.users[0].attributes.zenith_subject[0]
      || typeof payload.iat !== "number" || typeof payload.exp !== "number" || payload.exp - payload.iat > 3600
      || typeof payload.scope !== "string" || !payload.scope.split(" ").includes("zenith:read")) throw new Error("Signed token does not match the Zenith identity/resource contract");
    await writeFile(resolve(root, "tokens.json"), JSON.stringify({ ...tokens, client_id: client.client_id, resource, issuer: ISSUER, obtained }), { mode: 0o600, flag: "wx" });
    // Non-secret evidence of how the token was obtained.
    await writeFile(resolve(root, "provenance.json"), JSON.stringify({ obtained, client_id: client.client_id, issuer: ISSUER, resource, at: new Date().toISOString() }, null, 2), { mode: 0o600, flag: "wx" });
    console.log("Verified signed token saved privately to tokens.json. No token was printed.");
  } finally { clearTimeout(timer); server.closeAllConnections(); await new Promise((yes) => server.close(yes)); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) throw new Error("Usage: node authorize.mjs <fixture directory>");
  try { await authorize(process.argv[2]); }
  catch { console.error("Local OAuth authorization failed; credential-bearing responses were omitted"); process.exitCode = 1; }
}
