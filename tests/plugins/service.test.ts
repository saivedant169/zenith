/**
 * PROD-UX-03: register -> review -> issue -> authenticate -> revoke over the real
 * platform schema (PGlite here; set ZENITH_TEST_PLATFORM_PG_URL to run the same
 * file on PostgreSQL). Only the credential authority is modeled (FakeParents).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openPlatformDb, type PlatformDbHandle } from "@/lib/controlplane/db";
import * as repos from "@/lib/controlplane/db/repos";
import { authenticateMcp, resourceFor, type AuthDeps } from "@/lib/agent-access/v3/auth";
import { principalFromIdentity } from "@/lib/agent-access/v3/principal";
import { PluginError } from "@/lib/plugins/errors";
import { authenticatePluginToken, hashPluginToken, issuePluginToken, registerPlugin, revokePlugin, revokePluginGrant, reviewPlugin, type PluginDeps } from "@/lib/plugins/service";
import { baseManifest, FakeParents, KEY_ID, makePublisher, PUBLISHER, signManifest } from "./support";

const PG_URL = process.env.ZENITH_TEST_PLATFORM_PG_URL?.trim() || undefined;
let database: PlatformDbHandle;
// One engine per file. Every harness still has a unique workspace, credential
// and publisher, so cases remain isolated and tenancy runs against shared SQL.
beforeAll(async () => {
  database = await (PG_URL ? openPlatformDb({ kind: "postgres", url: PG_URL, migrate: true, max: 2 }) : openPlatformDb({ kind: "pglite" }));
});
afterAll(async () => { await database?.close(); });
const AUD = "http://127.0.0.1:3400/api/agent/v3/mcp";

async function harness() {
  const db = database;
  const publisher = makePublisher();
  const parents = new FakeParents();
  const suffix = Math.random().toString(36).slice(2, 10);
  const ws = `ws-${suffix}`;
  const credentialId = `cred-${suffix}`;
  parents.add({ id: credentialId, workspaceId: ws, projectIds: ["proj-a"], environmentIds: ["env-a"] });
  const deps: PluginDeps = { sql: db, parents: parents.lookup, publishers: () => publisher.publishers };
  const manifest = signManifest(baseManifest({ id: `acme/viewer-${suffix}` }), publisher.privateKey);
  return { db, publisher, parents, deps, ws, credentialId, manifest };
}
type H = Awaited<ReturnType<typeof harness>>;

async function approved(h: H, over: { tools?: string[]; scopes?: string[] } = {}) {
  const reg = await registerPlugin(h.deps, { workspaceId: h.ws, manifest: h.manifest, requestedBy: "alice" });
  return reviewPlugin(h.deps, { workspaceId: h.ws, registrationId: reg.id, manifestDigest: reg.manifestDigest, decision: "approve", tools: over.tools ?? ["zenith_get_topology", "zenith_query_logs"], scopes: over.scopes ?? ["read", "logs"], reviewedBy: "alice" });
}
const issue = (h: H, registrationId: string, over: Partial<Parameters<typeof issuePluginToken>[1]> = {}) =>
  issuePluginToken(h.deps, { workspaceId: h.ws, registrationId, credentialId: h.credentialId, subject: "bob", audience: AUD, days: 7, ...over });
const failsWith = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    return error instanceof PluginError ? error.code : `other:${String(error)}`;
  }
  return "no_error";
};

describe("registration and review", () => {
  it("uses the deployment publisher environment for registration and refuses absent or removed trust", async () => {
    const h = await harness();
    const deps: PluginDeps = { sql: h.db, parents: h.parents.lookup };
    const input = { workspaceId: h.ws, manifest: h.manifest, requestedBy: "alice" };
    try {
      vi.stubEnv("ZENITH_PLUGIN_TRUSTED_PUBLISHERS", undefined);
      expect(await failsWith(registerPlugin(deps, input))).toBe("plugin_provenance_unverified");
      expect(await repos.plugins.list(h.db, h.ws)).toEqual([]);

      const key = h.publisher.publishers.get(PUBLISHER)?.find(row => row.keyId === KEY_ID);
      if (!key) throw new Error("The runtime publisher fixture is unavailable.");
      const raw = key.key.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
      vi.stubEnv("ZENITH_PLUGIN_TRUSTED_PUBLISHERS", JSON.stringify({ [PUBLISHER]: [{ keyId: KEY_ID, publicKey: raw }] }));
      const registered = await registerPlugin(deps, input);
      expect(registered).toMatchObject({ status: "pending_review", created: true, publisherId: PUBLISHER, provenance: { keyId: KEY_ID, alg: "ed25519" } });
      const stored = await repos.plugins.list(h.db, h.ws);
      expect(stored).toHaveLength(1);
      expect(stored[0].id).toBe(registered.id);

      vi.stubEnv("ZENITH_PLUGIN_TRUSTED_PUBLISHERS", undefined);
      expect(await failsWith(registerPlugin(deps, input))).toBe("plugin_provenance_unverified");
      expect(await repos.plugins.list(h.db, h.ws)).toEqual(stored);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("verifies provenance, stores pending_review, and is idempotent for the same digest", async () => {
    const h = await harness();
    const first = await registerPlugin(h.deps, { workspaceId: h.ws, manifest: h.manifest, requestedBy: "alice" });
    expect(first).toMatchObject({ status: "pending_review", created: true, publisherId: "acme", provenance: { keyId: "acme-2026", alg: "ed25519" } });
    const again = await registerPlugin(h.deps, { workspaceId: h.ws, manifest: h.manifest, requestedBy: "alice" });
    expect(again).toMatchObject({ id: first.id, created: false });
  });

  it("refuses an unsigned-by-trusted-key manifest and stores nothing", async () => {
    const h = await harness();
    const forged = signManifest(baseManifest({ id: h.manifest.id }), makePublisher().privateKey);
    expect(await failsWith(registerPlugin(h.deps, { workspaceId: h.ws, manifest: forged, requestedBy: "alice" }))).toBe("plugin_provenance_unverified");
    expect(await repos.plugins.list(h.db, h.ws)).toEqual([]);
  });

  it("refuses a different manifest for an already registered version", async () => {
    const h = await harness();
    await registerPlugin(h.deps, { workspaceId: h.ws, manifest: h.manifest, requestedBy: "alice" });
    const other = signManifest(baseManifest({ id: h.manifest.id, description: "A different description." }), h.publisher.privateKey);
    expect(await failsWith(registerPlugin(h.deps, { workspaceId: h.ws, manifest: other, requestedBy: "alice" }))).toBe("plugin_conflict");
  });

  it("approval binds the exact digest and can only narrow what was declared", async () => {
    const h = await harness();
    const reg = await registerPlugin(h.deps, { workspaceId: h.ws, manifest: h.manifest, requestedBy: "alice" });
    const base = { workspaceId: h.ws, registrationId: reg.id, decision: "approve" as const, reviewedBy: "alice" };
    expect(await failsWith(reviewPlugin(h.deps, { ...base, manifestDigest: "0".repeat(64), tools: ["zenith_get_topology"], scopes: ["read"] }))).toBe("plugin_conflict");
    expect(await failsWith(reviewPlugin(h.deps, { ...base, manifestDigest: reg.manifestDigest, tools: ["zenith_scale_service"], scopes: ["read", "write"] }))).toBe("plugin_manifest_invalid");
    expect(await failsWith(reviewPlugin(h.deps, { ...base, manifestDigest: reg.manifestDigest, tools: ["zenith_get_topology"], scopes: ["logs"] }))).toBe("plugin_manifest_invalid");
    const ok = await reviewPlugin(h.deps, { ...base, manifestDigest: reg.manifestDigest, tools: ["zenith_get_topology"], scopes: ["read"] });
    expect(ok).toMatchObject({ status: "approved", approvedTools: ["zenith_get_topology"], approvedScopes: ["read"], reviewedBy: "alice" });
    // a decided plugin cannot be decided again
    expect(await failsWith(reviewPlugin(h.deps, { ...base, manifestDigest: reg.manifestDigest, tools: ["zenith_get_topology"], scopes: ["read"] }))).toBe("plugin_conflict");
  });

  it("is tenant scoped: another workspace sees nothing and cannot review, revoke or issue", async () => {
    const h = await harness();
    const reg = await approved(h);
    const foreign = `${h.ws}-foreign`;
    expect(await repos.plugins.get(h.db, foreign, reg.id)).toBeNull();
    expect(await repos.plugins.list(h.db, foreign)).toEqual([]);
    expect(await failsWith(reviewPlugin(h.deps, { workspaceId: foreign, registrationId: reg.id, manifestDigest: reg.manifestDigest, decision: "reject", reviewedBy: "mallory" }))).toBe("plugin_not_found");
    expect(await failsWith(revokePlugin(h.deps, { workspaceId: foreign, registrationId: reg.id, revokedBy: "mallory", reason: "x" }))).toBe("plugin_not_found");
    expect(await failsWith(issue(h, reg.id, { workspaceId: foreign }))).toBe("plugin_not_found");
    expect((await repos.plugins.get(h.db, h.ws, reg.id))?.status).toBe("approved");
  });
});

describe("grants and authentication", () => {
  it("issues nothing until approved", async () => {
    const h = await harness();
    const reg = await registerPlugin(h.deps, { workspaceId: h.ws, manifest: h.manifest, requestedBy: "alice" });
    expect(await failsWith(issue(h, reg.id))).toBe("plugin_not_approved");
  });

  it("issues an opaque audience-bound token, stores only its hash, and never the parent secret", async () => {
    const h = await harness();
    const reg = await approved(h);
    const issued = await issue(h, reg.id);
    expect(issued.token).toMatch(/^zp_[A-Za-z0-9_-]{43}$/);
    expect(issued.grant).toMatchObject({ audience: AUD, credentialId: h.credentialId, subject: "bob" });
    const dump = JSON.stringify(await h.db.query("select * from platform.plugin_grants where workspace_id = $1", [h.ws]));
    expect(dump).not.toContain(issued.token);
    expect(dump).toContain(hashPluginToken(issued.token));
    expect(JSON.stringify(await h.db.query("select * from platform.plugin_events where workspace_id = $1", [h.ws]))).not.toContain(issued.token);
  });

  it("only binds the issuing member's own live credential, and requires read", async () => {
    const h = await harness();
    const reg = await approved(h);
    h.parents.add({ id: `${h.credentialId}-carol`, workspaceId: h.ws, subject: "carol" });
    h.parents.add({ id: `${h.credentialId}-noread`, workspaceId: h.ws, scopes: ["plan"] });
    expect(await failsWith(issue(h, reg.id, { credentialId: `${h.credentialId}-carol` }))).toBe("plugin_forbidden");
    expect(await failsWith(issue(h, reg.id, { credentialId: "does-not-exist" }))).toBe("plugin_forbidden");
    expect(await failsWith(issue(h, reg.id, { credentialId: `${h.credentialId}-noread` }))).toBe("plugin_forbidden");
    h.parents.rows.get(h.credentialId)!.revokedAt = new Date().toISOString();
    expect(await failsWith(issue(h, reg.id))).toBe("plugin_forbidden");
  });

  it("authenticates as the parent attenuated to approved tools and scopes only", async () => {
    const h = await harness();
    const reg = await approved(h, { tools: ["zenith_get_topology"], scopes: ["read"] });
    const { token } = await issue(h, reg.id);
    const identity = await authenticatePluginToken(h.deps, token, AUD);
    expect(identity).toMatchObject({ subject: "bob", integrationId: h.credentialId, workspaceId: h.ws, projectIds: ["proj-a"], environmentIds: ["env-a"], scopes: ["read"] });
    expect(identity.plugin).toMatchObject({ registrationId: reg.id, pluginId: reg.pluginId, tools: ["zenith_get_topology"], manifestDigest: reg.manifestDigest });
    // the parent held write/plan/logs; the plugin must not
    expect(identity.scopes).not.toContain("write");
  });

  it("refuses a token presented to a different resource (audience binding)", async () => {
    const h = await harness();
    const reg = await approved(h);
    const { token } = await issue(h, reg.id);
    expect(await failsWith(authenticatePluginToken(h.deps, token, "http://127.0.0.1:3400/api/agent/v2/mcp"))).toBe("plugin_grant_invalid");
    expect(await failsWith(authenticatePluginToken(h.deps, token, "https://other.example/api/agent/v3/mcp"))).toBe("plugin_grant_invalid");
  });

  it("refuses unknown, malformed and foreign-shaped tokens uniformly", async () => {
    const h = await harness();
    for (const bad of ["zp_short", `zp_${"A".repeat(43)}`, `za_${"A".repeat(43)}`, "Bearer x"]) {
      expect(await failsWith(authenticatePluginToken(h.deps, bad, AUD))).toBe("plugin_grant_invalid");
    }
  });

  it("follows the parent credential live: revocation, expiry and narrowing apply on the next request", async () => {
    const h = await harness();
    const reg = await approved(h);
    const { token } = await issue(h, reg.id);
    h.parents.rows.get(h.credentialId)!.scopes = ["read"];
    const narrowed = await authenticatePluginToken(h.deps, token, AUD);
    expect(narrowed.scopes).toEqual(["read"]);
    expect(narrowed.plugin?.tools).toEqual(["zenith_get_topology"]);
    h.parents.rows.get(h.credentialId)!.revokedAt = new Date().toISOString();
    expect(await failsWith(authenticatePluginToken(h.deps, token, AUD))).toBe("plugin_grant_invalid");
  });

  it("caps the number of live tokens per plugin", async () => {
    const h = await harness();
    const reg = await approved(h);
    for (let i = 0; i < repos.plugins.MAX_ACTIVE_GRANTS_PER_PLUGIN; i++) await issue(h, reg.id);
    expect(await failsWith(issue(h, reg.id))).toBe("plugin_conflict");
  });
});

describe("revocation", () => {
  it("revoking a plugin invalidates every grant immediately and is terminal", async () => {
    const h = await harness();
    const reg = await approved(h);
    const a = await issue(h, reg.id);
    const b = await issue(h, reg.id);
    expect((await authenticatePluginToken(h.deps, a.token, AUD)).plugin?.pluginId).toBe(reg.pluginId);
    const result = await revokePlugin(h.deps, { workspaceId: h.ws, registrationId: reg.id, revokedBy: "alice", reason: "compromised publisher key" });
    expect(result).toMatchObject({ grantsRevoked: 2, registration: { status: "revoked", revokedBy: "alice", revokeReason: "compromised publisher key" } });
    expect(await failsWith(authenticatePluginToken(h.deps, a.token, AUD))).toBe("plugin_revoked");
    expect(await failsWith(authenticatePluginToken(h.deps, b.token, AUD))).toBe("plugin_revoked");
    expect(await failsWith(issue(h, reg.id))).toBe("plugin_revoked");
    expect(await failsWith(reviewPlugin(h.deps, { workspaceId: h.ws, registrationId: reg.id, manifestDigest: reg.manifestDigest, decision: "approve", tools: ["zenith_get_topology"], scopes: ["read"], reviewedBy: "alice" }))).toBe("plugin_conflict");
    // idempotent
    expect(await revokePlugin(h.deps, { workspaceId: h.ws, registrationId: reg.id, revokedBy: "alice", reason: "again" })).toMatchObject({ grantsRevoked: 0 });
    // the parent credential is untouched
    expect(await h.parents.lookup("bob", h.ws, h.credentialId)).not.toBeNull();
    const anchor = Date.now() - 5_000;
    for (const [kind, offset] of [["registered", 0], ["approved", 1_000], ["grant_issued", 2_000], ["revoked", 3_000]] as const) {
      await h.db.query("update platform.plugin_events set created_at = $4::timestamptz where workspace_id = $1 and registration_id = $2 and kind = $3", [h.ws, reg.id, kind, new Date(anchor + offset).toISOString()]);
    }
    const kinds = (await repos.plugins.listEvents(h.db, h.ws, reg.id)).map((e) => e.kind);
    expect(kinds).toEqual(["registered", "approved", "grant_issued", "grant_issued", "revoked"]);
  });

  it("revoking one grant leaves the others working", async () => {
    const h = await harness();
    const reg = await approved(h);
    const a = await issue(h, reg.id);
    const b = await issue(h, reg.id);
    await revokePluginGrant(h.deps, { workspaceId: h.ws, grantId: a.grant.id, revokedBy: "bob" });
    expect(await failsWith(authenticatePluginToken(h.deps, a.token, AUD))).toBe("plugin_grant_invalid");
    expect((await authenticatePluginToken(h.deps, b.token, AUD)).plugin?.grantId).toBe(b.grant.id);
    expect(await failsWith(revokePluginGrant(h.deps, { workspaceId: `${h.ws}-foreign`, grantId: b.grant.id, revokedBy: "mallory" }))).toBe("plugin_not_found");
  });

  it("refuses a registration row altered at rest (manifest no longer hashes to its digest)", async () => {
    const h = await harness();
    const reg = await approved(h);
    const { token } = await issue(h, reg.id);
    await h.db.query(`update platform.plugin_registrations set manifest = jsonb_set(manifest, '{capabilities,tools}', '["zenith_scale_service"]'::jsonb) where id = $1`, [reg.id]);
    expect(await failsWith(authenticatePluginToken(h.deps, token, AUD))).toBe("plugin_grant_invalid");
  });
});

describe("MCP authentication path (real service, real SQL)", () => {
  async function mcpDeps(h: H): Promise<AuthDeps> {
    return {
      checkOrigin: () => "http://127.0.0.1:3400",
      now: Date.now,
      authority: async () => ({ kind: "postgres", verify: async () => { throw new Error("a plugin token must never reach the credential authority"); }, touch: async () => {} }),
      oauth: { config: () => undefined, verify: async () => { throw new Error("a plugin token must never reach OAuth verification"); }, bind: async () => { throw new Error("unreachable"); } },
      plugins: { authenticate: (token, audience) => authenticatePluginToken(h.deps, token, audience) },
    };
  }
  const req = (token: string, headers: Record<string, string> = {}) => new Request("http://127.0.0.1:3400/api/agent/v3/mcp", { headers: { authorization: `Bearer ${token}`, ...headers } });

  it("a zp_ bearer becomes a plugin principal bound to the parent integration, never routed to other verifiers", async () => {
    const h = await harness();
    const reg = await approved(h, { tools: ["zenith_get_topology"], scopes: ["read"] });
    const { token } = await issue(h, reg.id);
    const auth = await authenticateMcp(req(token, { "x-zenith-workspace": h.ws }), await mcpDeps(h));
    expect(auth.principal.via).toBe("plugin");
    expect(auth.principal.principal).toMatchObject({ kind: "integration", id: h.credentialId, integrationId: h.credentialId, onBehalfOf: "bob" });
    expect(auth.principal.principal.name).toContain("plugin acme/");
    expect(auth.principal.scopes).toEqual(["read"]);
    expect(auth.principal.plugin?.tools).toEqual(["zenith_get_topology"]);
    expect(resourceFor("http://127.0.0.1:3400")).toBe(AUD);
  });

  it("selection headers cannot widen a plugin grant", async () => {
    const h = await harness();
    const reg = await approved(h);
    const { token } = await issue(h, reg.id);
    const deps = await mcpDeps(h);
    await expect(authenticateMcp(req(token, { "x-zenith-workspace": "ws-other" }), deps)).rejects.toMatchObject({ code: "scope_denied" });
    await expect(authenticateMcp(req(token, { "x-zenith-project": "proj-b" }), deps)).rejects.toMatchObject({ code: "scope_denied" });
  });

  it("revocation is effective on the very next MCP request", async () => {
    const h = await harness();
    const reg = await approved(h);
    const { token } = await issue(h, reg.id);
    const deps = await mcpDeps(h);
    await expect(authenticateMcp(req(token), deps)).resolves.toBeTruthy();
    await revokePlugin(h.deps, { workspaceId: h.ws, registrationId: reg.id, revokedBy: "alice", reason: "withdrawn" });
    await expect(authenticateMcp(req(token), deps)).rejects.toMatchObject({ code: "plugin_revoked", status: 401 });
  });

  it("principalFromIdentity keeps the binding so the dispatcher can enforce it", async () => {
    const h = await harness();
    const reg = await approved(h);
    const { token } = await issue(h, reg.id);
    const principal = principalFromIdentity(await authenticatePluginToken(h.deps, token, AUD));
    expect(principal.plugin?.registrationId).toBe(reg.id);
  });
});

// Registered owner-run case: fails as skipped (never green) unless a networked PostgreSQL server is configured.
describe.skipIf(!PG_URL)("plugin service on native PostgreSQL [postgres; postgres needs ZENITH_TEST_PLATFORM_PG_URL]", () => {
  it("persists review, issuance and grant revocation in a networked PostgreSQL server, not PGlite", async () => {
    const [server] = await database.query<{ networked: boolean }>("select inet_server_addr() is not null as networked");
    expect(server.networked).toBe(true);
    const h = await harness(); const reg = await approved(h); const { token, grant } = await issue(h, reg.id);
    expect((await authenticatePluginToken(h.deps, token, AUD)).plugin?.grantId).toBe(grant.id);
    await revokePluginGrant(h.deps, { workspaceId: h.ws, grantId: grant.id, revokedBy: "bob" });
    const [row] = await database.query<{ revoked: boolean; hashed: boolean }>(
      "select revoked_at is not null as revoked, token_hash <> $2 as hashed from platform.plugin_grants where id=$1", [grant.id, token]);
    expect(row).toEqual({ revoked: true, hashed: true });
    expect(await failsWith(authenticatePluginToken(h.deps, token, AUD))).toBe("plugin_grant_invalid");
  });
});
