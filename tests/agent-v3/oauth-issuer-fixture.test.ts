import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { realmFor, ISSUER, SCOPES } from "../../deploy/acceptance/oauth-issuer/prepare.mjs";
import { validateCallback } from "../../deploy/acceptance/oauth-issuer/authorize.mjs";

const realm = () => realmFor({ origin: "https://localhost:3000", subject: "member-a", password: randomBytes(32).toString("base64url") });
describe("local OAuth issuer fixture contracts", () => {
  it("pins a digest, HTTPS-only loopback ingress, and the lean memory profile", () => {
    const compose = readFileSync(new URL("../../deploy/acceptance/oauth-issuer/compose.yaml", import.meta.url), "utf8");
    expect(compose).toMatch(/quay\.io\/keycloak\/keycloak:26\.4\.7@sha256:[0-9a-f]{64}/);
    expect(compose).toContain('"127.0.0.1:8443:8443"');
    expect(compose).toContain("--http-enabled=false");
    expect(compose).toContain("mem_limit: 768m");
    expect(compose).toContain("${ZENITH_INTEROP_ADMIN_PASSWORD:?");
  });
  it("binds exact audience and an administrator-managed signed existing-member claim", () => {
    const generated = realm();
    const binding = generated.clientScopes.find((s) => s.name === "zenith-binding")!;
    expect(binding.protocolMappers).toContainEqual(expect.objectContaining({ protocolMapper: "oidc-audience-mapper",
      config: expect.objectContaining({ "included.custom.audience": "https://localhost:3000/api/agent/v3/mcp" }) }));
    expect(binding.protocolMappers).toContainEqual(expect.objectContaining({ config: expect.objectContaining({ "claim.name": "zenith_subject", "user.attribute": "zenith_subject" }) }));
    const profile = generated.components["org.keycloak.userprofile.UserProfileProvider"][0];
    const attrs = JSON.parse(profile.config["kc.user.profile.config"][0]).attributes;
    expect(attrs.find((a: { name: string }) => a.name === "zenith_subject").permissions).toEqual({ view: ["admin"], edit: ["admin"] });
    expect(attrs.find((a: { name: string }) => a.name === "email").permissions.edit).toEqual(["admin"]);
  });
  it("keeps issuer consent, bounded DCR, loopback redirects and default read-only scope", () => {
    const generated = realm();
    expect(generated.defaultDefaultClientScopes).toEqual(["basic", "zenith:read", "zenith-binding"]);
    expect(generated.defaultOptionalClientScopes).toEqual(SCOPES.filter((s) => s !== "read").map((s) => `zenith:${s}`));
    const policies = generated.components["org.keycloak.services.clientregistration.policy.ClientRegistrationPolicy"];
    expect(policies.map((p) => p.providerId)).toEqual(["trusted-hosts", "consent-required", "scope", "max-clients", "allowed-client-templates", "allowed-protocol-mappers"]);
    expect(policies[0].config["client-uris-must-match"]).toEqual(["true"]);
    expect(generated.clients).toEqual([]);
    expect(generated.accessTokenLifespan).toBe(300);
  });
  it.each(["http://localhost:3000", "https://cloud.example", "https://localhost:3000/path", "https://user@localhost:3000"])("refuses remote or inexact origin %s", (origin) => {
    expect(() => realmFor({ origin, subject: "member-a", password: randomBytes(32).toString("hex") })).toThrow();
  });
  it("rejects state/issuer mix-ups and authorization errors before redeeming a code", () => {
    const state = randomBytes(16).toString("hex");
    const callback = new URL("http://127.0.0.1/callback");
    callback.search = new URLSearchParams({ state, iss: ISSUER, code: randomBytes(16).toString("hex") }).toString();
    expect(validateCallback(callback, state)).toBe(callback.searchParams.get("code"));
    expect(() => validateCallback(callback, `${state}-other`)).toThrow("state");
    expect(() => validateCallback(callback, state, `${ISSUER}-other`)).toThrow("issuer");
    callback.searchParams.set("error", "access_denied");
    expect(() => validateCallback(callback, state)).toThrow("refused");
  });
});
