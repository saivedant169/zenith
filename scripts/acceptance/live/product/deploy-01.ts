/**
 * ProductScenarioPort for DEPLOY-01 (live sandbox): one AWS environment, one public container image on ECS Fargate behind
 * an ALB, deployed, updated and rolled back through the product's browser path, with an independent readback.
 *
 * Zenith does the product work (connection.createAws/verifyAws, env.create, project.updateManifest, deploy.apply,
 * deploy.rollback and every human approval). This port only (a) points the sandbox roles' trust at the run's ExternalId
 * through planned IAM calls and restores it, (b) reads the environment's recorded OpenTofu state as the connection's deploy
 * role (planned STS call) and probes the load balancer over HTTP, and (c) cleans up. The product refuses teardown after a
 * deploy (docs/LIMITATIONS.md), so cleanup destroys exactly the recorded state (state-destroy.ts) and re-lists by tag.
 */
import { randomBytes } from "node:crypto";
import http from "node:http";
import path from "node:path";
import type { EnvLike } from "../../config";
import type { Call, Json, ProductScenarioPort } from "../contracts";
import { laneSuffix, liveRoleNames } from "../plan";
import type { Deploy01Product } from "./deploy-01-driver";
import { fill, parsePolicy, refuse, Refusal, templateExternalId, trustDocument } from "./mix-03";
import { destroyFromState, readState, stateAttribute, type SessionCredentials, type StateDestroyInput } from "./state-destroy";
import { scanForCanary, type CanaryScan } from "./canary-scan";
import { runnerOps02Stack, type Ops02Stack } from "./ops-02-stack";

type Invoke = (call: Call, values?: Record<string, string>, extra?: Record<string, Json>) => Promise<Record<string, unknown>>;
// The product deploys only digest-pinned images (release-safety.ts). Multi-arch index digests of ECR Public nginx 1.27 and 1.26.
export const DEPLOY01_IMAGES = {
  v1: "public.ecr.aws/nginx/nginx@sha256:df80ece7fa07f8ed4f3b70e883fe322732954d0287e562f1fdc790018f7d2c66",
  v2: "public.ecr.aws/nginx/nginx@sha256:4aad0a9f6622a58402a3d37d7a92d67903ffae86498f6bac79155ec3760f8500",
} as const;
const EXTERNAL_ID_NEW = /^zenith-[0-9a-f]{32}$/;
const ALB_DNS = /^[a-z0-9-]{1,64}\.[a-z0-9-]+\.elb\.amazonaws\.com$/;

export function deploy01Manifest(image: string, host: string): Record<string, unknown> {
  return {
    version: 2,
    services: [{ id: "web", name: "web", kind: "web", source: { type: "image", image }, size: "nano", replicas: 1, port: 80, healthPath: "/" }],
    routes: [{ id: "route-web", host, tls: false, managedDns: false }],
    bindings: [{ id: "route-to-web", from: "route-web", to: "web", capability: "http" }],
  };
}

export interface Deploy01Seams {
  product?: Deploy01Product;
  sleep?: (ms: number) => Promise<void>;
  propagation?: { attempts: number; intervalMs: number };
  /** HTTP probe of the load balancer with the route's Host header; resolves the status code. */
  probe?: (dnsName: string, host: string) => Promise<number>;
  state?: { read: (input: StateDestroyInput) => Promise<unknown>; destroy: (input: StateDestroyInput) => Promise<{ destroyed: number; destroyedArns?: string[]; destroyedIds?: string[] }> };
  /** OPS-06: the canary value (default: random) and the runner persistence scan (default: canary-scan.ts over the env roots). */
  canary?: () => string;
  scan?: (canary: string) => Promise<CanaryScan>;
  /** OPS-02: the runner stack with Prometheus on its metrics (default: ops-02-stack.ts). */
  ops02?: Ops02Stack;
}
/** OPS-02 burst sizes: the flooding tenant exceeds its API burst (200) and concurrency (16); the quiet one stays far below. */
export const OPS02_FLOOD = { count: 600, concurrency: 40 }, OPS02_QUIET = { count: 20, concurrency: 2 };
/** The OPS-06 service env key that reads the canary from Zenith's secret store. */
export const OPS06_SECRET_KEY = "ZENITH_OPS06_CANARY";
/** The recorded task definition reads the key from a Zenith Secrets Manager secret and holds no plaintext copy. */
export function ops06DefinitionReadsSecret(definitions: unknown, canary: string, account: string, region: string): boolean {
  if (typeof definitions !== "string" || definitions.includes(canary)) return false;
  let parsed: unknown;
  try { parsed = JSON.parse(definitions); } catch { return false; }
  const arn = new RegExp(`^arn:aws:secretsmanager:${region}:${account}:secret:zenith/[A-Za-z0-9/_+=.@-]+$`);
  return Array.isArray(parsed) && parsed.some(c => Array.isArray(field(c, "secrets")) && (field(c, "secrets") as unknown[]).some(s => field(s, "name") === OPS06_SECRET_KEY && typeof field(s, "valueFrom") === "string" && arn.test(field(s, "valueFrom") as string))
    && !((field(c, "environment") as unknown[] | undefined) ?? []).some(e => field(e, "name") === OPS06_SECRET_KEY));
}

const field = (value: unknown, key: string): unknown => value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
const defaultProbe = (dnsName: string, host: string) => new Promise<number>(resolve => {
  const req = http.request({ host: dnsName, port: 80, path: "/", method: "GET", headers: { Host: host }, timeout: 10_000 }, res => { res.resume(); resolve(res.statusCode ?? 0); });
  req.on("timeout", () => { req.destroy(); resolve(0); });
  req.on("error", () => resolve(0));
  req.end();
});

export function deploy01Port(env: EnvLike = process.env, seams: Deploy01Seams = {}): ProductScenarioPort {
  const product = seams.product ?? refuse("the DEPLOY-01 browser driver is not wired");
  const sleep = seams.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const propagation = seams.propagation ?? { attempts: 12, intervalMs: 15_000 };
  const probe = seams.probe ?? defaultProbe;
  const state = seams.state ?? { read: readState, destroy: destroyFromState };
  const canaryOf = seams.canary ?? (() => `zops06${randomBytes(16).toString("hex")}`);
  // Docker's data root, the runner temp (stack data, this harness's output) and the checkout.
  const roots = ["/var/lib/docker", env.RUNNER_TEMP, env.GITHUB_WORKSPACE].filter((r): r is string => !!r);
  const scan = seams.scan ?? ((canary: string) => scanForCanary(canary, { roots, controlDir: path.join(env.RUNNER_TEMP ?? "/nonexistent", "zenith-ops06-control") }));
  return {
    async verify(requirement, { plan, call }) {
      const ops06 = plan.settings.scenario === "ops-06", ops02 = plan.settings.scenario === "ops-02";
      if (requirement.id !== (ops06 ? "PROD-OPS-06" : ops02 ? "PROD-OPS-02" : "PROD-REL-01")) return { complete: false, reason: `${requirement.id}: not implemented by this port` };
      const label = ops06 ? "OPS-06" : ops02 ? "OPS-02" : "DEPLOY-01";
      let observed: Ops02Stack | undefined;
      const invoke: Invoke = (c, values = {}, extra = {}) => call(c, { ...fill(c.input, values), ...extra });
      const planned = (id: string): Call => plan.productCalls?.find(c => c.id === id) ?? refuse(`the plan has no call ${id}`);
      const account = plan.settings.accountId, region = plan.settings.region, runId = plan.settings.runId;
      // The lane's connection stack (NameSuffix "-live" or "-live2"): its roles, boundaries and state bucket all carry the suffix.
      const bootstrapNameSuffix = laneSuffix(plan.settings), names = liveRoleNames(bootstrapNameSuffix);
      const stateBucket = `zenith-state-${account}-${region}${bootstrapNameSuffix}`;
      const principal = `arn:aws:iam::${account}:role/${names.principal}`;
      const roleArns = { observe: `arn:aws:iam::${account}:role/${names.observe}`, deploy: `arn:aws:iam::${account}:role/${names.deploy}`, writer: `arn:aws:iam::${account}:role/${names.writer}` };
      const host = `web-${runId.slice(-8).toLowerCase()}.example.com`;
      const tofu = env.ZENITH_TOFU_BIN?.trim() || "tofu";
      const trust: { role: "observe" | "deploy" | "writer"; original: string; write: Call }[] = [];
      let externalId: string | undefined, workspaceId: string | undefined, environmentId: string | undefined;
      const session = async (): Promise<SessionCredentials> => {
        const out = await invoke(planned("deploy01-sts-assume"), { externalId: externalId! });
        const c = field(out, "Credentials");
        const id = field(c, "AccessKeyId"), secret = field(c, "SecretAccessKey"), token = field(c, "SessionToken");
        if (typeof id !== "string" || typeof secret !== "string" || typeof token !== "string") refuse("the deploy role session could not be read");
        return { accessKeyId: id as string, secretAccessKey: secret as string, sessionToken: token as string };
      };
      const stateInput = async (): Promise<StateDestroyInput> => ({
        tofu, region, backend: { kind: "s3", bucket: stateBucket, region }, stateKey: `zenith/${workspaceId}/${environmentId}/terraform.tfstate`, credentials: await session(),
      });
      const readback = async (image: string) => {
        const recorded = await state.read(await stateInput());
        const definitions = stateAttribute(recorded, "aws_ecs_task_definition", "container_definitions");
        if (typeof definitions !== "string" || !definitions.includes(`"${image}"`)) refuse(`the recorded task definition does not run ${image}`);
        const dns = stateAttribute(recorded, "aws_lb", "dns_name");
        if (typeof dns !== "string" || !ALB_DNS.test(dns)) refuse("the recorded load balancer has no AWS DNS name");
        for (let attempt = 1; ; attempt++) {
          if ((await probe(dns as string, host)) === 200) return dns as string;
          if (attempt >= 40) refuse("the load balancer did not serve HTTP 200 for the route host within 10 minutes");
          await sleep(15_000);
        }
      };
      let step = "preconditions";
      let outcome: { complete: boolean; reason: string };
      /** OPS-02: tenant fairness with real metrics, then a workload that keeps serving through a control-plane outage. */
      const ops02Flow = async (tenant: Parameters<Deploy01Product["setManifest"]>[0], environmentId: string): Promise<{ complete: boolean; reason: string }> => {
        step = "observability";
        const stack = observed = seams.ops02 ?? runnerOps02Stack(env, runId);
        await stack.observe();
        step = "second tenant";
        const quietTenant = await product.createTenant();
        step = "tenant fairness";
        const [flood, quiet] = await Promise.all([product.burst!(tenant, OPS02_FLOOD.count, OPS02_FLOOD.concurrency),
          sleep(500).then(() => product.burst!(quietTenant, OPS02_QUIET.count, OPS02_QUIET.concurrency))]);
        const codes = (statuses: Record<string, number>) => Object.entries(statuses).filter(([code]) => /^\d{1,3}$/.test(code)).map(([code, n]) => `${code}: ${n}`).sort().join(", ");
        const refused = flood.statuses["429"] ?? 0;
        if (!refused) refuse(`the flooding tenant was never refused (${codes(flood.statuses)})`);
        if ((quiet.statuses["200"] ?? 0) !== OPS02_QUIET.count) refuse(`the quiet tenant did not get every request served while the other was flooding (${codes(quiet.statuses)})`);
        const sorted = [...quiet.durationsMs].sort((a, b) => a - b), quietP95 = Math.round(sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0);
        step = "tenant metrics";
        // The dashboard's "Tenants being refused" panel, with its tenant variable set to each tenant in turn.
        const panel = (workspace: string) => `topk(10, sum by (tenant) (increase(zenith_admission_decisions_total{decision!="allowed",tenant=~"${workspace}"}[15m])))`;
        let flooded: number | undefined;
        for (let attempt = 1; ; attempt++) {
          flooded = (await stack.query(panel(tenant.workspaceId)))[0]?.value;
          if (flooded && flooded > 0) break;
          if (attempt >= 24) refuse("Prometheus did not show the flooding tenant's refusals within 2 minutes");
          await sleep(5_000);
        }
        if ((await stack.query(panel(quietTenant.workspaceId))).some(sample => sample.value > 0)) refuse("Prometheus shows refusals for the quiet tenant");
        step = "workload";
        await product.setManifest(tenant, deploy01Manifest(DEPLOY01_IMAGES.v1, host));
        const deployed = await product.deploy(tenant, environmentId, "apply");
        if (deployed.status !== "succeeded") refuse(`the deploy ended ${/^[a-z_]{1,20}$/.test(deployed.status) ? deployed.status : "unknown"}, not succeeded${deployed.detail ? ` (product: ${deployed.detail})` : ""}`);
        const dns = await readback(DEPLOY01_IMAGES.v1);
        step = "control-plane outage";
        const served: Record<string, number> = {};
        let probing = true;
        const prober = (async () => { while (probing) { const code = await probe(dns, host); served[String(code)] = (served[String(code)] ?? 0) + 1; await sleep(1_000); } })();
        const outageStart = Date.now();
        let firedAfter = 0, fullOutageSeconds = 0;
        try {
          await stack.stopControlStore();
          // The rule waits 2 minutes; 30 checks 10 s apart allow 5.
          for (let attempt = 1; ; attempt++, await sleep(10_000)) {
            if ((await stack.firing()).includes("ZenithControlStoreDown")) { firedAfter = Math.round((Date.now() - outageStart) / 1000); break; }
            if (attempt >= 30) {
              // Why: the last store-up sample and the scrape's own health tell "no 0 sample" from "rule not evaluated".
              const value = async (expr: string) => { const v = (await stack.query(expr).catch(() => []))[0]?.value; return Number.isFinite(v) ? String(v) : "none"; };
              refuse(`ZenithControlStoreDown did not fire within 5 minutes of the control store stopping (store up ${await value("min(zenith_control_store_up)")}, scrape up ${await value('min(up{job="zenith-api"})')})`);
            }
          }
          const fullStart = Date.now();
          await stack.stop(["api", "execution-worker"]);
          await sleep(60_000);
          fullOutageSeconds = Math.round((Date.now() - fullStart) / 1000);
        } finally {
          step = "control-plane restart";
          await stack.startControlStore();
          await stack.start("api");
          await stack.start("execution-worker");
          probing = false;
          await prober;
        }
        const outageSeconds = Math.round((Date.now() - outageStart) / 1000), probes = Object.values(served).reduce((a, b) => a + b, 0);
        // One probe a second: fewer than one per two seconds of outage means the prober stalled and proves nothing.
        if ((served["200"] ?? 0) !== probes || probes < Math.max(1, Math.floor(outageSeconds / 2))) refuse(`the workload did not serve every probe during the outage (${codes(served)})`);
        step = "recovered";
        for (let attempt = 1; ; attempt++) {
          if ((await stack.query("min(zenith_control_store_up)"))[0]?.value === 1) break;
          if (attempt >= 24) refuse("the control store did not report up within 2 minutes of the restart");
          await sleep(5_000);
        }
        const after = await product.burst!(tenant, 1, 1);
        if ((after.statuses["200"] ?? 0) !== 1) refuse("the control plane did not serve the tenant after the restart");
        return { complete: true, reason: `OPS-02 proven on AWS: with the repository's alert rules loaded into Prometheus scraping the API's metrics, one tenant sent ${OPS02_FLOOD.count} requests ${OPS02_FLOOD.concurrency} at a time and was refused ${refused} times (HTTP 429) while a second tenant's ${OPS02_QUIET.count} concurrent requests were all served (p95 ${quietP95} ms); the dashboard's tenant-filtered refusal panel showed ${Math.round(flooded)} refusals for the flooding tenant and none for the quiet one; ${DEPLOY01_IMAGES.v1} on ECS Fargate behind an ALB served all ${probes} HTTP probes (one a second) through a ${outageSeconds} s control-plane outage: the control store stopped (ZenithControlStoreDown fired after ${firedAfter} s), then the API and worker stopped too for ${fullOutageSeconds} s; after the restart the store reported up and the tenant was served again. Not covered: traces in a trace backend, worker-side metrics, Grafana UI import (proven locally by the import harness), Temporal-backed fairness` };
      };
      try {
        if (env.ZENITH_LIVE_PRODUCT !== "1") refuse("ZENITH_LIVE_PRODUCT=1 is not set; no product scenario ran");
        if ((plan.settings.scenario !== "deploy-01" && !ops06 && !ops02) || !plan.productCalls?.length) refuse("the plan is not the deploy-01, ops-06 or ops-02 scenario");
        if (ops02 && !product.burst) refuse("the browser driver has no request burst");
        step = "tenant";
        const tenant = await product.createTenant();
        workspaceId = tenant.workspaceId;
        step = "connection";
        const connection = await product.createAwsConnection(tenant, { accountId: account, region, observeRoleArn: roleArns.observe, deployRoleArn: roleArns.deploy, stateBucket, bootstrapNameSuffix, ...(ops06 ? { secretWriterRoleArn: roleArns.writer } : {}) });
        if (!EXTERNAL_ID_NEW.test(connection.externalId)) refuse("the generated ExternalId has an unexpected shape");
        step = "sandbox trust";
        for (const role of ops06 ? ["observe", "deploy", "writer"] as const : ["observe", "deploy"] as const) {
          const current = await invoke(planned(`deploy01-iam-read-${role}`));
          const original = templateExternalId(parsePolicy(field(field(current, "Role"), "AssumeRolePolicyDocument")), principal);
          const write = planned(`deploy01-iam-trust-${role}`);
          trust.push({ role, original, write });
          await invoke(write, { trustDocument: trustDocument(principal, connection.externalId) });
        }
        externalId = connection.externalId;
        step = "connection verification";
        for (let attempt = 1; ; attempt++) {
          const verified = await product.verifyAws(tenant, connection.connectionId);
          if (verified.ok) break;
          if (attempt >= propagation.attempts) refuse(`connection.verifyAws did not pass after the trust update within the propagation bound${verified.why ?? ""}`);
          await sleep(propagation.intervalMs);
        }
        step = "environment";
        environmentId = (await product.createEnvironment(tenant, { connectionId: connection.connectionId, region, name: `live-${runId.slice(-8).toLowerCase()}` })).environmentId;
        if (ops06) {
          const canary = canaryOf();
          step = "manifest";
          await product.setManifest(tenant, deploy01Manifest(DEPLOY01_IMAGES.v1, host));
          step = "secret";
          if (!product.setSecret) refuse("the browser driver has no secret path");
          await product.setSecret!(tenant, { serviceId: "web", key: OPS06_SECRET_KEY, secretValue: canary });
          step = "deploy";
          const result = await product.deploy(tenant, environmentId, "apply");
          if (result.status !== "succeeded") refuse(`the deploy ended ${/^[a-z_]{1,20}$/.test(result.status) ? result.status : "unknown"}, not succeeded${result.detail ? ` (product: ${result.detail})` : ""}`);
          step = "deploy readback";
          await readback(DEPLOY01_IMAGES.v1);
          step = "recorded state";
          const recorded = await state.read(await stateInput());
          if (JSON.stringify(recorded).includes(canary)) refuse("the recorded OpenTofu state holds the secret value");
          if (!ops06DefinitionReadsSecret(stateAttribute(recorded, "aws_ecs_task_definition", "container_definitions"), canary, account, region)) refuse(`the recorded task definition does not read ${OPS06_SECRET_KEY} from a Zenith Secrets Manager secret`);
          step = "persistence scan";
          const found = await scan(canary);
          if (!found.control) refuse("the persistence scan did not find its own control file; it proves nothing");
          const places = Object.entries(found.leaks).map(([place, n]) => `${place}: ${n}`).sort();
          if (places.length) refuse(`the secret value was found in runner persistence (${places.join(", ")})`);
          outcome = { complete: true, reason: `OPS-06 proven on AWS: ${OPS06_SECRET_KEY} was set through system.setSecret and deployed to ECS Fargate behind an ALB with two-person approval, served HTTP 200; the recorded OpenTofu state holds only the Secrets Manager reference and no copy of the value; a raw-byte scan of Docker's data root (container logs, volumes, written files), the runner temp and the checkout found the value only in its own control file` };
        } else if (ops02) {
          outcome = await ops02Flow(tenant, environmentId);
        } else {
        for (const [label, image, kind] of [["first deploy", DEPLOY01_IMAGES.v1, "apply"], ["update", DEPLOY01_IMAGES.v2, "apply"], ["rollback", DEPLOY01_IMAGES.v1, "rollback"]] as const) {
          step = label;
          if (kind === "apply") await product.setManifest(tenant, deploy01Manifest(image, host));
          const result = await product.deploy(tenant, environmentId, kind);
          if (result.status !== "succeeded") refuse(`the ${label} ended ${/^[a-z_]{1,20}$/.test(result.status) ? result.status : "unknown"}, not succeeded${result.detail ? ` (product: ${result.detail})` : ""}`);
          step = `${label} readback`;
          await readback(image);
        }
        outcome = { complete: true, reason: `DEPLOY-01 proven: connection verified on the sandbox roles; ${DEPLOY01_IMAGES.v1} deployed to ECS Fargate behind an ALB with two-person approval and served HTTP 200; updated to ${DEPLOY01_IMAGES.v2} and rolled back to ${DEPLOY01_IMAGES.v1}, each read back from the recorded state and over HTTP` };
        }
      } catch (error) {
        outcome = error instanceof Refusal
          ? { complete: false, reason: `${label} not proven at ${step}: ${error.message}` }
          : { complete: false, reason: `${label} not proven at ${step}: unexpected failure (details withheld; no completion claim)` };
      }
      const leaks: string[] = [];
      try { await observed?.close(); } catch { leaks.push("the stack composition or Prometheus could not be restored"); }
      if (environmentId && externalId) {
        let destroyedArns: string[] = [], destroyedIds: string[] = [];
        try { ({ destroyedArns = [], destroyedIds = [] } = await state.destroy(await stateInput())); }
        catch (error) { leaks.push(error instanceof Error && /^(OpenTofu|\d+ resource|The recorded state)/.test(error.message) ? error.message : "state cleanup failed; resources may remain"); }
        try {
          // Deleted ECS clusters and task definitions stay INACTIVE (no cost) and deleted rules can linger in the tag inventory;
          // only ARNs the successful destroy removed from the recorded state are excused. Anything else is a leak.
          // A stopped task of a destroyed cluster stays listed for about an hour (no cost).
          const stoppedTask = (arn: string) => { const m = /^(arn:aws:ecs:[a-z0-9-]+:\d{12}:)task\/([A-Za-z0-9_-]+)\/[a-f0-9]{32}$/.exec(arn); return !!m && destroyedArns.includes(`${m[1]}cluster/${m[2]}`); };
          // Update and rollback register new task definition revisions; earlier revisions of a destroyed family stay INACTIVE.
          const family = (arn: string) => /^(arn:aws:ecs:[a-z0-9-]+:\d{12}:task-definition\/[A-Za-z0-9_-]+):\d+$/.exec(arn)?.[1];
          const families = new Set(destroyedArns.map(family).filter(Boolean));
          // AWS refuses DeleteVpc while a subnet remains, so once the destroy removed the VPC a listed subnet is a stale index entry.
          const vpcGone = destroyedArns.some(arn => /^arn:aws:ec2:[a-z0-9-]+:\d{12}:vpc\/vpc-[0-9a-f]+$/.test(arn));
          const staleSubnet = (arn: string) => vpcGone && /^arn:aws:ec2:[a-z0-9-]+:\d{12}:subnet\/subnet-[0-9a-f]+$/.test(arn);
          const gone = (arn: string) => destroyedArns.includes(arn) || destroyedIds.includes(arn.split(/[/:]/).pop() ?? "") || stoppedTask(arn) || families.has(family(arn)) || staleSubnet(arn);
          // The tagging index lags deletes (subnets, rules): re-list a few times before calling anything a leak.
          let list: string[] = [];
          for (let attempt = 1; ; attempt++) {
            const left = await invoke(planned("deploy01-tag-read"), { environmentId });
            list = ((field(left, "ResourceTagMappingList") as unknown[] | undefined) ?? []).map(r => String(field(r, "ResourceARN"))).filter(arn => !gone(arn));
            if (!list.length || attempt >= 4) break;
            await sleep(90_000);
          }
          // The resource types (service:type, never ids) say what to look for.
          const types = [...new Set(list.map(arn => { const [, , service, , , rest] = arn.split(":"); return `${service}:${(rest ?? "").split("/")[0]}`; }))].filter(t => /^[a-z0-9-]{1,30}:[a-z0-9-]{0,40}$/.test(t)).sort();
          if (list.length) leaks.push(`${list.length} tagged resource(s) still present after cleanup${types.length ? ` (${types.join(", ")})` : ""}`);
        } catch { leaks.push("cleanup re-list failed; resources may remain"); }
      }
      for (const t of [...trust].reverse()) {
        try { await invoke(t.write, { trustDocument: trustDocument(principal, t.original) }); }
        catch { leaks.push(`restoring the ${t.role} sandbox trust failed`); }
      }
      try { await product.close?.(); } catch { /* best-effort browser release */ }
      if (leaks.length) return { complete: false, reason: `${outcome.reason}; cleanup leaks: ${leaks.length} (see the cleanup checks)`, leaks };
      return { ...outcome, leaks };
    },
  };
}
