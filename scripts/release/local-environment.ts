/** Disposable local engines for J15. All mutations need the explicit local gate. */
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync, readdirSync, chmodSync, lstatSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { LambdaClient, CreateFunctionCommand, GetFunctionConfigurationCommand } from "@aws-sdk/client-lambda";
import { defaultExec, type Exec } from "./acceptance-orchestrator";
import { localEnvironment } from "./local-targets";
import { mixedObjects, NAMESPACE } from "./local-kubernetes";

export type Profile = "mixed" | "acme" | "billing";
export interface LocalState {
  schema: 1; runId: string; root: string; cluster: string; variant: "lambda" | "container";
  profile: Profile; kubeconfig: string; createdCluster: boolean; ready: boolean;
}
export function localPaths(env: Readonly<Record<string, string | undefined>>): { runId: string; root: string; cluster: string } {
  if (env.ZENITH_LOCAL_TARGETS !== "1") throw new Error("not run: needs ZENITH_LOCAL_TARGETS=1");
  const runId = env.ZENITH_LOCAL_RUN_ID ?? "";
  if (!/^[a-z0-9][a-z0-9-]{3,19}$/.test(runId)) throw new Error("Local run id must be 4 to 20 lowercase letters, digits or dashes");
  if (!env.ZENITH_LOCAL_ROOT || !path.isAbsolute(env.ZENITH_LOCAL_ROOT)) throw new Error("ZENITH_LOCAL_ROOT must name an absolute private scratch directory");
  const root = path.resolve(env.ZENITH_LOCAL_ROOT);
  if (root === path.parse(root).root || root === path.resolve(process.cwd())) throw new Error("Refusing a filesystem or checkout root as scratch");
  if (!path.basename(root).startsWith(`zenith-j15-${runId}-`)) throw new Error("Scratch must have the dedicated zenith-j15-<runId>- prefix");
  return { runId, root, cluster: `zenith-j15-${runId}` };
}
export async function command(argv: readonly string[], env: NodeJS.ProcessEnv, exec: Exec = defaultExec, cwd = process.cwd()): Promise<string> {
  const result = await exec(argv, { cwd, env, timeoutMs: 240_000 });
  if (result.code !== 0) throw new Error(`Local command failed: ${argv[0]} ${argv[1] ?? ""} (exit ${result.code}); inspect owned engine logs`);
  return result.stdout;
}
export const composeArgs = (profile?: Profile): string[] => ["docker", "compose", "-f", "deploy/acceptance/local-targets/compose.yml", ...(profile ? ["--profile", profile] : ["--profile", "mixed", "--profile", "acme", "--profile", "billing"])];
export const kubeArgs = (state: LocalState): string[] => ["kubectl", "--kubeconfig", state.kubeconfig, "--context", `kind-${state.cluster}`];
export async function waitFor(check: () => Promise<boolean>, timeoutMs = 180_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error("Local engine readiness deadline exceeded");
}
export function readState(env: Readonly<Record<string, string | undefined>>): LocalState {
  const expected = localPaths(env);
  const state = JSON.parse(readFileSync(path.join(expected.root, "state.json"), "utf8")) as LocalState;
  if (state.schema !== 1 || state.runId !== expected.runId || state.root !== expected.root || state.cluster !== expected.cluster
    || state.kubeconfig !== path.join(expected.root, "kubeconfig") || !["mixed", "acme", "billing"].includes(state.profile)
    || !["lambda", "container"].includes(state.variant)) throw new Error("Local ownership state mismatch");
  return state;
}
export async function assertLocalDocker(env: NodeJS.ProcessEnv, exec: Exec = defaultExec): Promise<void> {
  const assert = (host: string) => {
    if (host.startsWith("unix://") || host.startsWith("npipe://")) return;
    const url = new URL(host);
    if (url.protocol !== "tcp:" || !["127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("Refusing a remote Docker engine");
  };
  if (env.DOCKER_HOST) { assert(env.DOCKER_HOST); return; }
  const host = (await command(["docker", "context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], env, exec)).trim();
  assert(host);
}
export async function assertLocalCluster(state: LocalState, env: NodeJS.ProcessEnv, exec: Exec = defaultExec): Promise<void> {
  const value = JSON.parse(await command([...kubeArgs(state), "config", "view", "--minify", "-o", "json"], env, exec)) as { clusters: { cluster: { server: string } }[] };
  const url = new URL(value.clusters[0]?.cluster.server ?? "");
  if (!["127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("Refusing non-loopback Kubernetes API");
  const ns = JSON.parse(await command([...kubeArgs(state), "get", "namespace", NAMESPACE, "-o", "json"], env, exec)) as { metadata: { labels: Record<string, string> } };
  if (ns.metadata.labels["zenith.acceptance.owner"] !== "j15" || ns.metadata.labels["zenith.acceptance.run"] !== state.runId) throw new Error("Namespace belongs to a different run");
}
async function pki(root: string, env: NodeJS.ProcessEnv, exec: Exec): Promise<void> {
  const dir = path.join(root, "pki"); mkdirSync(dir, { mode: 0o700 });
  await command(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.crt", "-days", "2", "-subj", "/CN=Zenith-J15-Local-CA"], env, exec, dir);
  for (const [name, cn, san, eku] of [
    ["web", "web", "DNS:web.zenith-j15.svc.cluster.local", "clientAuth"],
    ["db", "db.zenith-j15.svc.cluster.local", "DNS:db.zenith-j15.svc.cluster.local", "serverAuth"],
    ["enricher", "enricher.zenith-j15.svc.cluster.local", "DNS:enricher.zenith-j15.svc.cluster.local", "serverAuth"],
    ["pebble", "localhost", "DNS:localhost,IP:127.0.0.1", "serverAuth"],
  ]) {
    writeFileSync(path.join(dir, `${name}.ext`), `subjectAltName=${san}\nextendedKeyUsage=${eku}\n`, { mode: 0o600 });
    await command(["openssl", "req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", `${name}.key`, "-out", `${name}.csr`, "-subj", `/CN=${cn}`], env, exec, dir);
    await command(["openssl", "x509", "-req", "-in", `${name}.csr`, "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", `${name}.crt`, "-days", "2", "-extfile", `${name}.ext`], env, exec, dir);
  }
}
async function secret(state: LocalState, name: string, files: Record<string, string>, env: NodeJS.ProcessEnv, exec: Exec): Promise<void> {
  const json = JSON.parse(await command([...kubeArgs(state), "-n", NAMESPACE, "create", "secret", "generic", name, ...Object.entries(files).map(([key, file]) => `--from-file=${key}=${file}`), "--dry-run=client", "-o", "json"], env, exec));
  const file = path.join(state.root, `${name}.json`);
  writeFileSync(file, JSON.stringify(json), { mode: 0o600 });
  await command([...kubeArgs(state), "apply", "-f", file], env, exec);
}
export async function setupLambda(root: string): Promise<void> {
  const client = new LambdaClient({ region: "us-east-1", endpoint: "http://127.0.0.1:14566", credentials: { accessKeyId: randomBytes(10).toString("hex"), secretAccessKey: randomBytes(24).toString("hex") } });
  try {
    const { createHash } = await import("node:crypto");
    const code = readFileSync(path.join(root, "lambda.zip"));
    const current = await client.send(new GetFunctionConfigurationCommand({ FunctionName: "zenith-j15-enricher" })).catch((error: { name: string }) => {
      if (error.name === "ResourceNotFoundException") return undefined;
      throw error;
    });
    if (current && current.CodeSha256 !== createHash("sha256").update(code).digest("base64")) throw new Error("Existing local Lambda has different code");
    if (!current) await client.send(new CreateFunctionCommand({
      FunctionName: "zenith-j15-enricher", Runtime: "nodejs22.x", Handler: "enricher/lambda.handler",
      Role: "arn:aws:iam::000000000000:role/zenith-j15-local", Architectures: [process.arch === "arm64" ? "arm64" : "x86_64"],
      Code: { ZipFile: readFileSync(path.join(root, "lambda.zip")) }, Timeout: 10, MemorySize: 128,
    }));
    await waitFor(async () => (await client.send(new GetFunctionConfigurationCommand({ FunctionName: "zenith-j15-enricher" }))).State === "Active");
  } finally { client.destroy(); }
}
export async function upLocal(profile: Profile, variant: "lambda" | "container", rawEnv: Readonly<Record<string, string | undefined>>, exec: Exec = defaultExec): Promise<LocalState> {
  const paths = localPaths(rawEnv); const env = localEnvironment(rawEnv);
  const pins = Object.fromEntries(readFileSync("deploy/observability/images.env", "utf8").split(/\r?\n/).filter(line => /^[A-Z][A-Z0-9_]*=/.test(line)).map(line => { const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1)]; }));
  if (!["arm64", "x64"].includes(process.arch)) throw new Error("Local acceptance requires a supported native Docker architecture");
  env.ZENITH_LOCAL_STRIPE_IMAGE = pins[process.arch === "arm64" ? "ZENITH_LOCAL_STRIPE_ARM64_IMAGE" : "ZENITH_LOCAL_STRIPE_AMD64_IMAGE"];
  if (!/^stripe\/stripe-mock:v[\w.-]+@sha256:[a-f0-9]{64}$/.test(env.ZENITH_LOCAL_STRIPE_IMAGE ?? "")) throw new Error("Native Stripe fixture pin is absent");
  const postgresImage = pins.ZENITH_LOCAL_POSTGRES_IMAGE;
  if (!/^postgres:16\.[\d]+-alpine@sha256:[a-f0-9]{64}$/.test(postgresImage ?? "")) throw new Error("Local PostgreSQL pin is absent");
  if (!["mixed", "acme", "billing"].includes(profile) || !["lambda", "container"].includes(variant)) throw new Error("Unknown profile or fixture variant");
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  if (lstatSync(paths.root).isSymbolicLink()) throw new Error("Scratch must not be a symlink");
  if (existsSync(path.join(paths.root, "state.json"))) throw new Error("Run already exists; use down before a fresh up");
  if (readdirSync(paths.root).length) throw new Error("Use an empty disposable scratch directory");
  await assertLocalDocker(env, exec);
  const clusters = profile === "mixed" ? await command(["kind", "get", "clusters"], env, exec) : "";
  if (clusters.split(/\s+/).includes(paths.cluster)) throw new Error("Refusing an existing kind cluster");
  const containers = await command(["docker", "ps", "-aq", "--filter", `label=com.docker.compose.project=${paths.cluster}`], env, exec);
  if (containers.trim()) throw new Error("Refusing an existing compose project");
  if (profile === "acme") {
    // Reject overlaps with the fixed DNS target subnet before creating its network.

    const networks = (await command(["docker", "network", "ls", "-q"], env, exec)).trim().split(/\s+/).filter(Boolean);
    if (networks.length) {
      const configs = JSON.parse(await command(["docker", "network", "inspect", ...networks], env, exec)) as { IPAM: { Config: { Subnet?: string }[] | null } }[];
      const { cidrsOverlap, parseCidr } = await import("@/lib/execution/mixed/connectivity");
      if (configs.some(n => (n.IPAM.Config ?? []).some(c => c.Subnet && parseCidr(c.Subnet) && cidrsOverlap(parseCidr(c.Subnet)!, parseCidr("172.30.115.0/24")!)))) throw new Error("ACME subnet overlaps an existing Docker network");
    }
  }
  const state: LocalState = { schema: 1, ...paths, profile, variant, kubeconfig: path.join(paths.root, "kubeconfig"), createdCluster: false, ready: false };
  const save = () => writeFileSync(path.join(paths.root, "state.json"), JSON.stringify(state), { mode: 0o600 });
  save(); mkdirSync(path.join(paths.root, "challenge"), { mode: 0o700 });
  await pki(paths.root, env, exec);
  chmodSync(path.join(paths.root, "pki/pebble.key"), 0o644);
  const images = (await command([...composeArgs(profile), "config", "--images"], env, exec)).trim().split(/\s+/);
  for (const ref of new Set([...images, ...(profile === "mixed" ? [postgresImage] : [])])) {
    if (!/@sha256:[a-f0-9]{64}$/.test(ref)) throw new Error("Local engine image is not pinned");
    await command(["docker", "pull", ref], env, exec);
    const [image] = JSON.parse(await command(["docker", "image", "inspect", ref], env, exec)) as { Architecture: string }[];
    if (image.Architecture !== (process.arch === "arm64" ? "arm64" : "amd64")) throw new Error("Local image does not support the native architecture");
  }
  await command([...composeArgs(profile), "up", "-d", "--wait", "--wait-timeout", "120"], env, exec);
  if (profile === "mixed") {
    await waitFor(async () => (await fetch("http://127.0.0.1:14566/_localstack/health", { redirect: "error", signal: AbortSignal.timeout(3000) })).ok);
    const context = path.join(paths.root, "build"); mkdirSync(context);
    cpSync("fixtures/mixed-app", path.join(context, "fixture"), { recursive: true });
    cpSync(realpathSync("node_modules/postgres"), path.join(context, "postgres"), { recursive: true });
    const image = `zenith-j15-fixture:${paths.runId}`;
    await command(["docker", "build", "-f", "fixtures/mixed-app/Dockerfile", "-t", image, context], env, exec);
    state.createdCluster = true; save();
    await command(["kind", "create", "cluster", "--name", paths.cluster, "--config", "deploy/acceptance/local-targets/kind.yml", "--kubeconfig", state.kubeconfig, "--wait", "120s"], env, exec);
    await command(["docker", "update", "--memory", "2048m", "--memory-swap", "2560m", `${paths.cluster}-control-plane`], env, exec);
    await command(["kind", "load", "docker-image", image, "--name", paths.cluster], env, exec);
    // kind load re-exports a pulled multi-platform index without its other platforms (containerd image store); the node
    // pulls the pinned index itself so the exact digest resolves under imagePullPolicy Never.
    await command(["docker", "exec", `${paths.cluster}-control-plane`, "crictl", "pull", postgresImage], env, exec);
    await command(["docker", "network", "connect", `${paths.cluster}-mixed`, `${paths.cluster}-control-plane`], env, exec);
    const cid = (await command([...composeArgs("mixed"), "ps", "-q", "localstack"], env, exec)).trim();
    const ip = (await command(["docker", "inspect", "-f", `{{(index .NetworkSettings.Networks "${paths.cluster}-mixed").IPAddress}}`, cid], env, exec)).trim();
    const objects = mixedObjects({ runId: paths.runId, image, postgresImage, localstackIp: ip, variant });
    const nsFile = path.join(paths.root, "namespace.json");
    writeFileSync(nsFile, JSON.stringify(objects[0]));
    await command([...kubeArgs(state), "apply", "-f", nsFile], env, exec);
    const keyFile = (name: string) => path.join(paths.root, "pki", name);
    await secret(state, "web-pki", Object.fromEntries(["ca.crt", "web.crt", "web.key"].map(n => [n, keyFile(n)])), env, exec);
    await secret(state, "enricher-pki", Object.fromEntries(["ca.crt", "enricher.crt", "enricher.key"].map(n => [n, keyFile(n)])), env, exec);
    await secret(state, "db-pki", Object.fromEntries(["ca.crt", "db.crt", "db.key"].map(n => [n, keyFile(n)])), env, exec);
    writeFileSync(path.join(paths.root, "database-url"), "postgres://web@db.zenith-j15.svc.cluster.local:5432/mixed", { mode: 0o600 });
    writeFileSync(path.join(paths.root, "pg-password"), randomBytes(32).toString("hex"), { mode: 0o600 });
    writeFileSync(path.join(paths.root, "pg_hba.conf"), "local all all trust\nhostssl mixed web 0.0.0.0/0 cert\nhostssl mixed web ::/0 cert\nhost all all 0.0.0.0/0 reject\nhost all all ::/0 reject\n", { mode: 0o600 });
    await secret(state, "web-config", { "database-url": path.join(paths.root, "database-url") }, env, exec);
    await secret(state, "db-config", { "pg_hba.conf": path.join(paths.root, "pg_hba.conf"), "password": path.join(paths.root, "pg-password") }, env, exec);
    const resources = path.join(paths.root, "resources.json");
    writeFileSync(resources, JSON.stringify({ apiVersion: "v1", kind: "List", items: objects.slice(1) }));
    await command([...kubeArgs(state), "apply", "-f", resources], env, exec);
    await command([...kubeArgs(state), "-n", NAMESPACE, "rollout", "status", "deployment/db", "--timeout=120s"], env, exec);
    const schema = readFileSync("fixtures/mixed-app/db/schema.sql", "utf8") + "\ncreate role web login; create role readback login; grant select,insert on orders to web; grant usage,select on sequence orders_id_seq to web; grant select on orders to readback; alter role readback set default_transaction_read_only=on;";
    await command([...kubeArgs(state), "-n", NAMESPACE, "exec", "deployment/db", "--", "psql", "-U", "postgres", "-d", "mixed", "-v", "ON_ERROR_STOP=1", "-c", schema], env, exec);
    if (variant === "lambda") {
      await command(["zip", "-r", path.join(paths.root, "lambda.zip"), "enricher/handler.mjs", "enricher/lambda.mjs", "spec.json"], env, exec, "fixtures/mixed-app");
      await setupLambda(paths.root);
    }
    for (const name of ["web", "enricher"]) await command([...kubeArgs(state), "-n", NAMESPACE, "rollout", "status", `deployment/${name}`, "--timeout=120s"], env, exec);
  }
  state.ready = true; save(); return state;
}
export async function downLocal(rawEnv: Readonly<Record<string, string | undefined>>, exec: Exec = defaultExec): Promise<void> {
  const state = readState(rawEnv); const env = localEnvironment(rawEnv);
  await assertLocalDocker(env, exec);
  if (state.createdCluster) {
    const nodes = (await command(["docker", "ps", "-aq", "--filter", `label=io.x-k8s.kind.cluster=${state.cluster}`], env, exec)).trim();
    if (nodes) await command(["kind", "delete", "cluster", "--name", state.cluster], env, exec);
  }
  await command([...composeArgs(), "down", "--volumes", "--remove-orphans"], env, exec);
  if ((await command(["docker", "ps", "-aq", "--filter", `label=com.docker.compose.project=${state.cluster}`], env, exec)).trim()) throw new Error("Owned compose resources remain");
  const { unlinkSync } = await import("node:fs");
  // Keep private scratch for diagnosis; never recursively remove a computed path.
  unlinkSync(path.join(state.root, "state.json"));
}
