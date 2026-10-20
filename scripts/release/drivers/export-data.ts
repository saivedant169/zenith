/** Real LIFE-11 operations on owned local engines. Fixture setup writes only resource descriptors, never operations, approvals or portability evidence. */
import { randomBytes } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { S3Client, CreateBucketCommand, PutBucketTaggingCommand } from "@aws-sdk/client-s3";
import { browserRequest, ok, action, nonce, until, command, ensure, privateFile, NATIVE } from "../../../tests/e2e/default/support.mjs";
import { readState, save } from "../../acceptance/default-stack/runtime.mjs";
import { OwnedCleanup } from "./protocol";
import { approveOperation, connectKind, createTenant, deployKind, detailOf, type OperatedContext, type Tenant } from "./operated";
import { assertHttpRefusal } from "./two-tenants";
import { postgresEndpoint, postgresLeg } from "./export-data-postgres";
import { mysqlLeg } from "./export-data-mysql";
import { objectStoreLeg } from "./export-data-objects";
import type { DataLeg, LegContext, LegEndpoint } from "./export-data-leg";
import { DATA_KINDS, DataProofSchema, assertEqualContent, fixtureContainerName, hash, knownData, objectWitness, pinnedFixtureImages, rowWitness, type DataKind } from "./export-data-plan";

interface Container { id: string; name: string; port: number; close(): Promise<void> }
interface Storage { container: Container; password: string; accessKey: string; client: S3Client }
interface Resources { source: string; target: string; storage: string }
interface ExportRecord { id: string; operationId: string; workspaceId: string; environmentId: string; resourceId: string; contentDigest: string }
interface RestoreRecord { operationId: string; exportId: string; targetResourceId: string; status: string; expectedContentDigest: string; observedContentDigest: string }
interface PortabilityView { environmentId: string; truncated: boolean; exports: ExportRecord[]; restores: RestoreRecord[] }
const quote = (s: string) => "'" + s.replaceAll("'", "''") + "'";
const terminal = ["succeeded", "failed", "denied", "expired", "cancelled", "rejected"];

/** Use J1's already-owned CA and network, and explicitly opt ONLY its worker into private fixture connections. */
async function configureWorker(ctx: OperatedContext): Promise<string> {
  ensure(ctx.input.env.ZENITH_LOCAL_EXPORT_DATA === "1", "explicit-data-rehearsal-gate");
  const state = readState(ctx.config.stackDirectory);
  ensure(/^[a-f0-9]{24}$/.test(state.applicationInstallationId ?? ""), "application-installation-identity");
  const [api] = JSON.parse(await command("docker", ["inspect", ctx.stack.api]));
  const networkNames = Object.keys(api.NetworkSettings.Networks);
  ensure(networkNames.length === 1, "one-owned-stack-network");
  const [network] = JSON.parse(await command("docker", ["network", "inspect", networkNames[0]]));
  ensure(network.Labels?.["io.zenith.installation"] === state.applicationInstallationId, "owned-network-label");
  const file = path.join(state.directory, "installation/stack.compose.json");
  const original = privateFile(file);
  ensure(hash(readFileSync(file)) === state.compositionSha256, "current-composition");
  const document = JSON.parse(original), worker = document.services["execution-worker"];
  ensure(state.profile === "lean" && worker.labels["io.zenith.installation"] === state.applicationInstallationId
    && worker.environment.NODE_EXTRA_CA_CERTS === "/run/zenith-ca.crt", "owned-lean-worker");
  worker.environment.ZENITH_PORTABILITY_ALLOW_PRIVATE_HOSTS = "1";
  worker.environment.ZENITH_MYSQL_CA_FILE = "/run/zenith-ca.crt";
  writeFileSync(file, JSON.stringify(document, null, 2) + "\n", { mode: 0o600 });
  state.compositionSha256 = hash(readFileSync(file)); save(path.join(state.directory, "state.json"), state);
  ctx.stack.state = state;
  await ctx.stack.modules.compose(state, ["up", "-d", "--no-deps", "execution-worker"]);
  ctx.stack.worker = (await ctx.stack.modules.compose(state, ["ps", "-q", "execution-worker"])).trim();
  await until(async () => JSON.parse(await command("docker", ["inspect", ctx.stack.worker]))[0],
    (item: { State: { Health?: { Status: string } }; Config: { Env: string[] } }) => item.State.Health?.Status === "healthy"
      && item.Config.Env.includes("ZENITH_PORTABILITY_ALLOW_PRIVATE_HOSTS=1") && item.Config.Env.includes("ZENITH_MYSQL_CA_FILE=/run/zenith-ca.crt"));
  return network.Id;
}
async function ownedContainer(ctx: OperatedContext, cleanup: OwnedCleanup, network: string, image: string, suffix: string, port: number, env: Record<string, string>, args: string[] = [], mounts: string[] = [], assignedName?: string): Promise<Container> {
  const name = assignedName ?? fixtureContainerName(ctx.input.runId, suffix, nonce());
  ensure(/^[a-z0-9-]+$/.test(name) && (name + "-wrong").length <= 63, "container-dns-name");
  const [identity] = JSON.parse(await command("docker", ["image", "inspect", image]));
  ensure(identity.Architecture === NATIVE?.image, "native-data-image");
  ensure(Object.keys(identity.Config.Volumes ?? {}).every(volume => mounts.some(m => m.includes(`dst=${volume},`) || m.endsWith(`dst=${volume}`))), "no-anonymous-data-volumes");
  const created: { id?: string } = {};
  const close = async () => {
    const found = (await command("docker", ["container", "ls", "-aq", "--filter", `name=^/${name}$`])).trim();
    if (!found) return;
    const [item] = JSON.parse(await command("docker", ["inspect", found]));
    ensure(item.Name === "/" + name && (!created.id || item.Id === created.id) && item.Config.Labels?.["io.zenith.driver.run"] === ctx.input.runId
      && item.Config.Labels?.["io.zenith.driver"] === "DRV4-DATA", "owned-data-cleanup");
    await command("docker", ["rm", "-f", item.Id]);
    ensure(!(await command("docker", ["container", "ls", "-aq", "--filter", `name=^/${name}$`])).trim(), "owned-data-absence");
  };
  cleanup.add(close); // Registered before Docker mutates, including a lost create response.
  const envFile = path.join(ctx.scratch, name + ".env");
  writeFileSync(envFile, Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600, flag: "wx" });
  const id = (await command("docker", ["run", "-d", "--pull", "never", "--name", name, "--network", network, "--network-alias", name,
    "--network-alias", name + "-wrong", "--label", "io.zenith.driver=DRV4-DATA", "--label", `io.zenith.driver.run=${ctx.input.runId}`,
    "--memory", suffix.startsWith("mysql") ? "320m" : "192m", "--cpus", "0.5", "--pids-limit", "256", "--security-opt", "no-new-privileges:true",
    "--publish", `127.0.0.1::${port}`, "--env-file", envFile, ...mounts.flatMap(m => ["--mount", m]), image, ...args])).trim();
  ensure(/^[a-f0-9]{64}$/.test(id), "owned-data-container-id");
  created.id = id;
  const [item] = JSON.parse(await command("docker", ["inspect", id]));
  const published = item.NetworkSettings.Ports[`${port}/tcp`];
  ensure(published?.length === 1 && published[0].HostIp === "127.0.0.1", "loopback-only-data-port");
  return { id, name, port: Number(published[0].HostPort), close };
}
async function storage(ctx: OperatedContext, cleanup: OwnedCleanup, network: string, image: string, role: string): Promise<Storage> {
  const accessKey = randomBytes(16).toString("hex"), password = randomBytes(32).toString("hex");
  const container = await ownedContainer(ctx, cleanup, network, image, `minio-${role}`, 9000,
    { MINIO_ROOT_USER: accessKey, MINIO_ROOT_PASSWORD: password }, ["server", "/data"], ["type=tmpfs,dst=/data,tmpfs-size=67108864"]);
  const client = new S3Client({ region: "us-east-1", endpoint: `http://127.0.0.1:${container.port}`, forcePathStyle: true,
    credentials: { accessKeyId: accessKey, secretAccessKey: password }, maxAttempts: 1 });
  cleanup.add(async () => { client.destroy(); });
  await until(async () => fetch(`http://127.0.0.1:${container.port}/minio/health/ready`, { redirect: "error", signal: AbortSignal.timeout(2000) }).then(r => r.ok).catch(() => false), (ready: boolean) => ready);
  return { container, password, accessKey, client };
}
const bucket = (role: string, tenant: "a" | "b", run: string) => `drv4-${run}-${role}-${tenant}`;
/** The stock server clients seed fixtures; independent host connections read them. */
async function serverSql(container: Container, kind: "postgres" | "mysql", sql: string, database = "postgres"): Promise<void> {
  const argv = kind === "postgres" ? ["psql", "-X", "-U", "postgres", "-d", database, "-v", "ON_ERROR_STOP=1"]
    : ["sh", "-c", 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql --protocol=socket -uroot --binary-mode'];
  const options = { input: sql, timeout: 120_000 };
  await command("docker", ["exec", "-i", container.id, ...argv], options);
}
async function databasePair(ctx: OperatedContext, cleanup: OwnedCleanup, network: string, leg: DataLeg) {
  const kind = leg.kind;
  if (kind !== "postgres" && kind !== "mysql") throw new Error("Database leg kind required");
  const password = randomBytes(32).toString("hex"), user = kind === "postgres" ? "postgres" : "root";
  const pair: Container[] = [];
  for (const role of ["source", "target"]) {
    const mounts: string[] = [], args: string[] = [];
    const name = fixtureContainerName(ctx.input.runId, `${kind}-${role}`, nonce());
    if (kind === "mysql") {
      const stem = path.join(ctx.scratch, `mysql-${role}`), ca = path.join(ctx.config.stackDirectory, "tls");
      await command("openssl", ["req", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=localhost", "-keyout", stem + ".key", "-out", stem + ".csr"]);
      writeFileSync(stem + ".ext", `subjectAltName=IP:127.0.0.1,DNS:${name}\nextendedKeyUsage=serverAuth\n`, { mode: 0o600 });
      await command("openssl", ["x509", "-req", "-in", stem + ".csr", "-CA", path.join(ca, "ca.crt"), "-CAkey", path.join(ca, "ca.key"), "-CAserial", stem + ".serial", "-CAcreateserial", "-days", "1", "-extfile", stem + ".ext", "-out", stem + ".crt"]);
      chmodSync(stem + ".key", 0o644); // private parent; the server's unprivileged uid must read this bind mount
      mounts.push(`type=bind,src=${stem}.key,dst=/run/server.key,readonly`, `type=bind,src=${stem}.crt,dst=/run/server.crt,readonly`, `type=bind,src=${path.join(ca, "ca.crt")},dst=/run/ca.crt,readonly`, "type=tmpfs,dst=/var/lib/mysql,tmpfs-size=268435456");
      args.push("--require_secure_transport=ON", "--ssl-key=/run/server.key", "--ssl-cert=/run/server.crt", "--ssl-ca=/run/ca.crt", "--innodb-buffer-pool-size=32M", "--innodb-redo-log-capacity=16M", "--performance-schema=OFF", "--max-connections=12");
    } else mounts.push("type=tmpfs,dst=/var/lib/postgresql/data,tmpfs-size=134217728");
    const container = await ownedContainer(ctx, cleanup, network, leg.image(ctx.input.env), `${kind}-${role}`, kind === "postgres" ? 5432 : 3306,
      kind === "postgres" ? { POSTGRES_PASSWORD: password } : { MYSQL_ROOT_PASSWORD: password, MYSQL_ROOT_HOST: "%" }, args, mounts, name);
    pair.push(container);
    await until(async () => serverSql(container, kind, "select 1;").then(() => true).catch(() => false), (ready: boolean) => ready);
    if (kind === "mysql") await serverSql(container, kind,
      "CREATE DATABASE tenant_a CHARACTER SET utf8mb4 COLLATE utf8mb4_bin; CREATE DATABASE tenant_b CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;");
  }
  const [source, target] = pair as [Container, Container];
  const endpoint = (c: Container): LegEndpoint => ({ url: `${kind}://127.0.0.1:${c.port}/${kind === "postgres" ? "postgres" : "mysql"}`, user, password,
    ...(kind === "mysql" ? { caFile: path.join(ctx.config.stackDirectory, "tls/ca.crt") } : {}) });
  // Stock images briefly run socket-only initialization servers. A socket query
  // allows provisioning but cannot establish readiness for host or worker TCP.
  for (const container of pair) await until(async () => {
    try {
      const host = endpoint(container);
      if (kind === "mysql") {
        // The real leg verifies the CA chain, IP identity and TLS before any SQL.
        return (await leg.readTarget({ runId: ctx.input.runId, ownerLabel: `DRV4-DATA:${ctx.input.runId}`,
          tenant: "a", source: host, target: host })).count === 0;
      }
      const sql = postgres(postgresEndpoint(host), { max: 1, ssl: false, prepare: false, connect_timeout: 5, onnotice: () => undefined });
      try { await sql`select 1`; return true; } finally { await sql.end({ timeout: 5 }); }
    } catch { return false; } // Initial listener refusal is retried within the bounded readiness deadline.
  }, (ready: boolean) => ready);
  return { source, target, sourceEndpoint: endpoint(source), targetEndpoint: endpoint(target), password, user };
}
async function platformFixtureSql(ctx: OperatedContext, sql: string): Promise<string> {
  const name = `supabase_db_${ctx.stack.state.projectId}`;
  const [db] = JSON.parse(await command("docker", ["inspect", name]));
  ensure(db.Config.Labels?.["com.supabase.cli.project"] === ctx.stack.state.projectId, "owned-platform-fixture-database");
  const options = { input: sql, timeout: 60_000 };
  return command("docker", ["exec", "-i", db.Id, "psql", "-XAt", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1"], options);
}
/** Explicit fixture catalog only: descriptors point at independently ready owned containers. No execution/approval/evidence tables are seeded. */
async function registerResources(ctx: OperatedContext, tenant: Tenant, kind: DataKind, source: Container, target: Container, store: Storage, cleanup: OwnedCleanup): Promise<Resources> {
  const resources = { source: "res_" + nonce(), target: "res_" + nonce(), storage: "res_" + nonce() };
  const letter = tenant.project.name.endsWith("data-a") ? "a" : "b";
  const ids = Object.values(resources);
  cleanup.add(async () => {
    await platformFixtureSql(ctx, `delete from platform.resources where workspace_id=${quote(tenant.workspaceId)} and environment_id=${quote(tenant.environmentId)} and id in (${ids.map(quote).join(",")}) and labels->>'fixture'='DRV4-DATA';`);
    ensure((await platformFixtureSql(ctx, `select count(*) from platform.resources where workspace_id=${quote(tenant.workspaceId)} and id in (${ids.map(quote).join(",")});`)).trim() === "0", "fixture-descriptor-cleanup");
  });
  for (const role of ["source", "target", "storage"] as const) {
    const resourceKind = role === "storage" ? "object_store" : kind;
    const container = role === "source" ? source : role === "target" ? target : store.container;
    const name = role === "storage" ? bucket("artifacts", letter, ctx.input.runId) : kind === "object_store" ? bucket("data", letter, ctx.input.runId) : `tenant_${letter}`;
    const spec = { name, localContainerId: container.id }, labels = { fixture: "DRV4-DATA", run: ctx.input.runId };
    // aws is LIFE-11's S3/SQL compatibility selector only. These descriptors do
    // not assert that a cloud resource was provisioned or observed on AWS.
    await platformFixtureSql(ctx, `insert into platform.resources (id,workspace_id,project_id,environment_id,address,kind,provider,native_type,ownership,external_id,spec_digest,spec,origin,labels,status)
      values (${quote(resources[role])},${quote(tenant.workspaceId)},${quote(tenant.project.id)},${quote(tenant.environmentId)},${quote(`${resourceKind}/${role}`)},${quote(resourceKind)},'aws',${quote(resourceKind === "object_store" ? "aws:s3_bucket" : "aws:rds_instance")},${quote(role === "storage" ? "referenced" : "managed")},${quote(name)},${quote(hash(JSON.stringify(spec)))},${quote(JSON.stringify(spec))}::jsonb,'[]'::jsonb,${quote(JSON.stringify(labels))}::jsonb,'active');`);
  }
  return resources;
}
async function secret(tenant: Tenant, key: string, value: string): Promise<string> {
  const ref = "vault:" + key;
  await action(tenant.owner, "system.setSecret", { projectId: tenant.project.id, serviceId: tenant.serviceId, key, secretRef: ref, secretValue: value });
  // Remove the temporary environment reference; values live exclusively in the vault.
  await action(tenant.owner, "project.updateManifest", { projectId: tenant.project.id, manifest: tenant.manifest });
  return ref;
}
async function view(tenant: Tenant): Promise<PortabilityView> {
  const data = ok(await browserRequest(tenant.owner, `/api/platform/v1/environments/${tenant.environmentId}/portability`, undefined, "GET", tenant.workspaceId));
  ensure(data.environmentId === tenant.environmentId && !data.truncated, "complete-portability-readback");
  return data as PortabilityView;
}
async function operation(ctx: OperatedContext, tenant: Tenant, resourceId: string, capability: "data.export" | "data.import", input: Record<string, unknown>, expected: "succeeded" | "failed" = "succeeded"): Promise<string> {
  const result = ok(await browserRequest(tenant.owner, "/api/platform/v1/capabilities/propose", { capability,
    scope: { workspaceId: tenant.workspaceId, projectId: tenant.project.id, environmentId: tenant.environmentId, resourceId }, input, idempotencyKey: nonce() }, "POST", tenant.workspaceId));
  ensure(result.operation?.status === "awaiting_approval", "data-human-gate");
  const id = result.operation.id;
  let startedAttempt = false, settled = false;
  ctx.quiescence.add(async () => {
    if (settled) return;
    try {
      if (!startedAttempt) {
        ok(await browserRequest(tenant.owner, `/api/platform/v1/operations/${id}/cancel`, { reason: "Owned local rehearsal cleanup" }, "POST", tenant.workspaceId));
        return;
      }
      // A lost/late workflow response must not leave a worker using fixtures while
      // they are torn down. This invocation owns the disposable J1 worker.
      const workers = JSON.parse(await command("docker", ["inspect", ctx.stack.worker]));
      ensure(workers.length === 1 && workers[0].Id === ctx.stack.worker
        && workers[0].Config.Labels?.["io.zenith.installation"] === ctx.stack.state.applicationInstallationId, "owned-worker-quiescence");
      if (workers[0].State.Running) await command("docker", ["stop", "--time", "15", ctx.stack.worker]);
      const stopped = JSON.parse(await command("docker", ["inspect", ctx.stack.worker]));
      ensure(stopped.length === 1 && stopped[0].Id === ctx.stack.worker && !stopped[0].State.Running, "worker-stopped-before-data-cleanup");
    } catch (error) {
      ctx.cleanupBlocked.block();
      throw error;
    }
  });
  await approveOperation(ctx, tenant, id);
  startedAttempt = true;
  const started = ok(await browserRequest(tenant.owner, `/api/platform/v1/operations/${id}/start-portability`, {}, "POST", tenant.workspaceId));
  ensure(started.operationId === id && started.startedNow === true && started.workflow?.id, "durable-data-workflow");
  const done = await until(() => detailOf(tenant, id), (d: { operation: { status: string } }) => terminal.includes(d.operation.status));
  settled = true;
  ensure(done.operation.status === expected, "data-operation-terminal");
  return id;
}

export async function operatedDataRoundtrips(ctx: OperatedContext): Promise<void> {
  const cleanup = new OwnedCleanup(ctx.cleanupBlocked); ctx.cleanup.add(async () => { ensure(await cleanup.settle(), "data-owned-cleanup"); });
  let network = "", stores!: [Storage, Storage], tenants!: [Tenant, Tenant];
  const images = pinnedFixtureImages(ctx.input.env);
  await ctx.step("data-preconditions", async () => {
    network = await configureWorker(ctx);
    tenants = [await createTenant(ctx, "data-a"), await createTenant(ctx, "data-b")];
    for (const tenant of tenants) { await connectKind(ctx, tenant); await deployKind(ctx, tenant); }
    stores = [await storage(ctx, cleanup, network, images.object_store, "source"), await storage(ctx, cleanup, network, images.object_store, "target")];
    for (const letter of ["a", "b"] as const) await stores[0].client.send(new CreateBucketCommand({ Bucket: bucket("artifacts", letter, ctx.input.runId) }));
  });
  const legs: DataLeg[] = [postgresLeg, mysqlLeg, objectStoreLeg];
  ensure(JSON.stringify(legs.map(l => l.kind)) === JSON.stringify(DATA_KINDS), "complete-data-leg-inventory");
  for (const leg of legs) await ctx.step(`${leg.kind.replace("_", "-")}-data-roundtrip`, async () => {
    const kind = leg.kind;
    const engines = new OwnedCleanup(ctx.cleanupBlocked); cleanup.add(async () => { ensure(await engines.settle(), "database-pair-cleanup"); });
    const pair = kind === "object_store" ? undefined : await databasePair(ctx, engines, network, leg);
    const source = pair?.source ?? stores[0].container, target = pair?.target ?? stores[1].container;
    const objectEndpoint = (store: Storage): LegEndpoint => ({ url: `http://127.0.0.1:${store.container.port}`, user: store.accessKey, password: store.password, bucket: bucket("data", "a", ctx.input.runId) });
    const legContext: LegContext = { runId: ctx.input.runId, tenant: "a", ownerLabel: `DRV4-DATA:${ctx.input.runId}`,
      source: pair?.sourceEndpoint ?? objectEndpoint(stores[0]), target: pair?.targetEndpoint ?? objectEndpoint(stores[1]) };
    engines.add(() => leg.cleanup(legContext)); // before seed, even partially failed setup gets settled
    if (kind === "object_store") for (const letter of ["a", "b"] as const) {
      const Bucket = bucket("data", letter, ctx.input.runId);
      await stores[1].client.send(new CreateBucketCommand({ Bucket }));
      await stores[1].client.send(new PutBucketTaggingCommand({ Bucket, Tagging: { TagSet: [{ Key: "zenith-owner", Value: legContext.ownerLabel }] } }));
    }
    const before = await leg.seedSource(legContext);
    const expected = (letter: "a" | "b") => kind === "object_store" ? objectWitness(knownData(ctx.input.runId, letter).objects) : rowWitness(knownData(ctx.input.runId, letter).rows);
    assertEqualContent(expected("a"), before);
    const read = (role: "source" | "target", letter: "a" | "b") => leg.readTarget({ ...legContext, tenant: letter,
      target: { ...(role === "source" ? legContext.source : legContext.target), ...(kind === "object_store" ? { bucket: bucket("data", letter, ctx.input.runId) } : {}) } });
    const foreign = await read("source", "b"); assertEqualContent(expected("b"), foreign);
    ensure((await read("target", "a")).count === 0 && (await read("target", "b")).count === 0, "fresh-empty-data-targets");
    const registrations: Resources[] = [];
    for (const tenant of tenants) registrations.push(await registerResources(ctx, tenant, kind, source, target, stores[0], engines));
    const storageRef = async (tenant: Tenant, store: Storage, name: string, key: string) => secret(tenant, key, JSON.stringify({ region: "us-east-1", bucket: name,
      endpoint: `http://${store.container.name}:9000`, accessKeyId: store.accessKey, secretAccessKey: store.password }));
    const connections: { source: string; target: string; destination: { resourceAddress: string; credentialsRef: string } }[] = [];
    for (const [i, tenant] of tenants.entries()) {
      const letter = i === 0 ? "a" : "b";
      const credentialsRef = await storageRef(tenant, stores[0], bucket("artifacts", letter, ctx.input.runId), `DRV4_${kind}_ARTIFACTS`);
      const ref = async (role: "source" | "target") => {
        if (!pair) return storageRef(tenant, stores[role === "source" ? 0 : 1], bucket("data", letter, ctx.input.runId), `DRV4_OBJECT_${role}`);
        const container = role === "source" ? source : target;
        // DNS selects LIFE-11's existing mysql2 transport with verified chain
        // and original hostname. It does not require an uninstalled stock CLI.
        return secret(tenant, `DRV4_${kind}_${role}`, `${kind}://${pair.user}:${pair.password}@${container.name}:${kind === "postgres" ? 5432 : 3306}/tenant_${letter}${kind === "postgres" ? "?sslmode=disable" : ""}`);
      };
      connections.push({ source: await ref("source"), target: await ref("target"), destination: { resourceAddress: "object_store/storage", credentialsRef } });
    }
    const [a, b] = tenants, [ra, rb] = registrations, [ca, cb] = connections;
    if (kind === "mysql") {
      const wrong = await secret(a, "DRV4_WRONG_TLS", `mysql://${pair!.user}:${pair!.password}@${source.name}-wrong:3306/tenant_a`);
      const failed = await operation(ctx, a, ra.source, "data.export", { destination: ca.destination, connectionRef: wrong }, "failed");
      ensure(!(await view(a)).exports.some(e => e.operationId === failed), "wrong-tls-no-export");
      assertEqualContent(before, await read("source", "a"));
    }
    const exportOp = await operation(ctx, a, ra.source, "data.export", { destination: ca.destination, connectionRef: ca.source });
    const records = (await view(a)).exports.filter(e => e.operationId === exportOp);
    ensure(records.length === 1 && records[0].workspaceId === a.workspaceId && records[0].environmentId === a.environmentId && records[0].resourceId === ra.source, "data-export-record-binding");
    const exported = records[0];
    const importOp = await operation(ctx, a, ra.target, "data.import", { exportId: exported.id, destination: ca.destination, connectionRef: ca.target, readbackConnectionRef: ca.target });
    const restored = (await view(a)).restores.filter(r => r.operationId === importOp);
    ensure(restored.length === 1 && restored[0].status === "verified" && restored[0].exportId === exported.id && restored[0].targetResourceId === ra.target
      && restored[0].expectedContentDigest === exported.contentDigest && restored[0].observedContentDigest === exported.contentDigest, "data-restore-record-binding");
    const observed = await leg.readTarget(legContext); assertEqualContent(before, observed); await leg.assertNoForeignTenant(legContext);
    await operation(ctx, a, ra.target, "data.import", { exportId: exported.id, destination: ca.destination, connectionRef: ca.target }, "failed");
    const foreignOp = await operation(ctx, b, rb.target, "data.import", { exportId: exported.id, destination: cb.destination, connectionRef: cb.target }, "failed");
    ensure(!(await view(b)).restores.some(r => r.operationId === foreignOp) && !(await view(b)).exports.some(e => e.id === exported.id), "foreign-export-not-visible");
    ensure((await read("target", "b")).count === 0, "foreign-target-unchanged");
    assertHttpRefusal(await browserRequest(b.owner, `/api/platform/v1/environments/${a.environmentId}/portability`, undefined, "GET", b.workspaceId));
    assertHttpRefusal(await browserRequest(a.owner, "/api/platform/v1/capabilities/propose", { capability: "data.export", scope: { workspaceId: a.workspaceId, environmentId: a.environmentId, resourceId: rb.source }, input: { destination: ca.destination, connectionRef: ca.source }, idempotencyKey: nonce() }, "POST", a.workspaceId));
    assertEqualContent(before, await read("source", "a")); assertEqualContent(observed, await read("target", "a")); assertEqualContent(foreign, await read("source", "b"));
    await leg.assertNoForeignTenant(legContext);
    ctx.dataRoundtrips[kind] = DataProofSchema.parse({ source: before, target: observed, otherTenant: foreign, exportedContentDigest: exported.contentDigest,
      restoredContentDigest: restored[0].observedContentDigest, tenantIsolation: true, mysqlTls: kind === "mysql" ? "verified_identity" : "not_applicable" });
    ensure(await engines.settle(), "data-engine-pair-cleanup");
  });
  await ctx.step("data-tenant-scoping", async () => {
    ensure(DATA_KINDS.every(kind => ctx.dataRoundtrips[kind]?.tenantIsolation), "all-data-tenant-isolation");
    ensure(await cleanup.settle(), "all-data-fixture-cleanup");
  });
}
