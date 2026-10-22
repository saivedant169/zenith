/** Fixture setup only. Production API/worker keep their auth and source code unchanged. */
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { z } from "zod";
import { ensure, command, until, privateFile } from "../../../tests/e2e/default/support.mjs";
import { readBuildProfiles, buildTenantKey } from "@/lib/providers/kubernetes/build/custody";
import { ConfigSchema } from "@/lib/providers/kubernetes/build/config";
import type { TenantBuildProfile } from "@/lib/providers/kubernetes/build/custody";
import { sourceArchive, fixtureResponse } from "./github-emulator.mjs";
import { hash, type Operated } from "./operated";

export const BuildDeclaration = z.object({ config: ConfigSchema, registryRepositoryRoot: z.string() }).strict();
export function declaredProfile(raw: unknown, ctx: { workspaceId: string; environmentId: string; server: string; caData: string }) {
  const declaration = BuildDeclaration.parse(raw), key = buildTenantKey(ctx);
  // Production validation binds the actual fresh tenant and distinct custody identities.
  const profile = { workspaceId: ctx.workspaceId, environmentId: ctx.environmentId, provider: "kubernetes", server: ctx.server, caData: ctx.caData,
    credentialRef: "vault:DRV_SOURCE_WRITER", verifierCredentialRef: "vault:DRV_SOURCE_VERIFIER",
    registryRepositoryRoot: declaration.registryRepositoryRoot + "/" + key,
    config: { ...declaration.config, namespace: "zb-" + key, proxy: { ...declaration.config.proxy, namespace: "zp-" + key },
      nodeIsolation: { ...declaration.config.nodeIsolation, tenant: key } } };
  // Runtime probes and custody checks remain owned by the actual J6 worker.
  return readBuildProfiles({ ZENITH_ISOLATED_BUILD_PROFILES: JSON.stringify([profile]) });
}
export async function githubFixture(ctx: Operated, built?: {
  profile: TenantBuildProfile; app?: string; dockerfile: string; sourceFixture?: { appC: string; migrationSql: string };
}) {
  const sourceFixtureInput = built?.sourceFixture;
  ensure(!built || (sourceFixtureInput === undefined ? typeof built.app === "string"
    : built.app === undefined && sourceFixtureInput !== null && typeof sourceFixtureInput === "object" && !Array.isArray(sourceFixtureInput)
      && Object.keys(sourceFixtureInput).sort().join(",") === "appC,migrationSql"
      && typeof sourceFixtureInput.appC === "string" && typeof sourceFixtureInput.migrationSql === "string"), "source-fixture-archive-shape");
  const sourceFixture = sourceFixtureInput === undefined ? undefined
    : Object.freeze({ appC: sourceFixtureInput!.appC, migrationSql: sourceFixtureInput!.migrationSql });
  const sourceFixtureDockerfile = sourceFixture === undefined ? undefined : built!.dockerfile;
  const sourceFixtureExpectedArchive = sourceFixture === undefined ? undefined
    : hash(sourceArchive(sourceFixtureDockerfile!, "", undefined, sourceFixture));
  const state = ctx.stack!.state, modules = ctx.stack!.modules;
  const declarationFile = ctx.env.ZENITH_LOCAL_SOURCE_BUILD_DECLARATION_FILE;
  ensure(declarationFile && path.isAbsolute(declarationFile), "source-build-declaration-file");
  const target = (await import("../../../tests/e2e/default/support.mjs")).kubeconfig(ctx.config!.kind.kubeconfigFile, ctx.config);
  const profiles = built ? [built.profile] : declaredProfile(JSON.parse(privateFile(declarationFile)), { workspaceId: ctx.workspaceId, environmentId: ctx.environmentId,
    server: ctx.config!.kind.server, caData: target.caData });
  const id = randomBytes(12).toString("hex"), name = "zenith-drv1-" + id, volume = name + "-source";
  const label = "io.zenith.drv1=" + id, directory = ctx.scratch;
  const [api] = JSON.parse(await modules.docker(["inspect", ctx.stack!.api]));
  const network = state.applicationProjectName + "_installation";
  ensure(api.NetworkSettings.Networks[network] && api.Config.Labels?.["io.zenith.installation"] === state.applicationInstallationId, "fixture-j1-network-owner");
  const uid = Number(await modules.docker(["exec", api.Id, "node", "-p", "process.getuid()"]));
  const gid = Number(await modules.docker(["exec", api.Id, "node", "-p", "process.getgid()"]));
  ensure(Number.isSafeInteger(uid) && uid > 0 && Number.isSafeInteger(gid), "fixture-api-uid");
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const random = () => randomBytes(32).toString("hex");
  const fixture = { appId: "815", installationId: 816, repositoryId: 817, repository: "zenith-local/private-source", clientId: "zenith-local-drv1",
    clientSecret: random(), installationToken: random(), userToken: random(), code: random(), publicKey: keys.publicKey,
    callback: ctx.stack!.apiUrl + "/api/platform/v1/github/callback", commit: randomBytes(20).toString("hex"), movedCommit: randomBytes(20).toString("hex"),
    dockerfile: sourceFixture === undefined ? (built?.dockerfile ?? "FROM " + ctx.config!.kind.image + "\n") : sourceFixtureDockerfile!,
    ...(built?.app ? { app: built.app } : {}),
    ...(sourceFixture === undefined ? {} : { sourceFixture }) };
  // Validate and pin the exact archive bytes before the emulator is started. The emulator and
  // this stripped-name canonical digest consume this same immutable fixture object.
  const expectedArchive = sourceFixtureExpectedArchive ?? hash(sourceArchive(fixture.dockerfile, "", built?.app));
  const keyFile = path.join(directory, "tls.key"), csr = path.join(directory, "tls.csr"), cert = path.join(directory, "tls.crt"), ext = path.join(directory, "tls.ext");
  let overlayAttempted = false;
  const overlay = path.join(directory, "source.compose.json"), base = path.join(state.directory, "installation");
  const compose = (extra: string[]) => modules.docker(["compose", "--project-name", state.applicationProjectName, "--env-file", path.join(base, "compose.env"),
    "-f", path.join(base, "stack.compose.json"), "-f", overlay, ...extra]);
  const owned = async (kind: string, resource: string) => {
    const [current] = JSON.parse(await modules.docker([kind, "inspect", resource]));
    ensure((current.Config?.Labels ?? current.Labels)?.["io.zenith.drv1"] === id, "fixture-cleanup-owner"); return current;
  };
  ctx.cleaners.push({ id: "source-emulator-cleanup", run: async () => {
    // Restore original J1 config before removing DNS transport or private keys. Failure prevents deleting their backing volume.
    if (overlayAttempted) {
      await modules.compose(state, ["up", "-d", "--no-deps", "--force-recreate", "api", "execution-worker"]);
      for (const service of ["api", "execution-worker"]) {
        const container = (await modules.compose(state, ["ps", "-q", service])).trim();
        const [current] = JSON.parse(await modules.docker(["inspect", container]));
        ensure(!current.Config.Env.some((v: string) => /^ZENITH_GITHUB_APP_|^ZENITH_ISOLATED_BUILD_PROFILES=/.test(v))
          && !current.Mounts.some((m: { Name?: string }) => m.Name === volume), "source-overlay-restored");
      }
    }
    // Inventory by the random owner label also covers interrupted create/seed commands.
    const containers = await modules.docker(["container", "ls", "-aq", "--filter", "label=" + label]);
    for (const container of containers.split(/\s+/).filter(Boolean)) {
      const current = await owned("container", container);
      ensure(["/" + name, "/" + name + "-seed"].includes(current.Name), "fixture-cleanup-exact-name");
      await modules.docker(["rm", "-f", current.Id]);
    }
    if (await modules.docker(["volume", "ls", "-q", "--filter", "label=" + label])) { await owned("volume", volume); await modules.docker(["volume", "rm", volume]); }
    const remaining = await modules.docker(["container", "ls", "-aq", "--filter", "label=" + label]);
    const volumes = await modules.docker(["volume", "ls", "-q", "--filter", "label=" + label]);
    ensure(!remaining && !volumes, "source-fixture-absence");
    for (const file of [keyFile, csr, cert, ext, overlay]) if (existsSync(file)) unlinkSync(file);
  } });
  writeFileSync(ext, "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:github.com,DNS:api.github.com,DNS:codeload.github.com\n", { mode: 0o600, flag: "wx" });
  await command("openssl", ["req", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=Zenith local source emulator", "-keyout", keyFile, "-out", csr]);
  await command("openssl", ["x509", "-req", "-in", csr, "-CA", path.join(state.directory, "tls/ca.crt"), "-CAkey", path.join(state.directory, "tls/ca.key"),
    "-set_serial", "0x" + id, "-days", "1", "-extfile", ext, "-out", cert]);
  ensure(!(await modules.docker(["container", "ls", "-aq", "--filter", "name=^/" + name + "$"])), "fixture-name-free");
  const parentLabel = "io.zenith.installation=" + state.applicationInstallationId;
  await modules.docker(["volume", "create", "--label", label, "--label", parentLabel, volume]);
  const files: Record<string, string> = {
    "app.key": keys.privateKey, "client-secret": fixture.clientSecret, "fixture.json": JSON.stringify(fixture),
    "tls.key": readFileSync(keyFile, "utf8"), "tls.crt": readFileSync(cert, "utf8"), "ca.crt": readFileSync(path.join(state.directory, "tls/ca.crt"), "utf8"),
    "control.json": JSON.stringify({ moved: false, revoked: false }), "stats.json": "{}",
    "github-emulator.mjs": readFileSync(path.resolve("scripts/release/drivers/github-emulator.mjs"), "utf8"),
  };
  // Secret material travels only over stdin into an owned private volume, with API uid custody.
  await modules.docker(["run", "-i", "--rm", "--name", name + "-seed", "--label", label, "--label", parentLabel, "--memory", "64m", "--cpus", "0.25", "--pids-limit", "64", "--network", "none", "--user", "0", "--cap-drop", "ALL", "--cap-add", "CHOWN", "--security-opt", "no-new-privileges:true",
    "--mount", "type=volume,source=" + volume + ",target=/fixture", "--entrypoint", "node", api.Image, "-e",
    "let s='';process.stdin.on('data',b=>s+=b);process.stdin.on('end',()=>{const fs=require('fs'),p=JSON.parse(s);fs.chmodSync('/fixture',0o755);for(const [n,v] of Object.entries(p.files)){fs.writeFileSync('/fixture/'+n,v,{mode:n==='ca.crt'?0o644:0o600});fs.chownSync('/fixture/'+n,p.uid,p.gid)}})"], { input: JSON.stringify({ files, uid, gid }) });
  await modules.docker(["create", "--name", name, "--label", label, "--label", parentLabel, "--network", network, "--memory", "64m", "--cpus", "0.25", "--pids-limit", "64",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--read-only", "--mount", "type=volume,source=" + volume + ",target=/fixture",
    "--entrypoint", "node", api.Image, "/fixture/github-emulator.mjs"]);
  await modules.docker(["start", name]);
  const current = await owned("container", name), ip = current.NetworkSettings.Networks[network].IPAddress;
  ensure(/^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(ip) || /^10\.\d+\.\d+\.\d+$/.test(ip) || /^192\.168\.\d+\.\d+$/.test(ip), "owned-source-private-ip");
  const extraHosts = ["api.github.com:" + ip, "codeload.github.com:" + ip, "github.com:" + ip];
  // Preserve the exact generated J1 composition; use a separate bounded overlay, never edit its hash/state.
  const original = JSON.parse(readFileSync(path.join(base, "stack.compose.json"), "utf8"));
  const services = Object.fromEntries(["api", "execution-worker"].map(service => {
    const originalCa = original.services[service].environment?.NODE_EXTRA_CA_CERTS;
    return [service, { extra_hosts: extraHosts, volumes: [volume + ":/run/j15-source:ro"], environment: {
      NODE_EXTRA_CA_CERTS: originalCa ?? "/run/j15-source/ca.crt", ZENITH_GITHUB_APP_ID: fixture.appId,
      ZENITH_GITHUB_APP_PRIVATE_KEY_FILE: "/run/j15-source/app.key", ZENITH_GITHUB_APP_CLIENT_ID: fixture.clientId,
      ZENITH_GITHUB_APP_CLIENT_SECRET_FILE: "/run/j15-source/client-secret", ZENITH_ISOLATED_BUILD_PROFILES: JSON.stringify(profiles),
    } }];
  }));
  ensure(!existsSync(overlay), "fresh-source-overlay");
  writeFileSync(overlay, JSON.stringify({ services, volumes: { [volume]: { external: true, name: volume } } }), { mode: 0o600, flag: "wx" });
  overlayAttempted = true;
  await compose(["up", "-d", "--no-deps", "--force-recreate", "api", "execution-worker"]);
  // The recreated API refuses connections until it listens; an in-page fetch then throws rather than returning a status.
  await until(() => ctx.request("/api/platform/v1/github/binding").catch(() => null),
    (r: Awaited<ReturnType<Operated["request"]>> | null) => r?.status === 200 && r.data.appConfigured === true);
  // The provider browser surface is modeled locally; no interception of any Zenith approval endpoint.
  let browserState = { minted: 0, authenticated: 0, refused: 0, moved: false, revoked: false };
  await ctx.a!.route("https://github.com/**", async route => {
    const url = new URL(route.request().url());
    const result = fixtureResponse(fixture, browserState, { host: url.hostname, url: url.href, method: "GET" });
    browserState = { ...browserState };
    if (url.pathname === "/login/oauth/authorize") {
      await modules.docker(["exec", name, "node", "-e", "const fs=require('fs');const p=JSON.parse(fs.readFileSync('/fixture/control.json'));p.challenge=process.argv[1];fs.writeFileSync('/fixture/control.json',JSON.stringify(p))", url.searchParams.get("code_challenge")!]);
    }
    await route.fulfill({ status: result.status, headers: result.headers, body: result.body });
  });
  return {
    fixture, expectedArchive,
    control: async (moved: boolean, revoked: boolean) => { await modules.docker(["exec", name, "node", "-e",
      "const fs=require('fs');const p=JSON.parse(fs.readFileSync('/fixture/control.json'));p.moved=process.argv[1]==='true';p.revoked=process.argv[2]==='true';fs.writeFileSync('/fixture/control.json',JSON.stringify(p))", String(moved), String(revoked)]); },
    stats: async () => JSON.parse(await modules.docker(["exec", name, "node", "-p", "require('fs').readFileSync('/fixture/stats.json','utf8')"])) as { minted: number; authenticated: number; archiveReads: number; movedArchiveReads: number },
  };
}
