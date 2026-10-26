/**
 * Hand-built fixtures for the compute driver tests: a small environment graph
 * (network, subnets, log group, identity, secret, registry, build pipeline,
 * load balancer), a `CompileContext` that resolves `ctx.ref` the way the
 * shared protocol describes (`${local.ref_<label>__<attribute>}`), and stub
 * fragments that DEFINE those locals with real resources so a full workspace
 * can be assembled and `tofu validate`d.
 *
 * The stubs stand in for other driver groups' output (network, data). They
 * are test scaffolding only; nothing here is a claim about those drivers.
 */
import type { CompileContext, DriverContext, TofuFragment } from "@/lib/drivers/types";
import type { AwsSession } from "@/lib/credentials/types";
import type { PortableKind, ResourceGraph, ResourceNode } from "@/lib/resources/types";
import type { ContainerServiceSpec, IdentitySpec, LoadBalancerSpec, ScheduledJobSpec } from "@/lib/resources/specs";
import { refLocalName, tfLabel } from "@/lib/providers/aws/drivers/shared";

export const REGION = "eu-west-1";
export const ENV_ID = "env_1";
export const WORKSPACE_ID = "ws_1";
export const NAME_PREFIX = "zn-acme";

export const CTX_TAGS: Record<string, string> = {
  "zenith:workspace": WORKSPACE_ID,
  "zenith:environment": ENV_ID,
  "zenith:managed": "true",
};

export function mkNode(address: string, kind: PortableKind | "provider_native", nativeType: string, spec: Record<string, unknown>, over: Partial<ResourceNode> = {}): ResourceNode {
  return {
    address,
    kind,
    provider: "aws",
    region: REGION,
    nativeType,
    ownership: "managed",
    spec,
    origin: [],
    dependsOn: [],
    specDigest: "0".repeat(64),
    labels: {},
    ...over,
  };
}

/** A canary that must never appear in any fragment, observation or error. */
export const SECRET_CANARY = "CANARY-secret-value-9f3a";

export interface GraphOptions {
  artifact?: ContainerServiceSpec["artifact"];
  env?: ContainerServiceSpec["env"];
  vcpu?: number;
  memoryMb?: number;
  replicas?: number;
  port?: number | null;
  withLb?: boolean;
  withSecret?: boolean;
}

export interface Fixture {
  nodes: ResourceNode[];
  byAddress: Map<string, ResourceNode>;
  graph: ResourceGraph;
  service: ResourceNode;
  job: ResourceNode;
}

export const SECRET_ADDRESS = "secret/db-url-1a2b3c4d";

export function buildFixture(opts: GraphOptions = {}): Fixture {
  const withSecret = opts.withSecret ?? true;
  const env = opts.env ?? [{ key: "LOG_LEVEL", value: "info" }, ...(withSecret ? [{ key: "DATABASE_URL", secretRef: "vault:db-url" }] : [])];
  const artifact = opts.artifact ?? { type: "built" as const, pipeline: "build_pipeline/web", registry: "container_registry/web" };
  const grants: IdentitySpec["grants"] = [
    { target: "log_group/web", access: ["write"], via: ["own_log_group"] },
    { target: "container_registry/web", access: ["pull"], via: ["image_pull"] },
    ...(withSecret ? [{ target: SECRET_ADDRESS, access: ["read"], via: ["env:DATABASE_URL"] }] : []),
  ];
  const port = opts.port === null ? undefined : (opts.port ?? 8080);
  const svcSpec: ContainerServiceSpec = {
    size: "small",
    vcpu: opts.vcpu ?? 0.5,
    memoryMb: opts.memoryMb ?? 512,
    artifact,
    env,
    zones: 2,
    subnetTier: "private",
    workload: "web",
    replicas: opts.replicas ?? 2,
    ...(port !== undefined ? { port, healthPath: "/healthz" } : {}),
  };
  const lbSpec: LoadBalancerSpec = {
    scheme: "internet-facing",
    tier: "public",
    listeners: [{ port: 80, protocol: "http" }],
    routes: [{ host: "app.example.com", pathPrefix: "/", tls: false, target: "container_service/web", ...(port !== undefined ? { port } : {}), healthPath: "/healthz" }],
  };
  const common = ["network/main", "subnet/private-a", "subnet/private-b", "log_group/web", "identity/web"];
  const nodes: ResourceNode[] = [
    mkNode("network/main", "network", "aws:vpc", { cidr: "10.20.0.0/16", zones: 2 }),
    mkNode("subnet/private-a", "subnet", "aws:subnet", { tier: "private", zone: "a", cidr: "10.20.0.0/24", network: "network/main" }, { dependsOn: ["network/main"] }),
    mkNode("subnet/private-b", "subnet", "aws:subnet", { tier: "private", zone: "b", cidr: "10.20.1.0/24", network: "network/main" }, { dependsOn: ["network/main"] }),
    mkNode("subnet/public-a", "subnet", "aws:subnet", { tier: "public", zone: "a", cidr: "10.20.10.0/24", network: "network/main" }, { dependsOn: ["network/main"] }),
    mkNode("log_group/web", "log_group", "aws:cloudwatch_log_group", { workload: "container_service/web", retentionDays: 30 }),
    mkNode("identity/web", "identity", "aws:iam_role", { principal: "workload", workload: "container_service/web", grants } satisfies IdentitySpec, { dependsOn: ["log_group/web", ...(withSecret ? [SECRET_ADDRESS] : [])] }),
    mkNode("container_registry/web", "container_registry", "aws:ecr_repository", { scanOnPush: true, immutableTags: false }),
    mkNode("build_pipeline/web", "build_pipeline", "aws:codebuild_project", { source: { repo: "https://github.com/acme/web", ref: "main" }, output: { registry: "container_registry/web" }, location: "customer_account" }, { dependsOn: ["container_registry/web"] }),
    ...(withSecret ? [mkNode(SECRET_ADDRESS, "secret", "aws:secretsmanager_secret", { secretRef: "vault:db-url", store: "zenith_vault", purpose: "environment" })] : []),
    mkNode("container_service/web", "container_service", "aws:ecs_service", { ...svcSpec }, {
      dependsOn: [...common, ...(artifact.type === "built" ? ["build_pipeline/web"] : []), ...(withSecret ? [SECRET_ADDRESS] : []), ...(opts.withLb === false ? [] : ["load_balancer/public"])],
    }),
    ...(opts.withLb === false ? [] : [mkNode("load_balancer/public", "load_balancer", "aws:alb", { ...lbSpec }, { dependsOn: ["network/main", "subnet/public-a"] })]),
  ];
  const jobSpec: ScheduledJobSpec = {
    size: "small",
    vcpu: 0.25,
    memoryMb: 256,
    artifact: { type: "image", ref: "ghcr.io/acme/job:1.4.2" },
    env: [{ key: "MODE", value: "nightly" }],
    zones: 2,
    subnetTier: "private",
    schedule: "0 2 * * 1-5",
  };
  const job = mkNode("scheduled_job/nightly", "scheduled_job", "aws:ecs_scheduled_task", { ...jobSpec }, { dependsOn: ["network/main", "subnet/private-a", "subnet/private-b", "log_group/nightly", "identity/nightly"] });
  nodes.push(
    mkNode("log_group/nightly", "log_group", "aws:cloudwatch_log_group", { workload: "scheduled_job/nightly", retentionDays: 30 }),
    mkNode("identity/nightly", "identity", "aws:iam_role", { principal: "workload", workload: "scheduled_job/nightly", grants: [{ target: "log_group/nightly", access: ["write"], via: ["own_log_group"] }] } satisfies IdentitySpec),
    job
  );
  const byAddress = new Map(nodes.map((n) => [n.address, n]));
  const graph: ResourceGraph = { version: 1, environmentId: ENV_ID, manifestDigest: "m".repeat(8), nodes, edges: [], graphDigest: "g".repeat(8), notes: [] };
  return { nodes, byAddress, graph, service: byAddress.get("container_service/web")!, job };
}

/* ------------------------- the wider graph (all drivers) -------------------- */

export const TLS_ADDRESS = "tls_certificate/docs.example.com";

/** `buildFixture()` plus a static site (with its build and certificate), a function and an instance. */
export function buildFullFixture(opts: GraphOptions = {}): Fixture & { site: ResourceNode; siteBuild: ResourceNode; fn: ResourceNode; box: ResourceNode; registry: ResourceNode; pipeline: ResourceNode; tls: ResourceNode } {
  const fx = buildFixture(opts);
  const tls = mkNode(TLS_ADDRESS, "tls_certificate", "aws:acm_certificate", { domain: "docs.example.com", validation: "dns_automatic" }, { region: "us-east-1" });
  const siteBuild = mkNode("build_pipeline/docs", "build_pipeline", "aws:codebuild_project", { source: { repo: "https://github.com/acme/docs", ref: "main" }, output: { staticSite: "static_site/docs" }, location: "customer_account" });
  const site = mkNode("static_site/docs", "static_site", "aws:s3_static_site", { size: "small", artifact: { type: "built", pipeline: "build_pipeline/docs" } }, { dependsOn: ["build_pipeline/docs", TLS_ADDRESS] });
  const fn = mkNode(
    "function/resize",
    "function",
    "aws:lambda_function",
    { runtime: "nodejs22.x", handler: "index.handler", memoryMb: 512, timeoutSec: 20, artifact: { type: "s3", bucket: "acme-artifacts", key: "fn/resize.zip", version: "fixture-version-1", sha256: "a".repeat(64), sourceDigest: "b".repeat(64) }, env: [{ key: "MODE", value: "fast" }] },
    {}
  );
  const box = mkNode("compute_instance/bastion", "compute_instance", "aws:ec2_instance", { instanceType: "t3.micro", rootVolumeGb: 30 }, { dependsOn: ["network/main", "subnet/private-a"] });
  const nodes = [...fx.nodes, tls, siteBuild, site, fn, box];
  const byAddress = new Map(nodes.map((n) => [n.address, n]));
  return {
    ...fx,
    nodes,
    byAddress,
    graph: { ...fx.graph, nodes },
    site,
    siteBuild,
    fn,
    box,
    registry: byAddress.get("container_registry/web")!,
    pipeline: byAddress.get("build_pipeline/web")!,
    tls,
  };
}

export function mkCompileContext(byAddress: Map<string, ResourceNode>, over: Partial<CompileContext> = {}): CompileContext {
  return {
    environmentId: ENV_ID,
    namePrefix: NAME_PREFIX,
    region: REGION,
    tags: { ...CTX_TAGS },
    ref: (address, attribute) => `\${local.${refLocalName(address, attribute)}}`,
    node: (address) => byAddress.get(address),
    allowExperimentalAws: true,
    ...over,
  };
}

/* ------------------------------ neighbour stubs ---------------------------- */

const local = (address: string, attribute: string) => refLocalName(address, attribute);

/** Fragments that define the locals the compute drivers reference, with real resources behind them. */
export function stubFragments(fx: Fixture): Map<string, TofuFragment> {
  const out = new Map<string, TofuFragment>();
  const has = (a: string) => fx.byAddress.has(a);
  out.set("network/main", {
    resource: { aws_vpc: { network_main: { cidr_block: "10.20.0.0/16" } } },
    locals: { [local("network/main", "id")]: "${aws_vpc.network_main.id}" },
    addresses: ["aws_vpc.network_main"],
  });
  for (const [addr, cidr, az] of [
    ["subnet/private-a", "10.20.0.0/24", "a"],
    ["subnet/private-b", "10.20.1.0/24", "b"],
    ["subnet/public-a", "10.20.10.0/24", "a"],
  ] as const) {
    const l = tfLabel(addr);
    out.set(addr, {
      resource: { aws_subnet: { [l]: { vpc_id: "${aws_vpc.network_main.id}", cidr_block: cidr, availability_zone: `${REGION}${az}` } } },
      locals: { [local(addr, "id")]: `\${aws_subnet.${l}.id}` },
      addresses: [`aws_subnet.${l}`],
    });
  }
  for (const n of ["web", "nightly"]) {
    out.set(`log_group/${n}`, {
      resource: { aws_cloudwatch_log_group: { [`log_group_${n}`]: { name: `/zenith/${n}`, retention_in_days: 30 } } },
      locals: { [local(`log_group/${n}`, "name")]: `\${aws_cloudwatch_log_group.log_group_${n}.name}` },
      addresses: [`aws_cloudwatch_log_group.log_group_${n}`],
    });
    out.set(`identity/${n}`, {
      resource: {
        aws_iam_role: {
          [`identity_${n}`]: {
            name: `zn-acme-${n}-task`,
            assume_role_policy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "ecs-tasks.amazonaws.com" }, Action: "sts:AssumeRole" }] }),
          },
        },
      },
      locals: { [local(`identity/${n}`, "arn")]: `\${aws_iam_role.identity_${n}.arn}` },
      addresses: [`aws_iam_role.identity_${n}`],
    });
  }
  if (has(SECRET_ADDRESS)) {
    out.set(SECRET_ADDRESS, {
      resource: { aws_secretsmanager_secret: { secret_db_url: { name: "zn-acme-db-url" } } },
      locals: { [local(SECRET_ADDRESS, "arn")]: "${aws_secretsmanager_secret.secret_db_url.arn}" },
      addresses: ["aws_secretsmanager_secret.secret_db_url"],
    });
  }
  if (has(TLS_ADDRESS)) {
    out.set(TLS_ADDRESS, {
      resource: { aws_acm_certificate: { tls_docs: { domain_name: "docs.example.com", validation_method: "DNS" } } },
      locals: { [local(TLS_ADDRESS, "arn")]: "${aws_acm_certificate.tls_docs.arn}" },
      addresses: ["aws_acm_certificate.tls_docs"],
    });
  }
  if (has("load_balancer/public")) {
    out.set("load_balancer/public", {
      resource: {
        aws_lb_target_group: { lb_tg: { name: "zn-acme-web", port: 8080, protocol: "HTTP", vpc_id: "${aws_vpc.network_main.id}", target_type: "ip" } },
      },
      locals: { [local("load_balancer/public", "target_group_arn:container_service/web")]: "${aws_lb_target_group.lb_tg.arn}" },
      addresses: ["aws_lb_target_group.lb_tg"],
    });
  }
  return out;
}

/* ---------------------------------- session -------------------------------- */

export interface FakeSessionOptions {
  accountId?: string;
  region?: string;
}

/** An AwsSession whose clients are real SDK clients (their `send` is mocked by aws-sdk-client-mock). */
export function fakeSession(opts: FakeSessionOptions = {}): AwsSession {
  const region = opts.region ?? REGION;
  return {
    provider: "aws",
    accountId: opts.accountId ?? "123456789012",
    region,
    expiresAt: "2099-01-01T00:00:00.000Z",
    transport: "emulator",
    client: (ctor, overrides) => new ctor({ region: overrides?.region ?? region, credentials: { accessKeyId: "AKIAFAKEFAKEFAKEFAKE", secretAccessKey: "fake", sessionToken: "fake" } }),
    childProcessEnv: () => ({}),
  };
}

export function mkDriverContext(over: Partial<DriverContext<AwsSession>> = {}): DriverContext<AwsSession> & { logs: string[] } {
  const logs: string[] = [];
  return {
    provider: "aws",
    region: REGION,
    workspaceId: WORKSPACE_ID,
    environmentId: ENV_ID,
    operationId: "op_test_1",
    session: fakeSession(),
    signal: new AbortController().signal,
    log: (line) => void logs.push(line),
    tags: { ...CTX_TAGS },
    now: () => new Date("2026-09-30T12:00:00.000Z"),
    ...over,
    logs,
  };
}

/** The Zenith tags an object of `node` carries, in the AWS `Tags` list shape. */
export function zenithTagList(address: string, extra: Record<string, string> = {}): { Key: string; Value: string }[] {
  return Object.entries({ ...CTX_TAGS, "zenith:resource": address, ...extra }).map(([Key, Value]) => ({ Key, Value }));
}

export function zenithTagMap(address: string, extra: Record<string, string> = {}): Record<string, string> {
  return { ...CTX_TAGS, "zenith:resource": address, ...extra };
}
