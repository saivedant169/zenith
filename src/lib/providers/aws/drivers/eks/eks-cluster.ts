/**
 * EKS driver: pinned Kubernetes version, private API by default,
 * KMS secrets encryption, private managed AL2023 nodes with encrypted gp3
 * disks/IMDSv2, all control-plane logs, and the Pod Identity agent add-on.
 * Pod identities and Kubernetes access entries are explicit follow-up resources;
 * installing the agent does not grant a workload or cluster creator access.
 *
 * The cluster publishes endpoint/server, CA data, name, OIDC issuer and SG ID
 * as non-secret locals for a Kubernetes connection. No token or kubeconfig is
 * generated. Broker-bound SDK reads validate account, region and tenant tags.
 * Runtime reports EKS managed-group health, not Kubernetes node readiness or
 * endpoint reachability. Launch-template disks/IMDS and add-ons are not read.
 * Evidence is mocked SDK contracts only; no live AWS acceptance was performed.
 * Private subnets need NAT or suitable AWS VPC endpoints for node bootstrap.
 * Native manifests may name generated subnet addresses in config.subnets;
 * hand-built graphs can instead carry direct subnet dependencies.
 */
import { z } from "zod";
import { awsBoundaryArn, trustedAwsBoundaryArn, type AwsRoleFamily } from "@/lib/credentials/aws/naming";
import {
  DescribeClusterCommand, DescribeNodegroupCommand, EKSClient,
  ListNodegroupsCommand, ListTagsForResourceCommand,
  type Cluster, type Nodegroup,
} from "@aws-sdk/client-eks";
import type { AwsSession } from "@/lib/credentials/types";
import type { CompileContext, ResourceDriver, TofuFragment } from "@/lib/drivers/types";
import type { HealthState, ResourceNode } from "@/lib/resources/types";
import {
  DriverCompileError, FragmentBuilder, cloudName, nodeName, refExpr, resourceTags,
  addSecurityGroup, securityGroupLabel, subnetsOf, tfLabel,
  attempt, classifyAwsError, matchesNodeTags, paginate, parseArn, partitionOfRegion,
  standardVerification, throwIfAborted, verificationResult,
} from "@/lib/providers/aws/drivers/shared";
import {
  Attributes, attrCheck, call, expectedFor, failAttributes, findByTags,
  guardObserve, guardRuntime, type AwsDriverContext,
} from "@/lib/providers/aws/drivers/data/support";
import { parseCidr } from "@/lib/providers/aws/drivers/network/cidr";
import { assertAwsNode, KMS_KEY_ARN, neighbour, readSpec } from "@/lib/providers/aws/drivers/messaging/support";

export const EKS_CLUSTER_SCHEMA = z.object({
  version: z.string().regex(/^1\.[1-9][0-9]$/),
  subnets: z.array(z.string().regex(/^subnet\/[a-z0-9-]+$/)).max(16).optional(),
  kmsKeyArn: z.string().regex(KMS_KEY_ARN).optional(),
  encryption: z.literal(true).optional(),
  endpointPublicAccess: z.boolean().prefault(false),
  publicAccessCidrs: z.array(z.string().max(32)).max(50).prefault([]),
  nodeInstanceType: z.string().regex(/^[a-z][a-z0-9-]{0,14}\.[a-z0-9]{1,20}$/).prefault("t3.medium"),
  nodeMin: z.number().int().min(1).max(100).prefault(1),
  nodeDesired: z.number().int().min(1).max(100).prefault(2),
  nodeMax: z.number().int().min(1).max(100).prefault(3),
  nodeDiskGb: z.number().int().min(20).max(16384).prefault(20),
  podIdentityAddonVersion: z.string().regex(/^v\d+\.\d+\.\d+-eksbuild\.\d+$/).optional(),
}).strict();
export type EksClusterSpec = z.input<typeof EKS_CLUSTER_SCHEMA>;
export const EKS_LOG_TYPES = ["api", "audit", "authenticator", "controllerManager", "scheduler"] as const;

/**
 * The shared helper owns the rule-free group. EKS adds its explicit self-only
 * traffic and outbound HTTPS rules without introducing inline or public ingress.
 */
function addClusterSecurityGroup(b: FragmentBuilder, node: ResourceNode, ctx: CompileContext, network: string): string[] {
  const label = securityGroupLabel(node.address);
  // Native config.subnets need not appear in dependsOn. The validated network
  // is a local topology view; the caller's node and its graph remain untouched.
  const sg = addSecurityGroup(b, { ...node, dependsOn: [...node.dependsOn, network] }, ctx, { egress: "none" });
  const group = refExpr(`${sg}.id`);
  const tags = resourceTags(ctx.tags, node.address);
  // Self-only traffic covers kubelet, DNS, webhooks and pod-to-pod networking.
  // There is no inline rule and no ingress from a public or entire VPC CIDR.
  const ingress = b.resource("aws_vpc_security_group_ingress_rule", `${label}_self`, {
    security_group_id: group, referenced_security_group_id: group, ip_protocol: "-1", tags,
  });
  const egress = b.resource("aws_vpc_security_group_egress_rule", `${label}_self`, {
    security_group_id: group, referenced_security_group_id: group, ip_protocol: "-1", tags,
  });
  const https = b.resource("aws_vpc_security_group_egress_rule", `${label}_https`, {
    security_group_id: group, ip_protocol: "tcp", from_port: 443, to_port: 443, cidr_ipv4: "0.0.0.0/0",
    description: "HTTPS for private nodes to AWS APIs and registries through NAT", tags,
  });
  return [ingress, egress, https];
}

export function compileEksCluster(node: ResourceNode, ctx: CompileContext): TofuFragment {
  if (node.ownership !== "managed") return { addresses: [] };
  assertAwsNode(node, ctx);
  const spec = readSpec(node, EKS_CLUSTER_SCHEMA);
  if (spec.nodeMin > spec.nodeDesired || spec.nodeDesired > spec.nodeMax) {
    throw new DriverCompileError("invalid_spec", node.address, "node counts must satisfy min <= desired <= max.");
  }
  // The AMI is deliberately AL2023 x86_64; don't silently attach an ARM shape.
  if (/^[a-z]+\d+g[a-z]*\./.test(spec.nodeInstanceType)) {
    throw new DriverCompileError("unsupported", node.address, "the managed node group requires an x86_64 instance type.");
  }
  const cidrs = [...new Set(spec.publicAccessCidrs)].sort();
  if (spec.endpointPublicAccess ? cidrs.length === 0 || cidrs.some((cidr) => { const parsed = parseCidr(cidr); return !parsed || parsed.prefix < 8; }) : cidrs.length !== 0) {
    throw new DriverCompileError("policy_refused", node.address, "public access requires explicit canonical IPv4 CIDRs of /8 or narrower; private-only clusters must omit them.");
  }
  if (spec.kmsKeyArn && !spec.kmsKeyArn.includes(`:kms:${node.region}:`)) {
    throw new DriverCompileError("invalid_spec", node.address, "the secrets encryption key must be in the cluster's region.");
  }
  const subnets = [...new Map([...subnetsOf(node, ctx), ...(spec.subnets ?? []).map((address) => neighbour(node, ctx, address, "aws:subnet"))]
    .map((subnet) => [subnet.address, subnet])).values()].sort((a, b) => a.address < b.address ? -1 : a.address > b.address ? 1 : 0);
  if (subnets.length < 2 || subnets.some((subnet) => subnet.spec.tier !== "private" || !/^[a-f]$/.test(String(subnet.spec.zone)))) {
    throw new DriverCompileError("invalid_spec", node.address, "EKS requires at least two private subnets with declared zone letters.");
  }
  for (const subnet of subnets) neighbour(node, ctx, subnet.address, "aws:subnet");
  if (new Set(subnets.map((subnet) => subnet.spec.zone)).size < 2) {
    throw new DriverCompileError("invalid_spec", node.address, "EKS subnets must span at least two availability zones.");
  }
  const network = subnets[0].spec.network;
  if (typeof network !== "string" || subnets.some((subnet) => subnet.spec.network !== network)) {
    throw new DriverCompileError("invalid_spec", node.address, "all EKS subnets must name the same network.");
  }
  neighbour(node, ctx, network, "aws:vpc");

  const label = tfLabel(node.address);
  const name = cloudName(ctx.namePrefix, nodeName(node.address), 100);
  const b = new FragmentBuilder(node.address);
  const cluster = `aws_eks_cluster.${label}`;
  const account = `data.aws_caller_identity.${label}.account_id`;
  const partition = `data.aws_partition.${label}.partition`;
  const tags = resourceTags(ctx.tags, node.address);
  const subnetIds = subnets.map((subnet) => refExpr(ctx.ref(subnet.address, "id")));
  const keyArn = spec.kmsKeyArn ?? refExpr(`aws_kms_key.${label}.arn`);
  b.resource("aws_eks_cluster", label, {
    name, version: spec.version, role_arn: refExpr(`aws_iam_role.${label}_cluster.arn`),
    enabled_cluster_log_types: [...EKS_LOG_TYPES],
    access_config: [{ authentication_mode: "API", bootstrap_cluster_creator_admin_permissions: false }],
    vpc_config: [{
      subnet_ids: subnetIds, security_group_ids: [refExpr(`aws_security_group.${securityGroupLabel(node.address)}.id`)],
      endpoint_private_access: true, endpoint_public_access: spec.endpointPublicAccess,
      ...(spec.endpointPublicAccess ? { public_access_cidrs: cidrs } : {}),
    }],
    encryption_config: [{ provider: [{ key_arn: keyArn }], resources: ["secrets"] }],
    tags,
    depends_on: [`aws_iam_role_policy_attachment.${label}_cluster`, `aws_cloudwatch_log_group.${label}`],
  });
  b.data("aws_caller_identity", label, {});
  b.data("aws_partition", label, {});
  if (!spec.kmsKeyArn) b.resource("aws_kms_key", label, {
    description: "Zenith EKS secrets encryption", enable_key_rotation: true, deletion_window_in_days: 30, tags,
    lifecycle: { prevent_destroy: true },
  });
  b.resource("aws_cloudwatch_log_group", label, { name: `/aws/eks/${name}/cluster`, retention_in_days: 30, tags });
  const role = (suffix: "cluster" | "nodes", principal: string) => b.resource("aws_iam_role", `${label}_${suffix}`, {
    name: `${cloudName(ctx.namePrefix, nodeName(node.address), 64 - suffix.length - 1)}-${suffix}`,
    permissions_boundary: trustedAwsBoundaryArn(ctx.awsBootstrap, ({ cluster: "eksCluster", nodes: "eksNode" } as const satisfies Record<string, AwsRoleFamily>)[suffix]) ?? awsBoundaryArn(({ cluster: "eksCluster", nodes: "eksNode" } as const satisfies Record<string, AwsRoleFamily>)[suffix], refExpr(partition), refExpr(account)),
    assume_role_policy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: principal }, Action: "sts:AssumeRole" }] }), tags,
  });
  const clusterRole = role("cluster", "eks.amazonaws.com");
  const nodeRole = role("nodes", "ec2.amazonaws.com");
  const attach = (suffix: string, roleAddress: string, policy: string) => b.resource("aws_iam_role_policy_attachment", `${label}_${suffix}`, {
    role: refExpr(`${roleAddress}.name`), policy_arn: `arn:${refExpr(partition)}:iam::aws:policy/${policy}`,
  });
  attach("cluster", clusterRole, "AmazonEKSClusterPolicy");
  const nodePolicies = [
    attach("worker", nodeRole, "AmazonEKSWorkerNodePolicy"),
    attach("cni", nodeRole, "AmazonEKS_CNI_Policy"),
    attach("registry", nodeRole, "AmazonEC2ContainerRegistryReadOnly"),
  ];
  const rules = addClusterSecurityGroup(b, node, ctx, network);
  const template = b.resource("aws_launch_template", label, {
    name: cloudName(ctx.namePrefix, `${nodeName(node.address)}-nodes`, 128),
    vpc_security_group_ids: [refExpr(`aws_security_group.${securityGroupLabel(node.address)}.id`)],
    metadata_options: [{ http_endpoint: "enabled", http_tokens: "required", http_put_response_hop_limit: 2 }],
    block_device_mappings: [{ device_name: "/dev/xvda", ebs: [{ encrypted: true, volume_type: "gp3", volume_size: spec.nodeDiskGb, delete_on_termination: true }] }],
    tag_specifications: [{ resource_type: "instance", tags }, { resource_type: "volume", tags }], tags,
  });
  const group = b.resource("aws_eks_node_group", label, {
    cluster_name: refExpr(`${cluster}.name`), node_group_name: cloudName(ctx.namePrefix, `${nodeName(node.address)}-nodes`, 63),
    node_role_arn: refExpr(`${nodeRole}.arn`), subnet_ids: subnetIds,
    ami_type: "AL2023_x86_64_STANDARD", capacity_type: "ON_DEMAND", instance_types: [spec.nodeInstanceType],
    version: spec.version,
    launch_template: [{ id: refExpr(`${template}.id`), version: refExpr(`${template}.latest_version`) }],
    scaling_config: [{ min_size: spec.nodeMin, desired_size: spec.nodeDesired, max_size: spec.nodeMax }],
    update_config: [{ max_unavailable: 1 }], tags, depends_on: [...nodePolicies, ...rules],
  });
  b.resource("aws_eks_addon", `${label}_pod_identity`, {
    cluster_name: refExpr(`${cluster}.name`), addon_name: "eks-pod-identity-agent",
    ...(spec.podIdentityAddonVersion ? { addon_version: spec.podIdentityAddonVersion } : {}),
    tags, depends_on: [group],
  });
  for (const [attribute, expression] of Object.entries({
    id: `${cluster}.id`, arn: `${cluster}.arn`, name: `${cluster}.name`, cluster_name: `${cluster}.name`,
    endpoint: `${cluster}.endpoint`, server: `${cluster}.endpoint`,
    ca_data: `${cluster}.certificate_authority[0].data`, certificate_authority_data: `${cluster}.certificate_authority[0].data`,
    oidc_issuer: `${cluster}.identity[0].oidc[0].issuer`,
  })) b.expose(attribute, expression);
  return b.build();
}

const SOURCE = "aws.eks_cluster@1";
const EKS_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const NODE_ATTRIBUTES = ["nodeGroupCount", "nodeMin", "nodeDesired", "nodeMax", "nodeVersion", "nodeInstanceTypes"] as const;
export const EKS_ATTRIBUTES = [
  "version", "endpointPrivateAccess", "endpointPublicAccess", "publicAccessCidrs",
  "logTypes", "encrypted", "kmsKeyArn", "authenticationMode",
  "bootstrapClusterCreatorAdminPermissions", "endpoint", "oidcIssuer", "status", ...NODE_ATTRIBUTES,
] as const;

export function expectedEksAttributes(node: ResourceNode): Record<string, unknown> {
  return expectedFor(node, () => {
    const spec = readSpec(node, EKS_CLUSTER_SCHEMA);
    return {
      version: spec.version, endpointPrivateAccess: true, endpointPublicAccess: spec.endpointPublicAccess,
      ...(spec.endpointPublicAccess ? { publicAccessCidrs: [...new Set(spec.publicAccessCidrs)].sort() } : {}),
      logTypes: [...EKS_LOG_TYPES].sort(), encrypted: true,
      ...(spec.kmsKeyArn ? { kmsKeyArn: spec.kmsKeyArn } : {}),
      authenticationMode: "API", bootstrapClusterCreatorAdminPermissions: false,
      nodeGroupCount: 1, nodeMin: spec.nodeMin, nodeDesired: spec.nodeDesired, nodeMax: spec.nodeMax,
      nodeVersion: spec.version, nodeInstanceTypes: [spec.nodeInstanceType],
    };
  });
}

/** Do not retain arbitrary SDK error text, which can echo request/credential data. */
async function safeRead<T>(ctx: AwsDriverContext, read: () => Promise<T>): Promise<T> {
  throwIfAborted(ctx.signal);
  try {
    const result = await read();
    throwIfAborted(ctx.signal);
    return result;
  } catch (error) {
    const failure = classifyAwsError(error, ctx.signal);
    const name = { missing: "ResourceNotFoundException", inaccessible: "AccessDeniedException",
      throttled: "ThrottlingException", aborted: "AbortError", error: "Error" }[failure.kind];
    throw Object.assign(new Error("EKS metadata read failed."), { name });
  }
}

function scopedArn(ctx: AwsDriverContext, arn: string, resource: string): boolean {
  const parsed = parseArn(arn);
  return parsed?.service === "eks" && parsed.partition === partitionOfRegion(ctx.region)
    && parsed.accountId === ctx.session.accountId && parsed.region === ctx.region && parsed.resource === resource;
}

function clusterName(ctx: AwsDriverContext, hint: string): string | undefined {
  if (EKS_NAME.test(hint)) return hint;
  const parsed = parseArn(hint);
  const name = parsed?.resource.slice("cluster/".length);
  return name && EKS_NAME.test(name) && scopedArn(ctx, hint, `cluster/${name}`) ? name : undefined;
}

type ClusterRead = { kind: "present"; cluster: Cluster; tags: Record<string, string> }
  | { kind: "missing" } | { kind: "ambiguous"; detail: string };

async function readCluster(ctx: AwsDriverContext, node: ResourceNode, externalId?: string): Promise<ClusterRead> {
  if (ctx.provider !== "aws" || node.provider !== "aws" || node.region !== ctx.region) {
    return { kind: "ambiguous", detail: "the EKS node must belong to the session's AWS region" };
  }
  let hint = externalId ?? node.externalRef;
  if (hint === undefined) {
    const { matches, truncated } = await findByTags(ctx, node, "eks:cluster");
    const arns = [...new Set(matches.filter((m) => matchesNodeTags(m.tags, ctx, node.address)).map((m) => m.arn))];
    if (truncated || arns.length !== 1) {
      return { kind: "ambiguous", detail: "the eventually-consistent tagging index did not resolve one complete unique EKS cluster" };
    }
    hint = arns[0];
  }
  const name = clusterName(ctx, hint);
  if (!name) return { kind: "ambiguous", detail: "the EKS identifier must be a cluster name or exact ARN in this account and region" };
  const client = ctx.session.client(EKSClient, { region: ctx.region });
  const { cluster } = await call(ctx, (options) => client.send(new DescribeClusterCommand({ name }), options));
  if (!cluster) return { kind: "ambiguous", detail: "DescribeCluster omitted the cluster" };
  if (cluster.name !== name || !cluster.arn || !scopedArn(ctx, cluster.arn, `cluster/${name}`)) {
    return { kind: "ambiguous", detail: "DescribeCluster returned a different cluster identifier or scope" };
  }
  const tags = cluster.tags ?? (await call(ctx, (options) => client.send(new ListTagsForResourceCommand({ resourceArn: cluster.arn }), options))).tags;
  if (node.ownership === "managed" && (!tags || !matchesNodeTags(tags, ctx, node.address))) {
    return { kind: "ambiguous", detail: "the EKS cluster's current tenant tags did not match" };
  }
  return { kind: "present", cluster, tags: tags ?? {} };
}

/** A complete, bounded inventory. Failed/ambiguous groups never become an empty healthy list. */
async function readNodegroups(ctx: AwsDriverContext, node: ResourceNode, cluster: Cluster): Promise<Nodegroup[]> {
  const client = ctx.session.client(EKSClient, { region: ctx.region });
  const { items, truncated } = await paginate(async (nextToken) => {
    const out = await call(ctx, (options) => client.send(new ListNodegroupsCommand({
      clusterName: cluster.name!, maxResults: 100, ...(nextToken ? { nextToken } : {}),
    }), options));
    if (!out.nodegroups) throw new Error("EKS nodegroup inventory was omitted.");
    return { items: out.nodegroups, next: out.nextToken };
  }, { maxPages: 5, signal: ctx.signal });
  const names = [...new Set(items)].sort();
  if (truncated || names.length > 100 || names.some((name) => !EKS_NAME.test(name))) {
    throw new Error("EKS nodegroup inventory was incomplete or invalid.");
  }
  const groups: Nodegroup[] = [];
  for (const name of names) {
    const { nodegroup: group } = await call(ctx, (options) => client.send(new DescribeNodegroupCommand({ clusterName: cluster.name!, nodegroupName: name }), options));
    const arn = group?.nodegroupArn;
    const resource = arn ? parseArn(arn)?.resource : undefined;
    if (!group || group.nodegroupName !== name || group.clusterName !== cluster.name || !arn || !resource
      || !resource.startsWith(`nodegroup/${cluster.name}/${name}/`) || resource.split("/").length !== 4
      || !/^[A-Za-z0-9-]+$/.test(resource.split("/")[3]) || !scopedArn(ctx, arn, resource)) {
      throw new Error("EKS nodegroup identity did not match.");
    }
    const tags = group.tags ?? (await call(ctx, (options) => client.send(new ListTagsForResourceCommand({ resourceArn: arn }), options))).tags;
    if (node.ownership === "managed" && (!tags || !matchesNodeTags(tags, ctx, node.address))) {
      throw new Error("EKS nodegroup tenant tags did not match.");
    }
    groups.push(group);
  }
  return groups;
}

function httpsUrl(value: unknown): boolean {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

function oidcIssuer(ctx: AwsDriverContext, value: unknown): boolean {
  if (!httpsUrl(value)) return false;
  const url = new URL(value as string);
  const suffix = partitionOfRegion(ctx.region) === "aws-cn" ? "amazonaws.com.cn" : "amazonaws.com";
  const legacy = url.hostname === `oidc.eks.${ctx.region}.${suffix}`;
  // AWS General Reference documents oidc-eks.<region>.api.aws as the
  // dual-stack issuer. China currently documents the legacy issuer only.
  const dualStack = partitionOfRegion(ctx.region) !== "aws-cn" && url.hostname === `oidc-eks.${ctx.region}.api.aws`;
  return (legacy || dualStack) && !url.port && /^\/id\/[A-Za-z0-9_-]{1,256}$/.test(url.pathname);
}

export const eksClusterDriver: ResourceDriver<AwsSession> = {
  id: SOURCE, provider: "aws", kind: "kubernetes_cluster", nativeType: "aws:eks_cluster",
  capabilities: {
    compile: true, observe: true, runtime: true, verify: true, discover: false,
    operations: [], evidence: { compile: "contract", observe: "contract", runtime: "contract", verify: "contract" },
  },
  compile: compileEksCluster,
  expectedAttributes: expectedEksAttributes,
  async observe(ctx, node, externalId) {
    return guardObserve(ctx, node, SOURCE, EKS_ATTRIBUTES, undefined, () => safeRead(ctx, async () => {
      const result = await readCluster(ctx, node, externalId);
      if (result.kind !== "present") return result;
      const { cluster: c, tags } = result;
      const a = new Attributes(ctx);
      a.set("version", c.version); a.set("status", c.status);
      a.set("endpointPrivateAccess", c.resourcesVpcConfig?.endpointPrivateAccess);
      a.set("endpointPublicAccess", c.resourcesVpcConfig?.endpointPublicAccess);
      a.set("publicAccessCidrs", c.resourcesVpcConfig?.publicAccessCidrs && [...new Set(c.resourcesVpcConfig.publicAccessCidrs)].sort());
      const logging = c.logging?.clusterLogging;
      a.set("logTypes", logging && logging.every((entry) => typeof entry.enabled === "boolean" && entry.types !== undefined)
        ? [...new Set(logging.filter((entry) => entry.enabled).flatMap((entry) => entry.types!))].sort() : undefined);
      const encryption = c.encryptionConfig?.every((entry) => entry.resources !== undefined)
        ? c.encryptionConfig.filter((entry) => entry.resources!.includes("secrets")) : undefined;
      const encryptionRead = encryption?.every((entry) => entry.provider?.keyArn !== undefined);
      a.set("encrypted", encryptionRead ? encryption!.some((entry) => KMS_KEY_ARN.test(entry.provider!.keyArn!)) : undefined);
      const key = encryption?.length === 1 ? encryption[0].provider?.keyArn : undefined;
      a.set("kmsKeyArn", encryption?.length === 0 ? null : key && KMS_KEY_ARN.test(key) ? key : undefined);
      a.set("authenticationMode", c.accessConfig?.authenticationMode);
      a.set("bootstrapClusterCreatorAdminPermissions", c.accessConfig?.bootstrapClusterCreatorAdminPermissions);
      // Identity URLs are data only. Invalid/credential-bearing URLs are never retained.
      a.set("endpoint", c.endpoint === undefined ? undefined : httpsUrl(c.endpoint) ? c.endpoint : null);
      const issuer = c.identity?.oidc?.issuer;
      a.set("oidcIssuer", issuer === undefined ? undefined : oidcIssuer(ctx, issuer) ? issuer : null);
      const groups = await attempt(() => safeRead(ctx, () => readNodegroups(ctx, node, c)), ctx.signal);
      if (!groups.ok) failAttributes(a.out, NODE_ATTRIBUTES, groups.failure);
      else {
        a.set("nodeGroupCount", groups.value.length);
        if (groups.value.length === 1) {
          const group = groups.value[0];
          a.set("nodeMin", group.scalingConfig?.minSize); a.set("nodeDesired", group.scalingConfig?.desiredSize); a.set("nodeMax", group.scalingConfig?.maxSize);
          a.set("nodeVersion", group.version);
          a.set("nodeInstanceTypes", group.instanceTypes && [...new Set(group.instanceTypes)].sort());
        }
      }
      return { kind: "present", externalId: c.arn!, attributes: a.finish(EKS_ATTRIBUTES), native: { tags, clusterName: c.name, clusterArn: c.arn } };
    }));
  },
  async runtime(ctx, node, externalId) {
    return guardRuntime(ctx, node, SOURCE, () => safeRead(ctx, async () => {
      const result = await readCluster(ctx, node, externalId);
      if (result.kind === "missing") return "missing";
      if (result.kind !== "present") return { health: "unknown", counts: {}, signals: ["cluster_unresolved"] };
      const c = result.cluster;
      const inventory = await attempt(() => safeRead(ctx, () => readNodegroups(ctx, node, c)), ctx.signal);
      const clusterFailed = c.status === "FAILED" || (c.health?.issues?.length ?? 0) > 0;
      if (!inventory.ok) return { health: clusterFailed ? "unhealthy" : "unknown", counts: {}, signals: [`nodegroups_unread:${inventory.failure.kind}`] };
      const groups = inventory.value;
      const counts: Record<string, number> = { nodegroups: groups.length };
      for (const [name, key] of [["desired", "desiredSize"], ["min", "minSize"], ["max", "maxSize"]] as const) {
        if (groups.length && groups.every((group) => Number.isInteger(group.scalingConfig?.[key]) && group.scalingConfig![key]! >= 0)) {
          counts[name] = groups.reduce((sum, group) => sum + group.scalingConfig![key]!, 0);
        }
      }
      const signals: string[] = [];
      if (c.status !== "ACTIVE") signals.push("cluster_not_active");
      if (clusterFailed) signals.push("cluster_failed");
      if (!groups.length) signals.push("no_nodegroups");
      const failed = groups.filter((group) => group.status === "CREATE_FAILED" || group.status === "DELETE_FAILED" || group.status === "DEGRADED" || (group.health?.issues?.length ?? 0) > 0);
      const unknown = groups.some((group) => !group.status || !group.health?.issues || !["ACTIVE", "CREATING", "UPDATING", "DELETING", "CREATE_FAILED", "DELETE_FAILED", "DEGRADED"].includes(group.status));
      const transitioning = groups.some((group) => ["CREATING", "UPDATING", "DELETING"].includes(group.status ?? ""));
      if (failed.length) signals.push("nodegroup_unhealthy");
      if (unknown) signals.push("nodegroup_health_unread");
      if (transitioning) signals.push("nodegroup_transitioning");
      const health: HealthState = clusterFailed || !groups.length || failed.length ? "unhealthy"
        : !c.status || !["ACTIVE", "CREATING", "UPDATING", "DELETING"].includes(c.status) || unknown ? "unknown"
        : c.status !== "ACTIVE" || transitioning ? "degraded" : "healthy";
      return { health, counts, signals };
    }));
  },
  async verify(ctx, node, observation, runtime) {
    throwIfAborted(ctx.signal);
    if (observation.address !== node.address || observation.source !== SOURCE || observation.simulated
      || (runtime && (runtime.address !== node.address || runtime.source !== SOURCE || runtime.simulated))) {
      return verificationResult(ctx, node, [{ id: "evidence_scope", description: "EKS evidence belongs to this resource", passed: "unknown" }]);
    }
    const expected = expectedEksAttributes(node);
    const result = standardVerification(ctx, node, observation, expected, "the EKS cluster");
    if (observation.presence !== "present") return result;
    return verificationResult(ctx, node, [...result.checks,
      ...(node.ownership === "managed" && Object.keys(expected).length === 0
        ? [{ id: "desired_spec", description: "the desired EKS configuration is valid", passed: "unknown" as const }] : []),
      attrCheck(observation, "cluster_active", "the EKS control plane is active", "status", (value) => value === "ACTIVE"),
      { ...attrCheck(observation, "endpoint_https", "the API endpoint is an HTTPS URL", "endpoint", httpsUrl), detail: undefined },
      { ...attrCheck(observation, "oidc_issuer", "an EKS OIDC issuer in this region is published", "oidcIssuer", (value) => oidcIssuer(ctx, value)), detail: undefined },
      { id: "nodegroup_health", description: "EKS reports healthy managed node groups",
        passed: !runtime || runtime.health === "unknown" ? "unknown" : runtime.health === "healthy" },
    ]);
  },
};
