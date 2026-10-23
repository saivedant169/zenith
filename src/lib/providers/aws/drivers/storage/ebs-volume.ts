/**
 * Standalone encrypted gp3 EBS volumes. An AZ is explicit or derived from ONE
 * graph subnet. Attachments exist only for spec.instance, never by guessing a
 * compute dependency. Attachment and volume share an AZ by construction.
 * deny/approval prevent destruction (including detachment); allow releases the
 * tofu guard, while approval authorization remains the control plane's job.
 * Reads use the EC2 SDK through the broker; no credentials or volume data are
 * read. Contract evidence only, no live AWS acceptance has been performed.
 */
import { z } from "zod";
import { DescribeVolumesCommand, EC2Client } from "@aws-sdk/client-ec2";
import type { AwsSession } from "@/lib/credentials/types";
import type { CompileContext, ResourceDriver, TofuFragment } from "@/lib/drivers/types";
import type { ResourceNode } from "@/lib/resources/types";
import {
  DriverCompileError, FragmentBuilder, ec2TagFilters, fromAwsTagList, matchesNodeTags,
  paginate, refExpr, resourceTags, standardVerification, subnetsOf, tfLabel, verificationResult,
} from "@/lib/providers/aws/drivers/shared";
import { Attributes, call, expectedFor, guardObserve } from "@/lib/providers/aws/drivers/data/support";
import { assertAwsNode, KMS_KEY_ARN, neighbour, readSpec } from "@/lib/providers/aws/drivers/messaging/support";

const SOURCE = "aws.ebs_volume@1";
export const EBS_VOLUME_SCHEMA = z.object({
  sizeGb: z.number().int().min(1).max(16384),
  storageClass: z.literal("gp3").optional(),
  encryption: z.literal(true).optional(),
  encrypted: z.literal(true).optional(),
  kmsKeyArn: z.string().regex(KMS_KEY_ARN).optional(),
  availabilityZone: z.string().regex(/^[a-z]{2}(?:-[a-z]+)+-\d[a-z]$/).optional(),
  deletionPolicy: z.enum(["deny", "approval", "allow"]).prefault("deny"),
  instance: z.string().min(1).max(256).optional(),
  deviceName: z.string().regex(/^\/dev\/sd[f-p]$/).prefault("/dev/sdf"),
}).strict();
export type EbsVolumeSpec = z.input<typeof EBS_VOLUME_SCHEMA>;

export function compileEbsVolume(node: ResourceNode, ctx: CompileContext): TofuFragment {
  if (node.ownership !== "managed") return { addresses: [] };
  assertAwsNode(node, ctx);
  const spec = readSpec(node, EBS_VOLUME_SCHEMA);
  if (spec.availabilityZone && spec.availabilityZone.slice(0, -1) !== node.region) {
    throw new DriverCompileError("invalid_spec", node.address, "availabilityZone must belong to the volume's region.");
  }
  if (spec.kmsKeyArn && !spec.kmsKeyArn.includes(`:kms:${node.region}:`)) {
    throw new DriverCompileError("invalid_spec", node.address, "the volume encryption key must be in the volume's region.");
  }
  const subnets = subnetsOf(node, ctx);
  if (subnets.length > 1) throw new DriverCompileError("invalid_spec", node.address, "a volume must name at most one placement subnet.");
  if (subnets[0]) neighbour(node, ctx, subnets[0].address, "aws:subnet");
  const instance = spec.instance ? neighbour(node, ctx, spec.instance, "aws:ec2_instance") : undefined;
  if (instance && instance.ownership !== "managed") {
    throw new DriverCompileError("policy_refused", node.address, "volume attachments require a managed EC2 instance with a published AZ.");
  }
  let instanceSubnet: ResourceNode | undefined;
  if (instance) {
    // EC2's existing driver selects the first sorted private subnet.
    instanceSubnet = subnetsOf(instance, ctx, "private")[0];
    if (!instanceSubnet) throw new DriverCompileError("missing_node", node.address, "the named instance needs a private placement subnet.");
    neighbour(node, ctx, instanceSubnet.address, "aws:subnet");
    if (subnets[0] && subnets[0].address !== instanceSubnet.address) {
      throw new DriverCompileError("invalid_spec", node.address, "the volume and instance must use the same placement subnet.");
    }
  }
  const subnet = instanceSubnet ?? subnets[0];
  if (!subnet && !spec.availabilityZone) {
    throw new DriverCompileError("missing_node", node.address, "a volume requires an availabilityZone, one placement subnet, or a named instance.");
  }
  const label = tfLabel(node.address);
  const b = new FragmentBuilder(node.address);
  const volume = `aws_ebs_volume.${label}`;
  const az = subnet ? refExpr(ctx.ref(subnet.address, "availability_zone")) : spec.availabilityZone!;
  // If an explicit AZ accompanies a symbolic subnet, enforce agreement at plan
  // time; an account's AZ letters cannot safely be guessed in the compiler.
  const preconditions = spec.availabilityZone && subnet ? [{ condition: `\${${az.slice(2, -1)} == ${JSON.stringify(spec.availabilityZone)}}`, error_message: "The declared volume AZ differs from the placement subnet AZ." }] : [];
  b.resource("aws_ebs_volume", label, {
    availability_zone: az, size: spec.sizeGb, type: "gp3", encrypted: true,
    ...(spec.kmsKeyArn ? { kms_key_id: spec.kmsKeyArn } : {}),
    tags: resourceTags(ctx.tags, node.address),
    lifecycle: { prevent_destroy: spec.deletionPolicy !== "allow", ...(preconditions.length ? { precondition: preconditions } : {}) },
  });
  if (instance) {
    b.resource("aws_volume_attachment", `${label}_attachment`, {
      device_name: spec.deviceName, volume_id: refExpr(`${volume}.id`),
      instance_id: refExpr(ctx.ref(instance.address, "id")),
      force_detach: false, stop_instance_before_detaching: true,
      lifecycle: { prevent_destroy: spec.deletionPolicy !== "allow" },
    });
  }
  b.expose("id", `${volume}.id`);
  b.expose("arn", `${volume}.arn`);
  b.expose("availability_zone", `${volume}.availability_zone`);
  return b.build();
}

export const EBS_ATTRIBUTES = ["sizeGb", "storageClass", "encrypted", "availabilityZone", "kmsKeyArn", "attachments", "attachmentCount", "deviceName", "state"] as const;
export function expectedEbsAttributes(node: ResourceNode): Record<string, unknown> {
  return expectedFor(node, () => {
    const spec = readSpec(node, EBS_VOLUME_SCHEMA);
    return { sizeGb: spec.sizeGb, storageClass: "gp3", encrypted: true, attachmentCount: spec.instance ? 1 : 0,
      ...(spec.instance ? { deviceName: spec.deviceName } : {}),
      ...(spec.availabilityZone ? { availabilityZone: spec.availabilityZone } : {}),
      ...(spec.kmsKeyArn ? { kmsKeyArn: spec.kmsKeyArn } : {}),
    };
  });
}

export const ebsVolumeDriver: ResourceDriver<AwsSession> = {
  id: SOURCE, provider: "aws", kind: "volume", nativeType: "aws:ebs_volume",
  capabilities: {
    compile: true, observe: true, verify: true, runtime: false, discover: false,
    operations: [], evidence: { compile: "contract", observe: "contract", verify: "contract" },
  },
  compile: compileEbsVolume,
  expectedAttributes: expectedEbsAttributes,
  async observe(ctx, node, externalId) {
    return guardObserve(ctx, node, SOURCE, EBS_ATTRIBUTES, undefined, async () => {
      const hint = externalId ?? node.externalRef;
      if (hint !== undefined && !/^vol-(?:[0-9a-f]{8}|[0-9a-f]{17})$/.test(hint)) {
        return { kind: "ambiguous", detail: "externalId must be an EBS volume id" };
      }
      const client = ctx.session.client(EC2Client);
      const { items, truncated } = await paginate(async (token) => {
        const out = await call(ctx, (o) => client.send(new DescribeVolumesCommand(hint ? { VolumeIds: [hint] }
          : { Filters: ec2TagFilters(ctx, node.address), MaxResults: 100, ...(token ? { NextToken: token } : {}) }), o));
        return { items: out.Volumes ?? [], next: out.NextToken };
      }, { maxPages: 5, signal: ctx.signal });
      if (truncated || items.length > 1) return { kind: "ambiguous", detail: "the volume lookup did not return one complete unique result" };
      const v = items[0];
      if (!v) return { kind: "missing" };
      const tags = fromAwsTagList(v.Tags);
      if (!v.VolumeId || (hint && v.VolumeId !== hint) || (node.ownership === "managed" && !matchesNodeTags(tags, ctx, node.address))) {
        return { kind: "ambiguous", detail: "the returned volume did not match the identifier and tenant tags" };
      }
      const a = new Attributes(ctx);
      a.set("sizeGb", v.Size); a.set("storageClass", v.VolumeType); a.set("encrypted", v.Encrypted);
      a.set("availabilityZone", v.AvailabilityZone); a.set("kmsKeyArn", v.KmsKeyId); a.set("state", v.State);
      a.set("attachments", v.Attachments?.map((attachment) => ({ instanceId: attachment.InstanceId, deviceName: attachment.Device, state: attachment.State })));
      a.set("attachmentCount", v.Attachments?.length);
      a.set("deviceName", v.Attachments?.length === 1 ? v.Attachments[0].Device : undefined);
      return { kind: "present", externalId: v.VolumeId, attributes: a.finish(EBS_ATTRIBUTES), native: { tags, volumeId: v.VolumeId } };
    });
  },
  async verify(ctx, node, observation) {
    const expected: Record<string, unknown> = { encrypted: true, ...expectedEbsAttributes(node) };
    const result = standardVerification(ctx, node, observation, expected, "the EBS volume");
    if (observation.presence !== "present" || expected.attachmentCount !== 1) return result;
    // The fixed DriverContext cannot resolve the graph address in spec.instance
    // to an EC2 ID. Even an attachment on the right device cannot prove the
    // target is correct; never report a successful target check by guessing.
    return verificationResult(ctx, node, [...result.checks, {
      id: "attachment_target", description: "the attachment targets the graph-named instance", passed: "unknown",
      detail: "the verification context has no graph-address-to-instance-ID resolver",
    }]);
  },
};
