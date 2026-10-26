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
import http from "node:http";
import type { EnvLike } from "../../config";
import type { Call, Json, ProductScenarioPort } from "../contracts";
import { MIX03_ROLE_NAMES } from "../plan";
import type { Deploy01Product } from "./deploy-01-driver";
import { fill, parsePolicy, refuse, Refusal, templateExternalId, trustDocument } from "./mix-03";
import { destroyFromState, readState, stateAttribute, type SessionCredentials, type StateDestroyInput } from "./state-destroy";

type Invoke = (call: Call, values?: Record<string, string>, extra?: Record<string, Json>) => Promise<Record<string, unknown>>;
export const DEPLOY01_IMAGES = { v1: "public.ecr.aws/nginx/nginx:1.27", v2: "public.ecr.aws/nginx/nginx:1.26" } as const;
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
  state?: { read: (input: StateDestroyInput) => Promise<unknown>; destroy: (input: StateDestroyInput) => Promise<{ destroyed: number }> };
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
  return {
    async verify(requirement, { plan, call }) {
      if (requirement.id !== "PROD-REL-01") return { complete: false, reason: `${requirement.id}: not implemented by this port` };
      const invoke: Invoke = (c, values = {}, extra = {}) => call(c, { ...fill(c.input, values), ...extra });
      const planned = (id: string): Call => plan.productCalls?.find(c => c.id === id) ?? refuse(`the plan has no call ${id}`);
      const account = plan.settings.accountId, region = plan.settings.region, runId = plan.settings.runId;
      const principal = `arn:aws:iam::${account}:role/${MIX03_ROLE_NAMES.principal}`;
      const roleArns = { observe: `arn:aws:iam::${account}:role/${MIX03_ROLE_NAMES.observe}`, deploy: `arn:aws:iam::${account}:role/${MIX03_ROLE_NAMES.deploy}` };
      const stateBucket = `zenith-state-${account}-${region}-live`;
      const host = `web-${runId.slice(-8).toLowerCase()}.example.com`;
      const tofu = env.ZENITH_TOFU_BIN?.trim() || "tofu";
      const trust: { role: "observe" | "deploy"; original: string; write: Call }[] = [];
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
          if ((await probe(dns as string, host)) === 200) return;
          if (attempt >= 40) refuse("the load balancer did not serve HTTP 200 for the route host within 10 minutes");
          await sleep(15_000);
        }
      };
      let step = "preconditions";
      let outcome: { complete: boolean; reason: string };
      try {
        if (env.ZENITH_LIVE_PRODUCT !== "1") refuse("ZENITH_LIVE_PRODUCT=1 is not set; no product scenario ran");
        if (plan.settings.scenario !== "deploy-01" || !plan.productCalls?.length) refuse("the plan is not the deploy-01 scenario");
        step = "tenant";
        const tenant = await product.createTenant();
        workspaceId = tenant.workspaceId;
        step = "connection";
        const connection = await product.createAwsConnection(tenant, { accountId: account, region, observeRoleArn: roleArns.observe, deployRoleArn: roleArns.deploy, stateBucket });
        if (!EXTERNAL_ID_NEW.test(connection.externalId)) refuse("the generated ExternalId has an unexpected shape");
        step = "sandbox trust";
        for (const role of ["observe", "deploy"] as const) {
          const current = await invoke(planned(`deploy01-iam-read-${role}`));
          const original = templateExternalId(parsePolicy(field(field(current, "Role"), "AssumeRolePolicyDocument")), principal);
          const write = planned(`deploy01-iam-trust-${role}`);
          trust.push({ role, original, write });
          await invoke(write, { trustDocument: trustDocument(principal, connection.externalId) });
        }
        externalId = connection.externalId;
        step = "connection verification";
        for (let attempt = 1; ; attempt++) {
          if ((await product.verifyAws(tenant, connection.connectionId)).ok) break;
          if (attempt >= propagation.attempts) refuse("connection.verifyAws did not pass after the trust update within the propagation bound");
          await sleep(propagation.intervalMs);
        }
        step = "environment";
        environmentId = (await product.createEnvironment(tenant, { connectionId: connection.connectionId, region, name: `live-${runId.slice(-8).toLowerCase()}` })).environmentId;
        for (const [label, image, kind] of [["first deploy", DEPLOY01_IMAGES.v1, "apply"], ["update", DEPLOY01_IMAGES.v2, "apply"], ["rollback", DEPLOY01_IMAGES.v1, "rollback"]] as const) {
          step = label;
          if (kind === "apply") await product.setManifest(tenant, deploy01Manifest(image, host));
          const result = await product.deploy(tenant, environmentId, kind);
          if (result.status !== "succeeded") refuse(`the ${label} ended ${/^[a-z_]{1,20}$/.test(result.status) ? result.status : "unknown"}, not succeeded`);
          step = `${label} readback`;
          await readback(image);
        }
        outcome = { complete: true, reason: `DEPLOY-01 proven: connection verified on the sandbox roles; ${DEPLOY01_IMAGES.v1} deployed to ECS Fargate behind an ALB with two-person approval and served HTTP 200; updated to ${DEPLOY01_IMAGES.v2} and rolled back to ${DEPLOY01_IMAGES.v1}, each read back from the recorded state and over HTTP` };
      } catch (error) {
        outcome = error instanceof Refusal
          ? { complete: false, reason: `DEPLOY-01 not proven at ${step}: ${error.message}` }
          : { complete: false, reason: `DEPLOY-01 not proven at ${step}: unexpected failure (details withheld; no completion claim)` };
      }
      const leaks: string[] = [];
      if (environmentId && externalId) {
        try { await state.destroy(await stateInput()); }
        catch (error) { leaks.push(error instanceof Error && /^(OpenTofu|\d+ resource|The recorded state)/.test(error.message) ? error.message : "state cleanup failed; resources may remain"); }
        try {
          const left = await invoke(planned("deploy01-tag-read"), { environmentId });
          const list = field(left, "ResourceTagMappingList");
          if (Array.isArray(list) && list.length) leaks.push(`${list.length} tagged resource(s) still present after cleanup`);
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
