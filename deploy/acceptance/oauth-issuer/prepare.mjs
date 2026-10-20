import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const ISSUER = "https://localhost:8443/realms/zenith-interop";
export const SCOPES = ["read", "plan", "export", "write", "publish", "logs"];
const POLICY_TYPE = "org.keycloak.services.clientregistration.policy.ClientRegistrationPolicy";

/** A real Keycloak realm; the operator supplies an existing Zenith member ID.
 * Its signed claim cannot be edited by the fixture user or a dynamically registered client. */
export function realmFor({ origin, subject, password }) {
  const url = new URL(origin);
  if (url.protocol !== "https:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.origin !== origin) {
    throw new Error("Zenith origin must be an exact HTTPS loopback origin");
  }
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(subject) || ["local", "system", "navigator"].includes(subject)) throw new Error("Supply an existing Zenith member ID");
  if (typeof password !== "string" || password.length < 24) throw new Error("Generate a disposable password at runtime");
  // Keycloak 26 adds "basic" (the sub claim) to every registration; the realm must define and allow it.
  const defaults = ["basic", "zenith:read", "zenith-binding"];
  const policy = (name, providerId, config) => ({ name, providerId, subType: "anonymous", config });
  return {
    realm: "zenith-interop", enabled: true, sslRequired: "all", registrationAllowed: false,
    editUsernameAllowed: false, resetPasswordAllowed: false, accessTokenLifespan: 300,
    defaultSignatureAlgorithm: "RS256", revokeRefreshToken: true, refreshTokenMaxReuse: 0,
    attributes: { "userProfileEnabled": "true" },
    users: [{ username: "interop-user", enabled: true, emailVerified: true,
      attributes: { zenith_subject: [subject] }, credentials: [{ type: "password", value: password, temporary: false }] }],
    // The signed subject is administrator-managed, never a user-editable profile attribute.
    components: {
      "org.keycloak.userprofile.UserProfileProvider": [{ name: "declarative-user-profile", providerId: "declarative-user-profile",
        config: { "kc.user.profile.config": [JSON.stringify({ attributes: [
          { name: "username", permissions: { view: ["admin", "user"], edit: ["admin", "user"] } },
          // Keycloak 26 refuses a declarative profile without email; only an administrator may change it.
          { name: "email", permissions: { view: ["admin", "user"], edit: ["admin"] } },
          { name: "zenith_subject", permissions: { view: ["admin"], edit: ["admin"] } },
        ] })] } }],
      [POLICY_TYPE]: [
        policy("Loopback redirect URIs only", "trusted-hosts", { "trusted-hosts": ["localhost", "127.0.0.1", "::1"],
          "host-sending-registration-request-must-match": ["false"], "client-uris-must-match": ["true"] }),
        policy("Human issuer consent", "consent-required", {}),
        policy("Disable full scope", "scope", {}),
        policy("Bounded disposable clients", "max-clients", { "max-clients": ["12"] }),
        policy("Only configured scopes", "allowed-client-templates", { "allowed-client-scopes": ["openid", "basic", ...SCOPES.map((s) => `zenith:${s}`), "zenith-binding"], "allow-default-scopes": ["true"] }),
        policy("No client-supplied mappers", "allowed-protocol-mappers", { "allowed-protocol-mapper-types": [] }),
      ],
    },
    clientScopes: [
      { name: "basic", protocol: "openid-connect", attributes: { "include.in.token.scope": "false", "display.on.consent.screen": "false" }, protocolMappers: [
        { name: "sub", protocol: "openid-connect", protocolMapper: "oidc-sub-mapper", config: { "access.token.claim": "true", "introspection.token.claim": "true" } },
        { name: "auth_time", protocol: "openid-connect", protocolMapper: "oidc-usersessionmodel-note-mapper", config: {
          "user.session.note": "AUTH_TIME", "claim.name": "auth_time", "jsonType.label": "long", "access.token.claim": "true", "id.token.claim": "true", "introspection.token.claim": "true" } },
      ] },
      ...SCOPES.map((scope) => ({ name: `zenith:${scope}`, protocol: "openid-connect", attributes: {
        "include.in.token.scope": "true", "display.on.consent.screen": "true", "consent.screen.text": `zenith:${scope}`,
      }, protocolMappers: [] })),
      { name: "zenith-binding", protocol: "openid-connect", attributes: { "include.in.token.scope": "false", "display.on.consent.screen": "false" }, protocolMappers: [
        { name: "exact Zenith MCP audience", protocol: "openid-connect", protocolMapper: "oidc-audience-mapper", config: {
          "included.custom.audience": `${origin}/api/agent/v3/mcp`, "access.token.claim": "true", "id.token.claim": "false" } },
        { name: "existing Zenith member", protocol: "openid-connect", protocolMapper: "oidc-usermodel-attribute-mapper", config: {
          "user.attribute": "zenith_subject", "claim.name": "zenith_subject", "jsonType.label": "String", "multivalued": "false",
          "access.token.claim": "true", "id.token.claim": "false", "userinfo.token.claim": "false" } },
      ] },
    ],
    defaultDefaultClientScopes: defaults,
    defaultOptionalClientScopes: SCOPES.filter((s) => s !== "read").map((s) => `zenith:${s}`),
    // No password grant, client credential flow or privileged fallback for MCP clients.
    clients: [],
  };
}

export async function prepare({ dir, origin, subject, issuer = ISSUER }) {
  if (![ISSUER, 'https://issuer.zenith.localhost:8443/realms/zenith-interop'].includes(issuer)) throw new Error('Choose the standalone or owned-stack issuer');
  const root = resolve(dir);
  if (/[\r\n'"$`]/.test(root)) throw new Error("Choose a plain absolute fixture directory");
  // Refuse overwrites, preserving any existing fixture and its credentials.
  await mkdir(root, { mode: 0o700 });
  await mkdir(resolve(root, "tls"), { mode: 0o755 });
  const adminPassword = randomBytes(32).toString("base64url");
  const userPassword = randomBytes(32).toString("base64url");
  const realm = realmFor({ origin, subject, password: userPassword });
  const openssl = (args) => {
    const result = spawnSync("openssl", args, { cwd: resolve(root, "tls"), stdio: "pipe" });
    if (result.status !== 0) throw new Error("openssl fixture certificate generation failed; no output printed");
  };
  // Config-file extensions also work with macOS's older LibreSSL (no -addext required).
  await writeFile(resolve(root, "tls", "ca.cnf"), [
    "[req]", "distinguished_name=dn", "x509_extensions=ca_ext", "prompt=no",
    "[dn]", "CN=Zenith disposable interop CA", "[ca_ext]",
    "basicConstraints=critical,CA:TRUE", "keyUsage=critical,keyCertSign,cRLSign", "",
  ].join("\n"), { mode: 0o644 });
  openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-keyout", "ca.key", "-out", "ca.crt", "-config", "ca.cnf"]);
  openssl(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", "server.key", "-out", "server.csr", "-subj", "/CN=localhost"]);
  await writeFile(resolve(root, "tls", "server.ext"), "subjectAltName=DNS:localhost,DNS:issuer.zenith.localhost,IP:127.0.0.1,IP:::1\nbasicConstraints=critical,CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n", { mode: 0o644 });
  openssl(["x509", "-req", "-in", "server.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", "server.crt", "-days", "2", "-extfile", "server.ext"]);
  // Keycloak UID 1000 needs to read the disposable server key; the host root stays 0700.
  const { chmod } = await import("node:fs/promises");
  await chmod(resolve(root, "tls", "server.key"), 0o644);
  await writeFile(resolve(root, "realm.json"), JSON.stringify(realm, null, 2), { mode: 0o644 });
  await writeFile(resolve(root, "compose.env"), `ZENITH_INTEROP_DIR=${root}\nZENITH_INTEROP_ADMIN_PASSWORD=${adminPassword}\n`, { mode: 0o600 });
  await writeFile(resolve(root, "credentials.json"), JSON.stringify({ username: "interop-user", password: userPassword, adminUsername: "interop-admin", adminPassword }), { mode: 0o600 });
  await writeFile(resolve(root, "zenith.env"), [
    `export ZENITH_AGENT_OAUTH_ISSUER='${issuer}'`,
    `export ZENITH_AGENT_OAUTH_JWKS='${issuer}/protocol/openid-connect/certs'`,
    "export ZENITH_AGENT_OAUTH_CLIENT_CLAIM='azp'", "export ZENITH_AGENT_OAUTH_SUBJECT_CLAIM='zenith_subject'",
    `export NODE_EXTRA_CA_CERTS='${root}/tls/ca.crt'`, "",
  ].join("\n"), { mode: 0o600 });
  return { root, issuer };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const option = (name) => args[args.indexOf(name) + 1];
  if (!["--dir", "--zenith-origin", "--subject"].every((name) => args.includes(name))) throw new Error("Usage: node prepare.mjs --dir <new private temp directory> --zenith-origin <https loopback origin> --subject <existing Zenith member ID>");
  await prepare({ dir: option("--dir"), origin: option("--zenith-origin"), subject: option("--subject") });
  console.log("Fixture prepared. Source zenith.env; use compose.env for Docker. Credentials remain in credentials.json.");
}
