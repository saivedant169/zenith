/**
 * The product-store adapters: the scope chain (`ScopeResolver`) and roles
 * (`RoleResolver`), driven by the real product store in a temp data directory.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudConnection, Environment, Manifest, Member, Project, Workspace } from "@/lib/domain/types";
import type { Principal } from "@/lib/controlplane/types";
import type { PlatformResource } from "@/lib/controlplane/db/repos/resources";
import { tempDataDir } from "../_support/data-dir";

tempDataDir("zenith-cap-adapters-");

const flags = vi.hoisted(() => ({ supabase: false }));
vi.mock("@/lib/supabase/env", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/supabase/env")>()), isSupabaseConfigured: () => flags.supabase }));
const authority = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[], fail: false, asked: [] as unknown[][] }));
vi.mock("@/lib/agent-access/authority", () => ({
  credentialAuthority: () => ({
    listCredentials: async (...args: unknown[]) => {
      authority.asked.push(args);
      if (authority.fail) throw new Error("authority down");
      return authority.rows;
    },
  }),
}));

const { db, resetDb } = await import("@/lib/db/store");
const { productRoleResolver, productScopeResolver, credentialDirectory } = await import("@/lib/capabilities/product-adapters");

const AT = "2026-01-01T00:00:00.000Z";
const ws = (id: string): Workspace => ({ id, name: id, slug: id, createdAt: AT }) as Workspace;
const member = (id: string, workspaceId: string, role: Member["role"]): Member => ({ id, workspaceId, role, name: id, email: `${id}@example.test` });

const manifest = (): Manifest => ({
  version: 1,
  services: [
    { id: "svc-web", name: "web", kind: "web", source: { type: "image", image: "nginx" }, size: "small", replicas: 1, env: [], ownership: "managed" },
    { id: "svc-worker", name: "worker", kind: "worker", source: { type: "image", image: "worker" }, size: "small", replicas: 1, env: [], ownership: "managed" },
  ],
  resources: [
    { id: "res-db", name: "db", kind: "postgres", config: {}, size: "small", ownership: "managed" },
    { id: "res-ext", name: "legacy", kind: "postgres", config: {}, size: "small", ownership: "referenced", externalRef: "arn:aws:rds:x" },
    { id: "res-mail", name: "mail", kind: "email", config: {}, size: "small", ownership: "managed" },
  ],
  routes: [{ id: "route-1", host: "app.example.com", pathPrefix: "/", tls: true, managedDns: true }],
  bindings: [{ id: "b1", from: "route-1", to: "svc-web", capability: "http" }],
});

const project = (id: string, workspaceId: string, slug: string): Project => ({ id, workspaceId, name: id, slug, workingManifest: manifest(), createdAt: AT, origin: { type: "blank" } }) as Project;
const env = (id: string, projectId: string, klass: Environment["class"], connectionId: string): Environment =>
  ({ id, projectId, name: id, class: klass, connectionId, region: "us-east-1", policies: { approvalRequired: false, allowStatefulDeletion: false }, baseDomain: "test", createdAt: AT }) as unknown as Environment;
const connection = (id: string, workspaceId: string, provider: string): CloudConnection => ({ id, workspaceId, provider, label: id, region: "us-east-1", status: "healthy", grantedPermissions: [], createdAt: AT }) as unknown as CloudConnection;
const canonicalResource = (overrides: Partial<PlatformResource> = {}): PlatformResource => ({
  id: "res_canonical", workspaceId: "ws-a", projectId: "pa", environmentId: "env-a",
  address: "object_store/customer-data", kind: "object_store", provider: "aws", nativeType: "aws_s3_bucket",
  ownership: "managed", specDigest: "a".repeat(64), spec: {}, dependsOn: [], origin: [], labels: {},
  status: "active", createdAt: AT, updatedAt: AT, ...overrides,
});

function seed(members: Member[] = [member("ada", "ws-a", "admin"), member("eve", "ws-a", "editor"), member("vic", "ws-a", "viewer"), member("bo", "ws-b", "admin")]) {
  resetDb({
    workspaces: [ws("ws-a"), ws("ws-b")],
    members,
    projects: [project("pa", "ws-a", "atlas"), project("pb", "ws-b", "atlas")],
    environments: [env("env-a", "pa", "production", "conn-a"), env("env-a2", "pa", "sandbox", "conn-missing"), env("env-b", "pb", "staging", "conn-b")],
    connections: [connection("conn-a", "ws-a", "aws"), connection("conn-b", "ws-b", "aws")],
  });
}

beforeEach(() => {
  flags.supabase = false;
  delete process.env.ZENITH_HOSTED_MODE;
  authority.rows = [];
  authority.fail = false;
  authority.asked = [];
  seed();
});

describe("ScopeResolver over the product store", () => {
  const resolver = productScopeResolver();

  it("resolves the chain and fills in the parent ids", async () => {
    const r = await resolver.resolve({ workspaceId: "ws-a", environmentId: "env-a" });
    expect(r).toMatchObject({ scope: { workspaceId: "ws-a", projectId: "pa", environmentId: "env-a" }, environment: { id: "env-a", class: "production", provider: "aws", region: "us-east-1" } });
    expect(await resolver.resolve({ workspaceId: "ws-a" })).toEqual({ scope: { workspaceId: "ws-a" } });
    expect(await resolver.resolve({ workspaceId: "ws-a", projectId: "pa" })).toMatchObject({ scope: { projectId: "pa" } });
  });

  it("answers foreign, missing and mismatched ids with null", async () => {
    for (const scope of [
      { workspaceId: "ws-b", projectId: "pa" },
      { workspaceId: "ws-a", projectId: "pb" },
      { workspaceId: "ws-a", environmentId: "env-b" },
      { workspaceId: "ws-a", projectId: "pa", environmentId: "env-b" },
      { workspaceId: "ws-b", environmentId: "env-a" },
      { workspaceId: "ws-nope" },
      { workspaceId: "ws-a", projectId: "nope" },
      { workspaceId: "ws-a", environmentId: "nope" },
    ]) {
      expect(await resolver.resolve(scope)).toBeNull();
    }
  });

  it("matches ids exactly — a slug is not an id", async () => {
    expect(await resolver.resolve({ workspaceId: "ws-a", projectId: "atlas" })).toBeNull();
    expect(await resolver.resolve({ workspaceId: "ws-b", projectId: "atlas" })).toBeNull();
  });

  it("says the provider is unknown when an environment has no connection", async () => {
    const r = await resolver.resolve({ workspaceId: "ws-a", environmentId: "env-a2" });
    expect(r?.environment).toMatchObject({ class: "sandbox", provider: "unknown" });
  });

  it("resolves resources from the manifest with their facts, and only inside their environment", async () => {
    const web = await resolver.resolve({ workspaceId: "ws-a", environmentId: "env-a", resourceId: "svc-web" });
    expect(web?.resource).toEqual({ address: "service/web", kind: "container_service", stateful: false, ownership: "managed", publiclyExposed: true });
    expect((await resolver.resolve({ workspaceId: "ws-a", environmentId: "env-a", resourceId: "svc-worker" }))?.resource).toMatchObject({ publiclyExposed: false });
    expect((await resolver.resolve({ workspaceId: "ws-a", environmentId: "env-a", resourceId: "res-db" }))?.resource).toEqual({ address: "resource/db", kind: "postgres", stateful: true, ownership: "managed", publiclyExposed: false });
    expect((await resolver.resolve({ workspaceId: "ws-a", environmentId: "env-a", resourceId: "res-ext" }))?.resource).toMatchObject({ ownership: "referenced", stateful: true });
    expect((await resolver.resolve({ workspaceId: "ws-a", environmentId: "env-a", resourceId: "res-mail" }))?.resource).toMatchObject({ stateful: false });

    expect(await resolver.resolve({ workspaceId: "ws-a", environmentId: "env-a", resourceId: "nope" })).toBeNull();
    expect(await resolver.resolve({ workspaceId: "ws-a", resourceId: "svc-web" })).toBeNull(); // a resource needs its environment
    expect(await resolver.resolve({ workspaceId: "ws-b", environmentId: "env-b", resourceId: "svc-web" })).toMatchObject({ scope: { resourceId: "svc-web" } }); // B has its own manifest
  });
});

describe("ScopeResolver canonical resource IDs", () => {
  const scope = { workspaceId: "ws-a", environmentId: "env-a", resourceId: "res_canonical" };

  it("resolves the exact tenant row and preserves its provider independently of the environment default", async () => {
    resetDb({ ...db(), connections: [connection("conn-a", "ws-a", "kubernetes")] });
    const read = vi.fn(async () => canonicalResource());
    const resolved = await productScopeResolver(read).resolve(scope);
    expect(read).toHaveBeenCalledExactlyOnceWith("ws-a", "res_canonical");
    expect(resolved).toEqual({
      scope: { ...scope, projectId: "pa" },
      environment: { id: "env-a", class: "production", provider: "kubernetes", region: "us-east-1" },
      resourceProvider: "aws",
      resource: { address: "object_store/customer-data", kind: "object_store", stateful: true, ownership: "managed", publiclyExposed: false },
    });
  });

  it.each([
    ["missing", null],
    ["different ID", canonicalResource({ id: "res_other" })],
    ["other tenant", canonicalResource({ workspaceId: "ws-b" })],
    ["other project", canonicalResource({ projectId: "pb" })],
    ["unbound project", canonicalResource({ projectId: undefined })],
    ["other environment", canonicalResource({ environmentId: "env-a2" })],
    ["deleted", canonicalResource({ status: "deleted" })],
  ] as const)("refuses a %s canonical row", async (_label, row) => {
    expect(await productScopeResolver(async () => row).resolve(scope)).toBeNull();
  });

  it("re-reads ownership after adoption or release instead of retaining manifest or cached facts", async () => {
    let row = canonicalResource({ address: "resource/db", kind: "postgres", nativeType: "aws_db_instance" });
    const read = vi.fn(async () => row);
    const resolver = productScopeResolver(read);
    expect((await resolver.resolve(scope))?.resource?.ownership).toBe("managed");
    row = { ...row, ownership: "referenced" };
    expect((await resolver.resolve(scope))?.resource?.ownership).toBe("referenced");
    row = { ...row, ownership: "external" };
    expect((await resolver.resolve(scope))?.resource?.ownership).toBe("external");
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("requires a valid parent chain before querying the canonical store", async () => {
    const read = vi.fn(async () => canonicalResource());
    const resolver = productScopeResolver(read);
    expect(await resolver.resolve({ ...scope, workspaceId: "ws-b" })).toBeNull();
    expect(await resolver.resolve({ ...scope, projectId: "pb" })).toBeNull();
    expect(await resolver.resolve({ workspaceId: "ws-a", resourceId: scope.resourceId })).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it("does not fall back to a same-ID manifest node when its canonical row is missing or deleted", async () => {
    const shadow = project("pa", "ws-a", "atlas");
    const edited = manifest();
    edited.resources[0].id = scope.resourceId;
    shadow.workingManifest = edited;
    resetDb({ ...db(), projects: [shadow] });
    for (const row of [null, canonicalResource({ status: "deleted" })]) {
      expect(await productScopeResolver(async () => row).resolve(scope)).toBeNull();
    }
  });
});

describe("ScopeResolver deployed manifest services", () => {
  const scope = { workspaceId: "ws-a", environmentId: "env-a", resourceId: "svc-web" };
  const workload = (overrides: Partial<PlatformResource> = {}) => canonicalResource({ id: "res_web", address: "container_service/web", kind: "container_service", nativeType: "k8s:Deployment", origin: ["svc-web"], ...overrides });

  it("binds a deployed service's one canonical workload row, which execution and field ownership require", async () => {
    const list = vi.fn(async () => [workload(), workload({ id: "res_logs", address: "log_group/web", kind: "log_group" })]);
    const read = vi.fn(async () => workload());
    const resolved = await productScopeResolver(read, list).resolve(scope);
    expect(list).toHaveBeenCalledExactlyOnceWith("ws-a", "env-a");
    expect(read).toHaveBeenCalledExactlyOnceWith("ws-a", "res_web");
    expect(resolved?.scope.resourceId).toBe("res_web");
    expect(resolved?.resource).toMatchObject({ address: "container_service/web", kind: "container_service" });
  });

  it("keeps the manifest id when no row or several rows claim the service, and never canonicalizes a non-service id", async () => {
    for (const rows of [[], [workload(), workload({ id: "res_web2" })], [workload({ status: "planned" })], [workload({ status: "failed" })]]) {
      expect((await productScopeResolver(async () => null, async () => rows).resolve(scope))?.scope.resourceId).toBe("svc-web");
    }
    const list = vi.fn(async () => [workload({ origin: ["res-db"] })]);
    expect((await productScopeResolver(async () => null, list).resolve({ ...scope, resourceId: "res-db" }))?.scope.resourceId).toBe("res-db");
    expect(list).not.toHaveBeenCalled();
  });

  it("fails rather than skipping ownership review when the canonical store cannot be read", async () => {
    await expect(productScopeResolver(async () => null, async () => { throw new Error("store down"); }).resolve(scope)).rejects.toThrow("store down");
  });
});

describe("RoleResolver over the product store", () => {
  const user = (id: string): Principal => ({ kind: "user", id, name: id });
  const roles = productRoleResolver({ integrations: async () => null });

  it("reads the member's role in THIS workspace, and none for a non-member", async () => {
    expect(await roles.resolve(user("ada"), "ws-a")).toEqual({ role: "admin" });
    expect(await roles.resolve(user("eve"), "ws-a")).toEqual({ role: "editor" });
    expect(await roles.resolve(user("vic"), "ws-a")).toEqual({ role: "viewer" });
    expect(await roles.resolve(user("ada"), "ws-b")).toEqual({ role: "none" });
    expect(await roles.resolve(user("bo"), "ws-a")).toEqual({ role: "none" });
    expect(await roles.resolve(user("stranger"), "ws-a")).toEqual({ role: "none" });
    expect(await roles.resolve(user("ada"), "ws-nope")).toEqual({ role: "none" });
  });

  it("makes `local` an admin only in demo mode", async () => {
    expect(await roles.resolve(user("local"), "ws-a")).toEqual({ role: "admin" });
    flags.supabase = true;
    expect(await roles.resolve(user("local"), "ws-a")).toEqual({ role: "none" });
  });

  it("follows the membership policy for a workspace with nobody in it", async () => {
    seed([]);
    expect(await roles.resolve(user("newcomer"), "ws-a")).toEqual({ role: "admin" }); // self-hosted: nobody to defer to
    process.env.ZENITH_HOSTED_MODE = "1";
    expect(await roles.resolve(user("newcomer"), "ws-a")).toEqual({ role: "none" });
  });

  it("bounds the Navigator by the person it works for, else by the editor role", async () => {
    const nav = (onBehalfOf?: string): Principal => ({ kind: "navigator", id: "navigator", name: "Navigator", ...(onBehalfOf ? { onBehalfOf } : {}) });
    expect(await roles.resolve(nav("vic"), "ws-a")).toEqual({ role: "viewer" });
    expect(await roles.resolve(nav("ada"), "ws-a")).toEqual({ role: "admin" });
    expect(await roles.resolve(nav("ada"), "ws-b")).toEqual({ role: "none" });
    expect(await roles.resolve(nav(), "ws-a")).toEqual({ role: "editor" });
    expect(await roles.resolve(nav(), "ws-nope")).toEqual({ role: "none" });
  });

  it("gives system, runner and machine principals no role", async () => {
    for (const kind of ["system", "runner", "machine"] as const) expect(await roles.resolve({ kind, id: "x", name: "x" }, "ws-a")).toEqual({ role: "none" });
  });

  it("bounds an integration by its grant and never above the person behind it", async () => {
    const agent: Principal = { kind: "integration", id: "cred-1", name: "agent", integrationId: "cred-1", onBehalfOf: "eve" };
    const granted = productRoleResolver({ integrations: async () => ({ scopes: ["read", "write"], projectIds: ["pa"], environmentIds: ["env-a2"] }) });
    expect(await granted.resolve(agent, "ws-a")).toEqual({ role: "editor", integrationScopes: ["read", "write"], allowedProjectIds: ["pa"], allowedEnvironmentIds: ["env-a2"] });
    // the human was demoted: the agent follows
    resetDb({ workspaces: [ws("ws-a")], members: [member("eve", "ws-a", "viewer")] });
    expect((await granted.resolve(agent, "ws-a")).role).toBe("viewer");
    // the human left: nothing
    resetDb({ workspaces: [ws("ws-a")], members: [member("ada", "ws-a", "admin")] });
    expect(await granted.resolve(agent, "ws-a")).toEqual({ role: "none" });
    // the credential is gone
    seed();
    expect(await roles.resolve(agent, "ws-a")).toEqual({ role: "none" });
    const unrestricted = productRoleResolver({ integrations: async () => ({ scopes: ["read"], projectIds: ["pa"] }) });
    expect((await unrestricted.resolve(agent, "ws-a")).allowedEnvironmentIds).toBeUndefined();
  });
});

describe("credentialDirectory", () => {
  const agent: Principal = { kind: "integration", id: "cred-1", name: "agent", integrationId: "cred-1", onBehalfOf: "eve" };
  const row = (over: Record<string, unknown> = {}) => ({
    id: "cred-1",
    workspaceId: "ws-a",
    subject: "eve",
    projectIds: ["pa"],
    scopes: ["read", "write"],
    issuedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    ...over,
  });

  it("returns a live credential's scopes and limits, asking the authority fresh each time", async () => {
    authority.rows = [row({ environmentIds: ["env-a"] })];
    expect(await credentialDirectory(agent, "ws-a")).toEqual({ scopes: ["read", "write"], projectIds: ["pa"], environmentIds: ["env-a"] });
    expect(await credentialDirectory(agent, "ws-a")).not.toBeNull();
    expect(authority.asked).toEqual([["eve", "ws-a"], ["eve", "ws-a"]]);
  });

  it("returns null for a revoked, expired, other-workspace or unrelated credential", async () => {
    for (const rows of [
      [row({ revokedAt: "2026-02-01T00:00:00.000Z" })],
      [row({ expiresAt: "2020-01-01T00:00:00.000Z" })],
      [row({ workspaceId: "ws-b" })],
      [row({ id: "cred-2" })],
      [],
    ]) {
      authority.rows = rows;
      expect(await credentialDirectory(agent, "ws-a")).toBeNull();
    }
    expect(await credentialDirectory({ ...agent, integrationId: undefined }, "ws-a")).toBeNull();
    expect(await credentialDirectory({ ...agent, onBehalfOf: undefined }, "ws-a")).toBeNull();
  });

  it("refuses (503) rather than guess when the authority is unavailable", async () => {
    authority.fail = true;
    await expect(credentialDirectory(agent, "ws-a")).rejects.toMatchObject({ code: "platform_store_unavailable" });
  });
});
