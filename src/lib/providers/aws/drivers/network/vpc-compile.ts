/**
 * `aws:vpc` compile: a VPC and everything that makes its subnets usable.
 *
 * Emitted for one `network` node (spec: `cidr`, `zones`, `egress.natGateways`):
 *
 *   aws_vpc                         DNS support + hostnames on
 *   (the VPC's default security group is left as AWS creates it: it is untagged, so the deploy role
 *    cannot manage it without being able to claim any group; no Zenith resource attaches to it)
 *   aws_internet_gateway            + public route table → 0.0.0.0/0 via the gateway
 *   private route tables            `per_az`: one per zone, each routed to that zone's
 *                                   NAT; `single`: one shared table routed to the single
 *                                   NAT (placed in zone `a`); `none`: one shared table
 *                                   with no default route (isolated)
 *   aws_eip + aws_nat_gateway       one per NAT, in the PUBLIC subnet of its zone
 *   aws_vpc_endpoint (S3, gateway)  on every private route table: S3 traffic never
 *                                   crosses a NAT gateway; free of charge
 *   flow logs                       REJECT traffic only, to a CloudWatch log group
 *                                   (30-day retention) through a service role
 *
 * Cost (approximate list prices, us-east-1, verify against current AWS pricing):
 *   - NAT gateway: ~US$0.045/hour (~US$33/month) each PLUS ~US$0.045 per GB it
 *     processes, plus ~US$0.005/hour (~US$3.65/month) for its public IPv4. `per_az`
 *     multiplies that by the zone count; `single` is cheaper but loses egress if
 *     its zone fails.
 *   - Interface endpoints (ECR, CloudWatch Logs, Secrets Manager, …) are NOT
 *     created (~US$7–8/month per endpoint per zone): with `natGateways: none`,
 *     private workloads cannot pull images or ship logs. Only S3 has an endpoint.
 *   - Flow logs: REJECT-only keeps ingestion tiny (CloudWatch vended-log ingestion
 *     is ~US$0.50/GB; 30-day storage ~US$0.03/GB-month). REJECT is also the
 *     traffic that explains a broken security group. Switching to ALL traffic is a
 *     one-word change (`traffic_type`) and can cost far more on a busy VPC.
 *
 * The flow-log service role carries the `ZenithAppBoundary` permission
 * boundary (DRIVER-CONVENTIONS). ASSUMPTION, unverified against a live account:
 * that managed policy exists in the account (created by the customer bootstrap)
 * and permits logs:CreateLogStream / DescribeLogStreams / PutLogEvents on the
 * flow-log group; otherwise apply fails at the role or logs go undelivered.
 *
 * Published for other nodes (`ctx.ref(<network address>, …)`): `id`, `arn`,
 * `cidr_block`, `internet_gateway_id`, `public_route_table_id`,
 * `private_route_table_id:<zone letter>` (every zone letter, whatever the NAT mode).
 */
import { AWS_ROLE_BOUNDARIES, awsBoundaryArn, trustedAwsBoundaryArn } from "@/lib/credentials/aws/naming";
import type { CompileContext, TofuFragment } from "@/lib/drivers/types";
import type { NetworkSpec } from "@/lib/resources/specs";
import type { ResourceNode } from "@/lib/resources/types";
import { DriverCompileError, FragmentBuilder, cloudName, nodeName, privateRouteTableAttribute, REF, refExpr, resourceTags, tfLabel } from "../shared";
import { parseCidr } from "./cidr";
import { requireSubnet, zoneLetters } from "./zones";

export const FLOW_LOG_RETENTION_DAYS = 30;
export const FLOW_LOG_TRAFFIC_TYPE = "REJECT";
export const PERMISSIONS_BOUNDARY_NAME = AWS_ROLE_BOUNDARIES.app.policyName;
export type NatMode = "none" | "single" | "per_az";

export interface ValidNetworkSpec {
  cidr: string;
  zones: number;
  natGateways: NatMode;
}

/** Validate the network spec; throws `DriverCompileError` for anything AWS would reject at apply. */
export function readNetworkSpec(node: ResourceNode): ValidNetworkSpec {
  const spec = node.spec as Partial<NetworkSpec>;
  const cidr = parseCidr(spec.cidr);
  if (!cidr) throw new DriverCompileError("invalid_spec", node.address, `spec.cidr must be a canonical IPv4 CIDR such as 10.0.0.0/16, got ${JSON.stringify(spec.cidr)}.`);
  if (cidr.prefix < 16 || cidr.prefix > 28) throw new DriverCompileError("invalid_spec", node.address, `a VPC CIDR must be between /16 and /28, got /${cidr.prefix}.`);
  const zones = spec.zones;
  if (typeof zones !== "number" || !Number.isInteger(zones) || zones < 1 || zones > 6) {
    throw new DriverCompileError("invalid_spec", node.address, `spec.zones must be an integer from 1 to 6, got ${JSON.stringify(zones)}.`);
  }
  const nat = spec.egress?.natGateways ?? "single";
  if (nat !== "none" && nat !== "single" && nat !== "per_az") {
    throw new DriverCompileError("invalid_spec", node.address, `spec.egress.natGateways must be none, single or per_az, got ${JSON.stringify(nat)}.`);
  }
  return { cidr: spec.cidr as string, zones, natGateways: nat };
}

/** The zone letters that host a NAT gateway for this mode. */
export function natZones(mode: NatMode, zones: number): string[] {
  const letters = zoneLetters(zones);
  return mode === "per_az" ? letters : mode === "single" ? letters.slice(0, 1) : [];
}

/** The number of NAT gateways a spec asks for (the driver's `natGateways` expected attribute). */
export function natGatewayCount(spec: { zones: number; egress?: { natGateways?: string } }): number {
  const mode = spec.egress?.natGateways ?? "single";
  return mode === "per_az" ? Math.min(spec.zones, 6) : mode === "single" ? 1 : 0;
}

const json = (v: unknown): string => JSON.stringify(v);

export function compileVpc(node: ResourceNode, ctx: CompileContext): TofuFragment {
  if (node.ownership !== "managed") throw new DriverCompileError("policy_refused", node.address, `Zenith does not create a VPC for a ${node.ownership} network.`);
  const spec = readNetworkSpec(node);
  const L = tfLabel(node.address);
  const region = ctx.region;
  const name = cloudName(ctx.namePrefix, `vpc-${nodeName(node.address)}`, 255);
  const tag = (suffix?: string) => resourceTags(ctx.tags, node.address, suffix ? cloudName(ctx.namePrefix, `${nodeName(node.address)}-${suffix}`, 255) : name);
  const letters = zoneLetters(spec.zones);
  const nat = new Set(natZones(spec.natGateways, spec.zones));

  const b = new FragmentBuilder(node.address);

  // --- the VPC (primary) ---
  b.resource("aws_vpc", L, {
    cidr_block: spec.cidr,
    enable_dns_support: true,
    enable_dns_hostnames: true,
    instance_tenancy: "default",
    tags: tag(),
  });
  b.expose(REF.id, `aws_vpc.${L}.id`);
  b.expose(REF.arn, `aws_vpc.${L}.arn`);
  b.expose("cidr_block", `aws_vpc.${L}.cidr_block`);
  const vpcId = `\${aws_vpc.${L}.id}`;

  // --- internet gateway and the public route table ---
  b.resource("aws_internet_gateway", `${L}_igw`, { vpc_id: vpcId, tags: tag("igw") });
  b.expose(REF.internetGatewayId, `aws_internet_gateway.${L}_igw.id`);
  b.resource("aws_route_table", `${L}_public_rt`, { vpc_id: vpcId, tags: tag("public") });
  b.resource("aws_route", `${L}_public_igw`, {
    route_table_id: `\${aws_route_table.${L}_public_rt.id}`,
    destination_cidr_block: "0.0.0.0/0",
    gateway_id: `\${aws_internet_gateway.${L}_igw.id}`,
  });
  b.expose(REF.publicRouteTableId, `aws_route_table.${L}_public_rt.id`);

  // --- NAT gateways, each in the public subnet of its zone ---
  for (const z of letters) {
    if (!nat.has(z)) continue;
    const publicSubnet = requireSubnet(ctx, node.address, node.address, "public", z);
    b.resource("aws_eip", `${L}_nat_${z}`, { domain: "vpc", tags: tag(`nat-${z}`), depends_on: [`aws_internet_gateway.${L}_igw`] });
    b.resource("aws_nat_gateway", `${L}_nat_${z}`, {
      allocation_id: `\${aws_eip.${L}_nat_${z}.id}`,
      subnet_id: refExpr(ctx.ref(publicSubnet.address, REF.id)),
      tags: tag(`nat-${z}`),
      depends_on: [`aws_internet_gateway.${L}_igw`],
    });
  }

  // --- private route tables ---
  const privateTables: string[] = [];
  if (spec.natGateways === "per_az") {
    for (const z of letters) {
      const rt = `${L}_private_rt_${z}`;
      b.resource("aws_route_table", rt, { vpc_id: vpcId, tags: tag(`private-${z}`) });
      b.resource("aws_route", `${L}_private_nat_${z}`, { route_table_id: `\${aws_route_table.${rt}.id}`, destination_cidr_block: "0.0.0.0/0", nat_gateway_id: `\${aws_nat_gateway.${L}_nat_${z}.id}` });
      b.expose(privateRouteTableAttribute(z), `aws_route_table.${rt}.id`);
      privateTables.push(`aws_route_table.${rt}.id`);
    }
  } else {
    const rt = `${L}_private_rt`;
    b.resource("aws_route_table", rt, { vpc_id: vpcId, tags: tag("private") });
    if (spec.natGateways === "single") {
      b.resource("aws_route", `${L}_private_nat`, { route_table_id: `\${aws_route_table.${rt}.id}`, destination_cidr_block: "0.0.0.0/0", nat_gateway_id: `\${aws_nat_gateway.${L}_nat_a.id}` });
    }
    for (const z of letters) b.expose(privateRouteTableAttribute(z), `aws_route_table.${rt}.id`);
    privateTables.push(`aws_route_table.${rt}.id`);
  }

  // --- S3 gateway endpoint on the private route tables ---
  b.resource("aws_vpc_endpoint", `${L}_s3`, {
    vpc_id: vpcId,
    service_name: `com.amazonaws.${region}.s3`,
    vpc_endpoint_type: "Gateway",
    route_table_ids: privateTables.map((t) => `\${${t}}`),
    tags: tag("s3-endpoint"),
  });

  // --- flow logs (REJECT only) ---
  const safe = (x: string) => x.replace(/[^A-Za-z0-9._-]/g, "-");
  const logGroupName = `/zenith/${safe(ctx.namePrefix)}/${safe(nodeName(node.address))}/vpc-flow-logs`;
  const flow = `${L}_flow`;
  const account = `\${data.aws_caller_identity.${L}_identity.account_id}`;
  const partition = `\${data.aws_partition.${L}_partition.partition}`;
  b.data("aws_caller_identity", `${L}_identity`, {});
  b.data("aws_partition", `${L}_partition`, {});
  b.resource("aws_cloudwatch_log_group", flow, { name: logGroupName, retention_in_days: FLOW_LOG_RETENTION_DAYS, tags: tag("flow-logs") });
  const assumeRole = {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { Service: "vpc-flow-logs.amazonaws.com" },
        Action: "sts:AssumeRole",
        Condition: {
          StringEquals: { "aws:SourceAccount": account },
          ArnLike: { "aws:SourceArn": `arn:${partition}:ec2:${region}:${account}:vpc-flow-log/*` },
        },
      },
    ],
  };
  b.resource("aws_iam_role", flow, {
    name: `${cloudName(ctx.namePrefix, `flowlogs-${nodeName(node.address)}`, 64 - "-flow".length)}-flow`,
    assume_role_policy: json(assumeRole),
    permissions_boundary: trustedAwsBoundaryArn(ctx.awsBootstrap, "app") ?? awsBoundaryArn("app", partition, account),
    tags: tag("flow-logs-role"),
  });
  const logGroupArn = `\${aws_cloudwatch_log_group.${flow}.arn}`;
  b.resource("aws_iam_role_policy", flow, {
    name: "deliver-flow-logs",
    role: `\${aws_iam_role.${flow}.id}`,
    policy: json({
      Version: "2012-10-17",
      Statement: [{ Effect: "Allow", Action: ["logs:CreateLogStream", "logs:DescribeLogStreams", "logs:PutLogEvents"], Resource: [logGroupArn, `${logGroupArn}:*`] }],
    }),
  });
  b.resource("aws_flow_log", flow, {
    vpc_id: vpcId,
    traffic_type: FLOW_LOG_TRAFFIC_TYPE,
    log_destination_type: "cloud-watch-logs",
    log_destination: logGroupArn,
    iam_role_arn: `\${aws_iam_role.${flow}.arn}`,
    max_aggregation_interval: 600,
    tags: tag("flow-logs"),
    depends_on: [`aws_iam_role_policy.${flow}`],
  });

  return b.build();
}
