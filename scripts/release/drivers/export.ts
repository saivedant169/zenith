/** J15 operated infrastructure export, re-applied without Zenith to owned LocalStack. */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { load as loadYaml } from "js-yaml";
import { browserRequest, ok, action, nonce, until, command, ensure, sha256, privateFile, NATIVE } from "../../../tests/e2e/default/support.mjs";
import { runOperated, createTenant, runDriverCli, type DriverInput, type OperatedContext, type Tenant } from "./operated";
import { operatedDataRoundtrips } from "./export-data";

const Bundle = z.object({
  provider: z.literal("localstack"), readme: z.string().min(1),
  source: z.object({ kind: z.literal("revision"), revisionId: z.string().min(1), number: z.number().int().positive() }).strict(),
  files: z.array(z.object({ path: z.string().regex(/^[a-z][a-z0-9_.-]{0,80}$/), content: z.string().max(512 * 1024) }).strict()).min(1).max(20),
}).strict();
export type ExportedBundle = z.infer<typeof Bundle>;
const FILES = new Set(["providers_override.tf", "providers.tf", "backend.tf", "variables.tf", "network.tf", "s3.tf", "outputs.tf", "terraform.tfvars.example"]);
export function validateExportBundle(raw: unknown, revisionId: string, forbidden: readonly string[]): ExportedBundle {
  const bundle = Bundle.parse(raw);
  ensure(bundle.source.revisionId === revisionId, "export-revision-binding");
  ensure(new Set(bundle.files.map(file => file.path)).size === bundle.files.length && bundle.files.every(file => FILES.has(file.path)), "export-file-inventory");
  for (const required of ["providers_override.tf", "providers.tf", "variables.tf", "s3.tf"]) ensure(bundle.files.some(file => file.path === required), "export-missing-file");
  const surfaces = [bundle.readme, ...bundle.files.map(file => file.content)];
  ensure(forbidden.every(secret => secret.length >= 8 && surfaces.every(surface => !surface.includes(secret))), "export-secret-absence");
  const hcl = bundle.files.filter(file => file.path.endsWith(".tf")).map(file => file.content.split(/\r?\n/).filter(line => !line.trim().startsWith("#")).join("\n")).join("\n");
  ensure(!/\b(?:provisioner|module|backend)\s+"/.test(hcl) && !/\b(?:provider|data)\s+"(?:external|http)"|\b(?:local-exec|remote-exec)\b/.test(hcl), "portable-unexpected-execution");
  ensure(!/\balias\s*=/.test(hcl) && [...hcl.matchAll(/\bprovider\s+"([^"]+)"/g)].every(match => ["aws", "random"].includes(match[1])), "portable-provider-scope");
  const types = [...hcl.matchAll(/\b(?:resource|data)\s+"([^"]+)"/g)].map(match => match[1]);
  ensure(types.includes("aws_s3_bucket") && types.every(type => ["aws_caller_identity", "aws_vpc", "aws_subnets", "aws_security_group", "random_id", "aws_s3_bucket", "aws_s3_bucket_public_access_block", "aws_s3_bucket_server_side_encryption_configuration", "aws_s3_bucket_versioning"].includes(type)), "portable-resource-scope");
  const overrides = bundle.files.find(file => file.path === "providers_override.tf")!.content;
  const endpoints = [...overrides.matchAll(/\b[a-z0-9_]+\s*=\s*"(https?:\/\/[^"\s]+)"/g)].map(match => match[1]);
  ensure(endpoints.length >= 2 && endpoints.every(endpoint => endpoint === "http://localhost:4566"), "portable-endpoints-local");
  ensure(["s3", "sts", "ec2"].every(service => new RegExp(`\\b${service}\\s*=\\s*"http://localhost:4566"`).test(overrides))
    && /skip_credentials_validation\s*=\s*true/.test(overrides) && /skip_metadata_api_check\s*=\s*true/.test(overrides), "portable-no-cloud-fallback");
  return bundle;
}
export function validatePortablePlan(raw: unknown): void {
  const plan = z.object({ resource_changes: z.array(z.object({ mode: z.enum(["managed", "data"]), type: z.string(),
    change: z.object({ actions: z.array(z.string()) }).passthrough() }).passthrough()).min(1) }).passthrough().parse(raw);
  ensure(plan.resource_changes.some(change => change.type === "aws_s3_bucket" && change.change.actions.join() === "create"), "portable-bucket-create-required");
  for (const change of plan.resource_changes) {
    ensure((change.mode === "data" && ["aws_caller_identity", "aws_vpc", "aws_subnets"].includes(change.type) && change.change.actions.every(action => ["read", "no-op"].includes(action)))
      || (change.mode === "managed" && ["random_id", "aws_security_group", "aws_s3_bucket", "aws_s3_bucket_public_access_block", "aws_s3_bucket_server_side_encryption_configuration", "aws_s3_bucket_versioning"].includes(change.type)
        && change.change.actions.join() === "create"), "portable-plan-effects");
  }
}
async function deployLegacy(ctx: OperatedContext, tenant: Tenant): Promise<{ deploymentId: string; revisionId: string }> {
  const scope = { projectId: tenant.project.id, environmentId: tenant.environmentId };
  const proposed = await action(tenant.owner, "deploy.apply", {}, scope);
  ensure(proposed.status === "awaiting_approval" && !proposed.operationId, "localstack-human-approval-required");
  await tenant.approver.goto(ctx.stack.apiUrl + "/p/" + tenant.project.slug + "/deploys?env=" + tenant.environmentId + "&deployment=" + proposed.deploymentId);
  await tenant.approver.getByRole("button", { name: "Approve and apply", exact: true }).click();
  const response = tenant.approver.waitForResponse(value => value.url().endsWith("/api/actions/deploy.approve")
    && value.request().method() === "POST" && value.request().postDataJSON()?.mode === "execute");
  // If the click below fails, this wait rejects only when the browser closes; never let that crash the driver.
  response.catch(() => undefined);
  await tenant.approver.getByRole("button", { name: "Apply anyway", exact: true }).click();
  const approved = await response;
  ensure(approved.ok() && (await approved.json()).result?.ok === true, "localstack-browser-approval");
  const terminal = await until(async () => ok(await browserRequest(tenant.owner, "/api/deployments/" + proposed.deploymentId)),
    (data: { deployment: { status: string } }) => ["succeeded", "failed", "cancelled", "rolled_back"].includes(data.deployment.status));
  ensure(terminal.deployment.status === "succeeded" && terminal.deployment.executor !== "workflow", "localstack-terminal-success");
  return { deploymentId: proposed.deploymentId, revisionId: proposed.revisionId };
}

async function localstack(ctx: OperatedContext): Promise<{ id: string; aws(args: string[]): Promise<string> }> {
  const compose = readFileSync("deploy/acceptance/local-targets/compose.yml", "utf8");
  const image = /^\s+image: (localstack\/localstack:[^\s]+@sha256:[a-f0-9]{64})$/m.exec(compose)?.[1];
  ensure(image, "pinned-localstack-image");
  const inspected = JSON.parse(await command("docker", ["image", "inspect", image]));
  ensure(inspected.length === 1 && inspected[0].Architecture === NATIVE?.image, "native-localstack-image");
  const api = JSON.parse(await command("docker", ["inspect", ctx.stack.api]));
  const endpoint = api[0].Config.Env.find((entry: string) => entry.startsWith("ZENITH_LOCALSTACK_ENDPOINT="));
  ensure(!endpoint || endpoint === "ZENITH_LOCALSTACK_ENDPOINT=http://localhost:4566", "api-localstack-endpoint");
  // Share only J1 API's network namespace: its existing loopback adapter cannot reach any other cloud.
  // This instance owns a new empty in-memory account, no Docker socket or persistence mount.
  const label = "io.zenith.drv4=" + nonce(), name = "zenith-drv4-" + nonce();
  ensure(!(await command("docker", ["ps", "-aq", "--filter", "name=^/" + name + "$"])), "localstack-name-collision");
  ctx.cleanup.add(async () => {
    const ids = (await command("docker", ["ps", "-aq", "--filter", "label=" + label])).split(/\s+/).filter(Boolean);
    for (const id of ids) {
      const [current] = JSON.parse(await command("docker", ["inspect", id]));
      ensure(current.Config.Labels?.["io.zenith.drv4"] === label.split("=")[1] && current.Name === "/" + name, "localstack-cleanup-ownership");
      await command("docker", ["rm", "-f", current.Id]);
    }
    ensure(!(await command("docker", ["ps", "-aq", "--filter", "label=" + label])), "localstack-cleanup-absence");
  });
  const id = await command("docker", ["run", "-d", "--pull", "never", "--name", name, "--label", label, "--memory", "512m", "--cpus", "0.5",
    "--network", "container:" + ctx.stack.api, "-e", "SERVICES=s3,sts,ec2", "-e", "DEBUG=0", image]);
  ensure(/^[a-f0-9]{64}$/.test(id), "localstack-id");
  const aws = (args: string[]) => command("docker", ["exec", id, "awslocal", ...args]);
  await until(async () => {
    try { return JSON.parse(await aws(["s3api", "list-buckets"])); } catch { return null; }
  }, (value: { Buckets?: unknown[] } | null) => Array.isArray(value?.Buckets));
  ensure(JSON.parse(await aws(["s3api", "list-buckets"])).Buckets.length === 0, "fresh-localstack-account");
  return { id, aws };
}

export async function runExport(input: DriverInput): Promise<number> {
  if (input.env.ZENITH_LOCAL_EXPORT_DATA !== "1") return 2;
  ensure(input.scenarioId === "export", "scenario-binding");
  return runOperated(input, async ctx => {
    // Settle data engines before starting the independent infrastructure leg,
    // keeping the peak fixture footprint bounded on the lean verifier.
    await operatedDataRoundtrips(ctx);
    const target = await localstack(ctx);
    let tenant!: Tenant, deployed!: { deploymentId: string; revisionId: string }, bucket = "";
    const resourceName = "drv4-assets-" + input.runId;
    const manifest = { version: 1, services: [], resources: [{ id: "export-assets", name: resourceName, kind: "object_store", config: {}, size: "small", ownership: "managed" }], routes: [], bindings: [] };
    await ctx.step("browser-approved-deployment", async () => {
      tenant = await createTenant(ctx, "export");
      await action(tenant.owner, "project.updateManifest", { projectId: tenant.project.id, manifest });
      tenant.connectionId = (await action(tenant.owner, "connection.create", { provider: "localstack", label: tenant.project.name, region: "us-east-1" })).connectionId;
      tenant.environmentId = (await action(tenant.owner, "env.create", { projectId: tenant.project.id, name: "production", class: "production", connectionId: tenant.connectionId, approvalRequired: true })).environmentId;
      deployed = await deployLegacy(ctx, tenant);
      bucket = `${resourceName}-${tenant.environmentId}`.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 60);
    });
    await ctx.step("provider-readback", async () => {
      const buckets = JSON.parse(await target.aws(["s3api", "list-buckets"]));
      ensure(buckets.Buckets.length === 1 && buckets.Buckets[0].Name === bucket, "actual-source-bucket");
      ctx.readbacks.source = sha256(buckets.Buckets.map((value: { Name: string }) => value.Name));
    });
    let bundle!: ExportedBundle;
    const credentialText = privateFile(ctx.config.kind.kubeconfigFile);
    const kube = z.object({ users: z.array(z.object({ user: z.object({ token: z.string().min(8) }) })).min(1) }).parse(loadYaml(credentialText));
    const credentials = [ctx.stack.adminKey, credentialText, ...kube.users.map(user => user.user.token)];
    await ctx.step("revision-export", async () => {
      bundle = validateExportBundle(ok(await browserRequest(tenant.owner, "/api/environments/" + tenant.environmentId + "/export")), deployed.revisionId, credentials);
    });
    await ctx.step("working-copy-divergence", async () => {
      const changed = { ...manifest, resources: [{ ...manifest.resources[0], name: "different-" + input.runId }] };
      await action(tenant.owner, "project.updateManifest", { projectId: tenant.project.id, manifest: changed });
      const current = validateExportBundle(ok(await browserRequest(tenant.owner, "/api/environments/" + tenant.environmentId + "/export")), deployed.revisionId, credentials);
      ensure(JSON.stringify(current) === JSON.stringify(bundle), "export-must-use-deployed-revision");
    });
    const directory = path.join(ctx.scratch, "bundle");
    await ctx.step("export-file-readback", async () => {
      mkdirSync(directory, { mode: 0o700 });
      for (const file of bundle.files) writeFileSync(path.join(directory, file.path), file.content, { mode: 0o600, flag: "wx" });
      writeFileSync(path.join(directory, "README.md"), bundle.readme, { mode: 0o600, flag: "wx" });
      const readback = bundle.files.map(file => ({ path: file.path, content: readFileSync(path.join(directory, file.path), "utf8") }));
      ensure(JSON.stringify(readback) === JSON.stringify(bundle.files), "independent-file-bytes");
      ctx.readbacks.bundle = sha256(readback);
    });
    await ctx.step("credential-absence", async () => {
      validateExportBundle(bundle, deployed.revisionId, credentials);
      // Actual browser access tokens and product vault values must not leave with the export.
      const cookies = await tenant.owner.context().cookies();
      ensure(cookies.filter(cookie => cookie.value.length >= 16).every(cookie => !JSON.stringify(bundle).includes(cookie.value)), "export-cookie-absence");
    });
    await ctx.step("browser-approved-teardown", async () => {
      await action(tenant.owner, "project.updateManifest", { projectId: tenant.project.id, manifest: { version: 1, services: [], resources: [], routes: [], bindings: [] } });
      // Only this driver's owned, independently confirmed empty bucket is eligible for deletion.
      await action(tenant.owner, "env.updatePolicies", { environmentId: tenant.environmentId, allowStatefulDeletion: true });
      await deployLegacy(ctx, tenant);
      ensure(JSON.parse(await target.aws(["s3api", "list-buckets"])).Buckets.length === 0, "source-teardown-readback");
    });
    const worker = JSON.parse(await command("docker", ["inspect", ctx.stack.worker]));
    const workerImage: string = worker[0].Config.Image;
    ensure(/@sha256:[a-f0-9]{64}$/.test(workerImage) && JSON.parse(await command("docker", ["image", "inspect", workerImage]))[0].Architecture === NATIVE?.image, "native-pinned-tofu-runner");
    const label = "io.zenith.drv4-tofu=" + nonce(), prefix = "drv4-portable-" + nonce();
    ctx.cleanup.add(async () => {
      const ids = (await command("docker", ["ps", "-aq", "--filter", "label=" + label])).split(/\s+/).filter(Boolean);
      for (const id of ids) {
        const [current] = JSON.parse(await command("docker", ["inspect", id]));
        ensure(current.Config.Labels?.["io.zenith.drv4-tofu"] === label.split("=")[1], "tofu-cleanup-ownership");
        await command("docker", ["rm", "-f", current.Id]);
      }
      ensure(!(await command("docker", ["ps", "-aq", "--filter", "label=" + label])), "tofu-cleanup-absence");
    });
    const tofu = (args: string[]) => command("docker", ["run", "--rm", "--pull", "never", "--label", label, "--network", "container:" + ctx.stack.api,
      "--memory", "512m", "--cpus", "0.5", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--read-only",
      "--tmpfs", "/tmp:rw,nosuid,size=128m", "--user", String(process.getuid!()) + ":" + String(process.getgid!()),
      "--mount", `type=bind,source=${directory},target=/bundle`, "--workdir", "/bundle", "-e", "HOME=/tmp", "-e", "AWS_EC2_METADATA_DISABLED=true",
      "-e", "TF_IN_AUTOMATION=1", "-e", "TF_VAR_name_prefix=" + prefix, "--entrypoint", "/usr/local/bin/tofu", workerImage, ...args], { timeout: 240_000 });
    await ctx.step("portable-plan", async () => {
      ensure(JSON.parse(await tofu(["version", "-json"])).terraform_version === "1.12.5", "pinned-tofu-version");
      await tofu(["init", "-backend=false", "-input=false", "-no-color"]);
      await tofu(["validate", "-no-color"]);
      await tofu(["plan", "-input=false", "-no-color", "-out=portable.plan"]);
      const plan = JSON.parse(await tofu(["show", "-json", "portable.plan"])); validatePortablePlan(plan);
      ctx.readbacks["portable-plan"] = sha256(plan);
    });
    // Register destruction BEFORE dispatch; applies that time out are still cleaned.
    ctx.cleanup.add(async () => {
      await tofu(["destroy", "-auto-approve", "-input=false", "-no-color"]);
      ensure(JSON.parse(await target.aws(["s3api", "list-buckets"])).Buckets.length === 0, "portable-destroy-readback");
    });
    await ctx.step("portable-apply-readback", async () => {
      await tofu(["apply", "-input=false", "-no-color", "portable.plan"]);
      const buckets = JSON.parse(await target.aws(["s3api", "list-buckets"]));
      ensure(buckets.Buckets.length === 1 && buckets.Buckets[0].Name.startsWith(prefix + "-" + resourceName + "-") && buckets.Buckets[0].Name !== bucket, "portable-bucket-readback");
      const name = buckets.Buckets[0].Name;
      ensure(JSON.parse(await target.aws(["s3api", "get-bucket-versioning", "--bucket", name])).Status === "Enabled", "portable-versioning-readback");
      const encrypted = JSON.parse(await target.aws(["s3api", "get-bucket-encryption", "--bucket", name]));
      ensure(encrypted.ServerSideEncryptionConfiguration?.Rules?.some((rule: { ApplyServerSideEncryptionByDefault?: { SSEAlgorithm?: string } }) => rule.ApplyServerSideEncryptionByDefault?.SSEAlgorithm === "AES256"), "portable-encryption-readback");
      const blocked = JSON.parse(await target.aws(["s3api", "get-public-access-block", "--bucket", name])).PublicAccessBlockConfiguration;
      ensure(["BlockPublicAcls", "BlockPublicPolicy", "IgnorePublicAcls", "RestrictPublicBuckets"].every(key => blocked[key] === true), "portable-private-bucket-readback");
      const groups = JSON.parse(await target.aws(["ec2", "describe-security-groups", "--filters", `Name=group-name,Values=${prefix}-service`]));
      ensure(groups.SecurityGroups.length === 1 && groups.SecurityGroups[0].GroupName === prefix + "-service", "portable-network-scaffold-readback");
      ctx.readbacks.portable = sha256({ name, encrypted, blocked, groups });
      ensure(sha256(bundle.files.map(file => ({ path: file.path, content: readFileSync(path.join(directory, file.path), "utf8") }))) === ctx.readbacks.bundle, "export-bytes-unchanged-after-apply");
    });
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void runDriverCli("export", runExport).then(code => { process.exitCode = code; });
