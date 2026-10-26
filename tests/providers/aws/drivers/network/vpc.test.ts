/**
 * aws:vpc — compile (NAT modes, route tables, endpoint, flow logs, refusals)
 * and the read side (present / missing / denied / throttled / partial / ambiguous).
 */
import {
  DescribeFlowLogsCommand,
  DescribeInternetGatewaysCommand,
  DescribeNatGatewaysCommand,
  DescribeVpcAttributeCommand,
  DescribeVpcsCommand,
  EC2Client,
} from "@aws-sdk/client-ec2";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vpcDriver } from "@/lib/providers/aws/drivers/network";
import { DriverCompileError } from "@/lib/providers/aws/drivers/shared";
import type { ResourceGraph, ResourceNode } from "@/lib/resources/types";
import { compileCtx, driverCtx } from "../fixtures/env";
import { NETWORK, fixtureGraph, nodeOf } from "../fixtures/graph";

const ec2 = mockClient(EC2Client);
beforeEach(() => ec2.reset());
afterEach(() => ec2.reset());

const net = (nat: "none" | "single" | "per_az", over: Record<string, unknown> = {}): { graph: ResourceGraph; node: ResourceNode } => {
  const graph = fixtureGraph();
  const node = nodeOf(graph, NETWORK);
  node.spec = { cidr: "10.0.0.0/16", zones: 2, egress: { natGateways: nat }, ...over };
  return { graph, node };
};
const compile = (nat: "none" | "single" | "per_az", over: Record<string, unknown> = {}) => {
  const { graph, node } = net(nat, over);
  return vpcDriver.compile!(node, compileCtx(graph));
};
const types = (f: ReturnType<typeof compile>) => Object.fromEntries(Object.entries(f.resource ?? {}).map(([t, n]) => [t, Object.keys(n)]));

describe("aws:vpc compile", () => {
  it("per_az: one EIP + NAT per zone in that zone's public subnet, one private route table per zone routed to its own NAT", () => {
    const f = compile("per_az");
    const t = types(f);
    expect(t.aws_eip).toEqual(["network_main_nat_a", "network_main_nat_b"]);
    expect(t.aws_nat_gateway).toEqual(["network_main_nat_a", "network_main_nat_b"]);
    expect(t.aws_route_table).toEqual(["network_main_private_rt_a", "network_main_private_rt_b", "network_main_public_rt"]);
    const nat = f.resource!.aws_nat_gateway;
    expect(nat.network_main_nat_a.subnet_id).toBe("${local.ref_subnet_public_a__id}");
    expect(nat.network_main_nat_b.subnet_id).toBe("${local.ref_subnet_public_b__id}");
    const routes = f.resource!.aws_route;
    expect(routes.network_main_private_nat_a).toMatchObject({ route_table_id: "${aws_route_table.network_main_private_rt_a.id}", nat_gateway_id: "${aws_nat_gateway.network_main_nat_a.id}", destination_cidr_block: "0.0.0.0/0" });
    expect(routes.network_main_private_nat_b.nat_gateway_id).toBe("${aws_nat_gateway.network_main_nat_b.id}");
    expect(f.locals).toMatchObject({
      ref_network_main__private_route_table_id_a: "${aws_route_table.network_main_private_rt_a.id}",
      ref_network_main__private_route_table_id_b: "${aws_route_table.network_main_private_rt_b.id}",
    });
  });

  it("single: one NAT in zone a, one shared private route table (both zones map to it)", () => {
    const f = compile("single");
    const t = types(f);
    expect(t.aws_nat_gateway).toEqual(["network_main_nat_a"]);
    expect(t.aws_eip).toEqual(["network_main_nat_a"]);
    expect(t.aws_route_table).toEqual(["network_main_private_rt", "network_main_public_rt"]);
    expect(f.resource!.aws_route.network_main_private_nat).toMatchObject({ nat_gateway_id: "${aws_nat_gateway.network_main_nat_a.id}" });
    expect(f.locals!.ref_network_main__private_route_table_id_a).toBe(f.locals!.ref_network_main__private_route_table_id_b);
  });

  it("none: no NAT, no EIP, a private route table WITHOUT a default route", () => {
    const f = compile("none");
    const t = types(f);
    expect(t.aws_nat_gateway).toBeUndefined();
    expect(t.aws_eip).toBeUndefined();
    expect(Object.keys(f.resource!.aws_route)).toEqual(["network_main_public_igw"]);
    expect(t.aws_route_table).toContain("network_main_private_rt");
  });

  it("a missing egress block defaults to a single NAT", () => {
    const { graph, node } = net("single");
    node.spec = { cidr: "10.0.0.0/16", zones: 2 };
    expect(Object.keys(vpcDriver.compile!(node, compileCtx(graph)).resource!.aws_nat_gateway)).toEqual(["network_main_nat_a"]);
  });

  it("puts the public route table on the internet gateway and leaves the untagged default security group unmanaged", () => {
    const f = compile("per_az");
    expect(f.resource!.aws_route.network_main_public_igw).toMatchObject({ gateway_id: "${aws_internet_gateway.network_main_igw.id}", destination_cidr_block: "0.0.0.0/0" });
    // The deploy role may only modify tagged groups; AWS creates the default group untagged.
    expect(f.resource!.aws_default_security_group).toBeUndefined();
  });

  it("creates a gateway S3 endpoint on the private route tables only", () => {
    const ep = compile("per_az").resource!.aws_vpc_endpoint.network_main_s3;
    expect(ep).toMatchObject({ service_name: "com.amazonaws.us-east-1.s3", vpc_endpoint_type: "Gateway" });
    expect(ep.route_table_ids).toEqual(["${aws_route_table.network_main_private_rt_a.id}", "${aws_route_table.network_main_private_rt_b.id}"]);
  });

  it("enables DNS support and hostnames", () => {
    expect(compile("single").resource!.aws_vpc.network_main).toMatchObject({ cidr_block: "10.0.0.0/16", enable_dns_support: true, enable_dns_hostnames: true });
  });

  it("flow logs: REJECT traffic to a 30-day CloudWatch log group through a bounded service role", () => {
    const f = compile("single");
    expect(f.resource!.aws_cloudwatch_log_group.network_main_flow).toMatchObject({ name: "/zenith/acme-prod/main/vpc-flow-logs", retention_in_days: 30 });
    expect(f.resource!.aws_flow_log.network_main_flow).toMatchObject({ traffic_type: "REJECT", log_destination_type: "cloud-watch-logs", max_aggregation_interval: 600 });
    const role = f.resource!.aws_iam_role.network_main_flow as { permissions_boundary: string; assume_role_policy: string };
    expect(role.permissions_boundary).toContain("policy/ZenithAppBoundary");
    const trust = JSON.parse(role.assume_role_policy);
    expect(trust.Statement[0].Principal).toEqual({ Service: "vpc-flow-logs.amazonaws.com" });
    expect(trust.Statement[0].Condition.StringEquals["aws:SourceAccount"]).toContain("aws_caller_identity");
    const policy = JSON.parse((f.resource!.aws_iam_role_policy.network_main_flow as { policy: string }).policy);
    const stmt = policy.Statement[0];
    expect(stmt.Action).toEqual(["logs:CreateLogStream", "logs:DescribeLogStreams", "logs:PutLogEvents"]);
    expect(stmt.Action.some((a: string) => a.includes("*"))).toBe(false);
    expect(stmt.Resource).not.toContain("*");
    expect(stmt.Resource.every((r: string) => r.includes("aws_cloudwatch_log_group.network_main_flow.arn"))).toBe(true);
  });

  it("tags every taggable resource with the Zenith tags and this node's address", () => {
    const f = compile("per_az");
    for (const [type, named] of Object.entries(f.resource!)) {
      if (["aws_iam_role_policy", "aws_route", "aws_route_table_association"].includes(type)) continue;
      for (const [name, body] of Object.entries(named)) {
        const tags = body.tags as Record<string, string> | undefined;
        expect(tags, `${type}.${name}`).toBeDefined();
        expect(tags!["zenith:resource"]).toBe(NETWORK);
        expect(tags!["zenith:environment"]).toBe("env_prod");
        expect(tags!["zenith:managed"]).toBe("true");
      }
    }
  });

  it("lists the primary resource first and every address it claims is defined", () => {
    const f = compile("per_az");
    expect(f.addresses[0]).toBe("aws_vpc.network_main");
    const defined = new Set([...Object.entries(f.resource ?? {}).flatMap(([t, n]) => Object.keys(n).map((k) => `${t}.${k}`)), ...Object.entries(f.data ?? {}).flatMap(([t, n]) => Object.keys(n).map((k) => `data.${t}.${k}`))]);
    expect(new Set(f.addresses)).toEqual(defined);
  });

  it("publishes id, arn, cidr, gateway and route-table attributes for other nodes", () => {
    expect(Object.keys(compile("per_az").locals!)).toEqual(
      expect.arrayContaining(["ref_network_main__id", "ref_network_main__arn", "ref_network_main__cidr_block", "ref_network_main__internet_gateway_id", "ref_network_main__public_route_table_id"])
    );
  });

  it("is deterministic", () => {
    expect(JSON.stringify(compile("per_az"))).toBe(JSON.stringify(compile("per_az")));
  });

  it("refuses specs AWS would reject", () => {
    for (const bad of [{ cidr: "10.0.0.0/8" }, { cidr: "10.0.0.0/29" }, { cidr: "10.0.0.5/16" }, { cidr: "banana" }, { cidr: undefined }, { zones: 0 }, { zones: 7 }, { zones: 1.5 }]) {
      expect(() => compile("single", bad), JSON.stringify(bad)).toThrow(DriverCompileError);
    }
    const { graph, node } = net("single");
    node.spec = { cidr: "10.0.0.0/16", zones: 2, egress: { natGateways: "lots" } };
    expect(() => vpcDriver.compile!(node, compileCtx(graph))).toThrow(/natGateways/);
  });

  it("refuses to create a VPC for a referenced network, and to place NATs in subnets the graph does not have", () => {
    const { graph, node } = net("single");
    expect(() => vpcDriver.compile!({ ...node, ownership: "referenced" }, compileCtx(graph))).toThrow(/does not create a VPC/);
    const missing = fixtureGraph();
    missing.nodes = missing.nodes.filter((n) => n.address !== "subnet/public-a");
    expect(() => vpcDriver.compile!(nodeOf(missing, NETWORK), compileCtx(missing))).toThrow(/public subnet subnet\/public-a/);
  });
});

/* ---------------------------------- reads ---------------------------------- */

const VPC_ID = "vpc-0abc1234def567890";
/** EC2 reports a usable IGW attachment as `available`; the SDK enum only lists `attached`. The driver accepts both. */
const IGW_AVAILABLE = "available" as unknown as "attached";
const tags = [
  { Key: "zenith:workspace", Value: "ws_acme" },
  { Key: "zenith:environment", Value: "env_prod" },
  { Key: "zenith:resource", Value: NETWORK },
  { Key: "zenith:managed", Value: "true" },
  { Key: "Name", Value: "acme-prod-vpc-main" },
];
const node = () => nodeOf(fixtureGraph(), NETWORK); // per_az, 2 zones → 2 NATs

function healthyVpc() {
  ec2.on(DescribeVpcsCommand).resolves({ Vpcs: [{ VpcId: VPC_ID, CidrBlock: "10.0.0.0/16", State: "available", IsDefault: false, OwnerId: "123456789012", Tags: tags }] });
  ec2.on(DescribeVpcAttributeCommand, { Attribute: "enableDnsSupport" }).resolves({ EnableDnsSupport: { Value: true } });
  ec2.on(DescribeVpcAttributeCommand, { Attribute: "enableDnsHostnames" }).resolves({ EnableDnsHostnames: { Value: true } });
  ec2.on(DescribeInternetGatewaysCommand).resolves({ InternetGateways: [{ InternetGatewayId: "igw-1", Attachments: [{ VpcId: VPC_ID, State: IGW_AVAILABLE }] }] });
  ec2.on(DescribeNatGatewaysCommand).resolves({
    NatGateways: [
      { NatGatewayId: "nat-a", State: "available", SubnetId: "subnet-a" },
      { NatGatewayId: "nat-b", State: "available", SubnetId: "subnet-b" },
      { NatGatewayId: "nat-old", State: "deleted", SubnetId: "subnet-a" },
    ],
  });
  ec2.on(DescribeFlowLogsCommand).resolves({ FlowLogs: [{ FlowLogId: "fl-1", FlowLogStatus: "ACTIVE", LogDestinationType: "cloud-watch-logs" }] });
}

describe("aws:vpc observe", () => {
  it("reports every expected attribute as known, the VPC id as externalId, and the tags in native", async () => {
    healthyVpc();
    const obs = await vpcDriver.observe!(driverCtx(), node());
    expect(obs.presence).toBe("present");
    expect(obs.externalId).toBe(VPC_ID);
    expect(obs.source).toBe("aws.vpc@1");
    expect(obs.simulated).toBe(false);
    const values = Object.fromEntries(Object.entries(obs.attributes).map(([k, v]) => [k, v.state === "known" ? v.value : `unknown:${v.reason}`]));
    expect(values).toEqual({ cidr: "10.0.0.0/16", dnsSupport: true, dnsHostnames: true, internetGatewayAttached: true, natGateways: 2, flowLogsActive: true });
    expect(obs.native).toMatchObject({ vpcId: VPC_ID, state: "available", taggedForThisNode: true });
    expect((obs.native!.tags as Record<string, string>)["zenith:environment"]).toBe("env_prod");
  });

  it("expectedAttributes names exactly the attributes observe reads, in the same units", async () => {
    healthyVpc();
    const obs = await vpcDriver.observe!(driverCtx(), node());
    const expected = vpcDriver.expectedAttributes!(node());
    expect(Object.keys(expected).sort()).toEqual(Object.keys(obs.attributes).sort());
    for (const [k, v] of Object.entries(obs.attributes)) expect(v.state === "known" && v.value).toEqual(expected[k]);
  });

  it("finds the VPC by the Zenith tags when no externalId is known, and by id when one is", async () => {
    healthyVpc();
    await vpcDriver.observe!(driverCtx(), node());
    const byTags = ec2.commandCalls(DescribeVpcsCommand)[0].args[0].input;
    expect(byTags.Filters).toEqual(
      expect.arrayContaining([
        { Name: "tag:zenith:resource", Values: [NETWORK] },
        { Name: "tag:zenith:environment", Values: ["env_prod"] },
        { Name: "tag:zenith:workspace", Values: ["ws_acme"] },
      ])
    );
    expect(byTags.VpcIds).toBeUndefined();
    ec2.resetHistory();
    await vpcDriver.observe!(driverCtx(), node(), VPC_ID);
    expect(ec2.commandCalls(DescribeVpcsCommand)[0].args[0].input).toEqual({ VpcIds: [VPC_ID] });
    ec2.resetHistory();
    await vpcDriver.observe!(driverCtx(), node(), "vpc-; rm -rf /"); // not an id: ignored, tags used
    expect(ec2.commandCalls(DescribeVpcsCommand)[0].args[0].input.VpcIds).toBeUndefined();
  });

  it("counts only pending/available NAT gateways and only attached internet gateways", async () => {
    healthyVpc();
    ec2.on(DescribeNatGatewaysCommand).resolves({ NatGateways: [{ NatGatewayId: "nat-a", State: "available" }, { NatGatewayId: "nat-b", State: "failed" }, { NatGatewayId: "nat-c", State: "deleting" }] });
    ec2.on(DescribeInternetGatewaysCommand).resolves({ InternetGateways: [{ InternetGatewayId: "igw-1", Attachments: [{ VpcId: VPC_ID, State: "detaching" }] }] });
    const obs = await vpcDriver.observe!(driverCtx(), node());
    expect(obs.attributes.natGateways).toMatchObject({ state: "known", value: 1 });
    expect(obs.attributes.internetGatewayAttached).toMatchObject({ state: "known", value: false });
  });

  it("missing: the API found no VPC", async () => {
    ec2.on(DescribeVpcsCommand).resolves({ Vpcs: [] });
    const obs = await vpcDriver.observe!(driverCtx(), node());
    expect(obs.presence).toBe("missing");
    expect(obs.externalId).toBeUndefined();
    expect(Object.values(obs.attributes).every((v) => v.state === "unknown" && v.reason === "not_applicable")).toBe(true);
  });

  it("a NotFound from the API when asked by id is also missing", async () => {
    ec2.on(DescribeVpcsCommand).rejects(Object.assign(new Error("The vpc ID does not exist"), { name: "InvalidVpcID.NotFound" }));
    expect((await vpcDriver.observe!(driverCtx(), node(), VPC_ID)).presence).toBe("missing");
  });

  it("AccessDenied: inaccessible, every attribute unknown with access_denied, never 'matches'", async () => {
    ec2.on(DescribeVpcsCommand).rejects(Object.assign(new Error("not authorized to perform ec2:DescribeVpcs"), { name: "UnauthorizedOperation", $metadata: { httpStatusCode: 403, requestId: "r-1" } }));
    const obs = await vpcDriver.observe!(driverCtx(), node());
    expect(obs.presence).toBe("inaccessible");
    expect(Object.values(obs.attributes).every((v) => v.state === "unknown" && v.reason === "access_denied")).toBe(true);
    expect(obs.error).toContain("UnauthorizedOperation");
  });

  it("throttled: unknown presence and unknown attributes (not missing, not denied)", async () => {
    ec2.on(DescribeVpcsCommand).rejects(Object.assign(new Error("Request limit exceeded."), { name: "RequestLimitExceeded", $metadata: { httpStatusCode: 503 } }));
    const obs = await vpcDriver.observe!(driverCtx(), node());
    expect(obs.presence).toBe("unknown");
    expect(Object.values(obs.attributes).every((v) => v.state === "unknown" && v.reason === "error")).toBe(true);
  });

  it("partial data: one denied read makes only ITS attribute unknown", async () => {
    healthyVpc();
    ec2.on(DescribeNatGatewaysCommand).rejects(Object.assign(new Error("denied"), { name: "UnauthorizedOperation", $metadata: { httpStatusCode: 403 } }));
    ec2.on(DescribeVpcAttributeCommand, { Attribute: "enableDnsHostnames" }).rejects(Object.assign(new Error("slow down"), { name: "Throttling" }));
    const obs = await vpcDriver.observe!(driverCtx(), node());
    expect(obs.presence).toBe("present");
    expect(obs.attributes.natGateways).toMatchObject({ state: "unknown", reason: "access_denied" });
    expect(obs.attributes.dnsHostnames).toMatchObject({ state: "unknown", reason: "error" });
    expect(obs.attributes.cidr).toMatchObject({ state: "known", value: "10.0.0.0/16" });
    expect(obs.attributes.dnsSupport).toMatchObject({ state: "known", value: true });
  });

  it("two VPCs with the same Zenith tags are ambiguous: unknown, not resolved by picking one", async () => {
    ec2.on(DescribeVpcsCommand).resolves({ Vpcs: [{ VpcId: "vpc-0000000a", Tags: tags }, { VpcId: "vpc-0000000b", Tags: tags }] });
    const obs = await vpcDriver.observe!(driverCtx(), node());
    expect(obs.presence).toBe("unknown");
    expect(obs.externalId).toBeUndefined();
    expect(obs.error).toMatch(/2 VPCs/);
  });

  it("an aborted signal is an AbortError, not an observation", async () => {
    const c = new AbortController();
    c.abort();
    ec2.on(DescribeVpcsCommand).rejects(Object.assign(new Error("aborted"), { name: "AbortError" }));
    await expect(vpcDriver.observe!(driverCtx({ signal: c.signal }), node())).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("aws:vpc verify and discover", () => {
  it("passes when everything matches and the VPC is available", async () => {
    healthyVpc();
    const ctx = driverCtx();
    const obs = await vpcDriver.observe!(ctx, node());
    const v = await vpcDriver.verify!(ctx, node(), obs);
    expect(v.status).toBe("passed");
    expect(v.checks.map((c) => c.id)).toEqual(["exists", "attr:cidr", "attr:dnsHostnames", "attr:dnsSupport", "attr:flowLogsActive", "attr:internetGatewayAttached", "attr:natGateways", "vpc_available"]);
    expect(v.simulated).toBe(false);
  });

  it("fails naming both sides when a NAT gateway is gone", async () => {
    healthyVpc();
    ec2.on(DescribeNatGatewaysCommand).resolves({ NatGateways: [{ NatGatewayId: "nat-a", State: "available" }] });
    const ctx = driverCtx();
    const v = await vpcDriver.verify!(ctx, node(), await vpcDriver.observe!(ctx, node()));
    expect(v.status).toBe("failed");
    expect(v.checks.find((c) => c.id === "attr:natGateways")).toMatchObject({ passed: false, detail: "desired 2, observed 1" });
  });

  it("is unknown (not passed) when a read was denied, and failed when the VPC is missing", async () => {
    healthyVpc();
    ec2.on(DescribeFlowLogsCommand).rejects(Object.assign(new Error("denied"), { name: "UnauthorizedOperation" }));
    const ctx = driverCtx();
    const partial = await vpcDriver.verify!(ctx, node(), await vpcDriver.observe!(ctx, node()));
    expect(partial.status).toBe("unknown");
    expect(partial.checks.find((c) => c.id === "attr:flowLogsActive")?.passed).toBe("unknown");
    ec2.on(DescribeVpcsCommand).resolves({ Vpcs: [] });
    const gone = await vpcDriver.verify!(ctx, node(), await vpcDriver.observe!(ctx, node()));
    expect(gone.status).toBe("failed");
    expect(gone.checks).toHaveLength(1);
  });

  it("discovers VPCs across pages and marks the Zenith-tagged ones without adopting anything", async () => {
    ec2
      .on(DescribeVpcsCommand)
      .resolvesOnce({ Vpcs: [{ VpcId: "vpc-default1", CidrBlock: "172.31.0.0/16", IsDefault: true, State: "available" }], NextToken: "p2" })
      .resolvesOnce({ Vpcs: [{ VpcId: VPC_ID, CidrBlock: "10.0.0.0/16", State: "available", Tags: tags }] });
    const found = await vpcDriver.discover!(driverCtx());
    expect(found.map((f) => [f.externalId, f.zenithTagged, f.name])).toEqual([
      ["vpc-default1", false, "vpc-default1"],
      [VPC_ID, true, "acme-prod-vpc-main"],
    ]);
    expect(found[0]).toMatchObject({ provider: "aws", kind: "network", nativeType: "aws:vpc", region: "us-east-1" });
  });

  it("declares contract evidence only, and no operations", () => {
    expect(vpcDriver.id).toBe("aws.vpc@1");
    expect(Object.values(vpcDriver.capabilities.evidence).every((e) => e === "contract")).toBe(true);
    expect(vpcDriver.capabilities.operations).toEqual([]);
  });
});
