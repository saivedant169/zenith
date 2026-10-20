/** Mac verifier only: actual pinned Keycloak and an actual browser-issued token.
 * No synthesized tokens or mocked HTTP. These skips are not acceptance passes. */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { discoverAuthorizationServerMetadata, registerClient, type AuthorizationServerMetadata } from "@modelcontextprotocol/client";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { verifyOAuth } from "@/lib/agent-access/control/oauth";
import { ISSUER } from "../../deploy/acceptance/oauth-issuer/prepare.mjs";

const enabled = process.env.ZENITH_TEST_OAUTH_ISSUER === "1";
describe.skipIf(!enabled)("real Keycloak DCR (needs ZENITH_TEST_OAUTH_ISSUER=1 and Mac Docker fixture)", () => {
  let metadata: AuthorizationServerMetadata;
  const clients: { uri: string; token: string }[] = [];
  beforeAll(async () => {
    const found = await discoverAuthorizationServerMetadata(ISSUER);
    expect(found).toBeDefined();
    metadata = found!;
    expect(metadata.issuer).toBe(ISSUER);
    for (const endpoint of [metadata.authorization_endpoint, metadata.token_endpoint, metadata.jwks_uri, metadata.registration_endpoint]) {
      expect(endpoint).toMatch(new RegExp(`^${ISSUER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`));
    }
  });
  afterAll(async () => {
    for (const client of clients) {
      const response = await fetch(client.uri, { method: "DELETE", headers: { authorization: `Bearer ${client.token}` }, redirect: "error" });
      expect(response.status).toBe(204);
    }
  });
  it("advertises exact issuer, S256, authorization-code flow and DCR", () => {
    expect(metadata.code_challenge_methods_supported).toContain("S256");
    expect(metadata.grant_types_supported).toContain("authorization_code");
    expect(metadata.registration_endpoint).toBe(`${ISSUER}/clients-registrations/openid-connect`);
  });
  it("registers an anonymous public coding-agent client with a loopback redirect", async () => {
    // The SDK strips RFC 7592 management fields from its parsed result; read them from the issuer's own response.
    let raw: { registration_client_uri?: string; registration_access_token?: string } = {};
    const fetchFn: typeof fetch = async (input, init) => { const response = await fetch(input, init); if (response.ok) raw = await response.clone().json(); return response; };
    const client = await registerClient(ISSUER, { metadata, fetchFn, clientMetadata: {
      client_name: "Zenith Mac DCR verification", redirect_uris: ["http://127.0.0.1:8742/callback"],
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none",
      scope: "zenith:read zenith:plan",
    } });
    expect(client.client_id).toBeTruthy();
    expect(client.token_endpoint_auth_method).toBe("none");
    expect(client.redirect_uris).toEqual(["http://127.0.0.1:8742/callback"]);
    const management = raw;
    expect(management.registration_client_uri).toBeTruthy();
    expect(management.registration_access_token).toBeTruthy();
    const uri = management.registration_client_uri!;
    expect(uri.startsWith(`${ISSUER}/clients-registrations/`)).toBe(true);
    clients.push({ uri, token: management.registration_access_token! });
  });
  it("refuses non-loopback redirect registration under the real issuer policy", async () => {
    const endpoint = metadata.registration_endpoint;
    if (typeof endpoint !== "string") throw new Error("Issuer did not advertise a DCR endpoint");
    const response = await fetch(endpoint, { method: "POST", redirect: "error", headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Refusal control", redirect_uris: ["https://outside.example.test/callback"],
        token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"] }) });
    expect(response.status).toBe(403);
  });
  it("serves public signing keys with no private material", async () => {
    const jwksUri = metadata.jwks_uri;
    if (typeof jwksUri !== "string") throw new Error("Issuer did not advertise a JWKS endpoint");
    const response = await fetch(jwksUri, { redirect: "error" });
    expect(response.status).toBe(200);
    const jwks = await response.json();
    expect(jwks.keys.length).toBeGreaterThan(0);
    for (const key of jwks.keys) for (const field of ["d", "p", "q", "dp", "dq", "qi", "k"]) expect(key[field]).toBeUndefined();
  });
});

describe.skipIf(!enabled || process.env.ZENITH_TEST_OAUTH_BROWSER_TOKEN !== "1")(
  "real browser-issued OAuth token (needs ZENITH_TEST_OAUTH_BROWSER_TOKEN=1 and authorize.mjs)", () => {
    it("passes production signature/issuer/audience/client/member checks and refuses a foreign audience/issuer", async () => {
      const dir = process.env.ZENITH_INTEROP_DIR;
      expect(dir, "Set ZENITH_INTEROP_DIR to the generated private fixture directory").toBeTruthy();
      const tokens = JSON.parse(await readFile(resolve(dir!, "tokens.json"), "utf8"));
      const realm = JSON.parse(await readFile(resolve(dir!, "realm.json"), "utf8"));
      const jwksUrl = `${ISSUER}/protocol/openid-connect/certs`;
      const config = { issuer: ISSUER, jwksUrl, resource: tokens.resource, clientClaim: "azp" as const, subjectClaim: "zenith_subject" };
      const verified = await verifyOAuth(tokens.access_token, config);
      expect(verified.clientId).toBe(tokens.client_id);
      expect(verified.subject).toBe(realm.users[0].attributes.zenith_subject[0]);
      expect(verified.scopes.sort()).toEqual(["logs", "plan", "read"]);
      const { payload } = await jwtVerify(tokens.access_token, createRemoteJWKSet(new URL(jwksUrl)), { issuer: ISSUER, audience: tokens.resource });
      expect(payload.exp! - payload.iat!).toBeLessThanOrEqual(3600);
      await expect(verifyOAuth(tokens.access_token, { ...config, resource: `${tokens.resource}-other` })).rejects.toMatchObject({ code: "invalid_token" });
      await expect(verifyOAuth(tokens.access_token, { ...config, issuer: `${ISSUER}-other` })).rejects.toMatchObject({ code: "invalid_token" });
    });
  },
);
