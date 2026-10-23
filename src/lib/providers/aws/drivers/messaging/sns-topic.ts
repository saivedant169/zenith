/**
 * SNS lifecycle is declarative: KMS SSE, exact publish grants, and explicitly
 * named SQS subscriptions. spec.subscriptions (or SQS dependencies on this
 * topic node) names the queues. One topic owns a queue's SNS delivery policy;
 * a second fragment claiming that queue policy is rejected by the assembler,
 * rather than having AWS silently replace another topic's delivery grant.
 *
 * Observe resolves tenant tags before reading SNS encryption, policy counts,
 * and confirmed bound SQS subscriptions. An empty/eventually-consistent index
 * is unknown, never proof of deletion. No native health/discovery is claimed.
 * All evidence is contract; nothing here has been exercised in a live account.
 */
import { z } from "zod";
import type { AwsSession } from "@/lib/credentials/types";
import type { CompileContext, ResourceDriver, TofuFragment } from "@/lib/drivers/types";
import type { ResourceNode } from "@/lib/resources/types";
import {
  DriverCompileError, FragmentBuilder, cloudName, matchesNodeTags, nodeName,
  parseArn, partitionOfRegion, refExpr, resourceTags, standardVerification, tfLabel,
} from "@/lib/providers/aws/drivers/shared";
import { expectedFor, findByTags, guardObserve } from "@/lib/providers/aws/drivers/data/support";
import { assertAwsNode, KMS_KEY_ARN, neighbour, readSpec, SNS_TOPIC_ARN } from "./support";
import { readSnsTopic, safeMetadataRead, SNS_ATTRIBUTES } from "./sns-observe";
export { SNS_ATTRIBUTES } from "./sns-observe";

const SOURCE = "aws.sns_topic@1";
export const SNS_TOPIC_SCHEMA = z.object({
  name: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/).optional(),
  fifo: z.literal(false).optional(),
  encrypted: z.literal(true).optional(),
  encryption: z.literal(true).optional(),
  kmsKeyArn: z.string().regex(KMS_KEY_ARN).optional(),
  deletionPolicy: z.enum(["deny", "approval", "allow"]).prefault("deny"),
  subscriptions: z.array(z.string().min(1).max(256)).max(100).prefault([]),
}).strict();
export type SnsTopicSpec = z.input<typeof SNS_TOPIC_SCHEMA>;

export function compileSnsTopic(node: ResourceNode, ctx: CompileContext): TofuFragment {
  if (node.ownership !== "managed") return { addresses: [] };
  assertAwsNode(node, ctx);
  const spec = readSpec(node, SNS_TOPIC_SCHEMA);
  if (spec.kmsKeyArn && parseArn(spec.kmsKeyArn)?.region !== node.region) {
    throw new DriverCompileError("invalid_spec", node.address, "the SNS encryption key must be in the topic's region.");
  }
  const label = tfLabel(node.address);
  const b = new FragmentBuilder(node.address);
  const topic = `aws_sns_topic.${label}`;
  b.resource("aws_sns_topic", label, {
    name: spec.name ?? cloudName(ctx.namePrefix, nodeName(node.address), 256),
    kms_master_key_id: spec.kmsKeyArn ?? "alias/aws/sns",
    tags: resourceTags(ctx.tags, node.address),
    lifecycle: { prevent_destroy: spec.deletionPolicy !== "allow" },
  });
  // IAM publish grants need the exact key ARN, including for the managed key.
  b.data("aws_kms_key", `${label}_key`, { key_id: spec.kmsKeyArn ?? "alias/aws/sns" });
  b.expose("id", `${topic}.arn`);
  b.expose("arn", `${topic}.arn`);
  b.expose("name", `${topic}.name`);
  b.expose("kms_key_arn", `data.aws_kms_key.${label}_key.arn`);

  const dependencies = node.dependsOn.filter((address) => ctx.node(address)?.nativeType === "aws:sqs_queue");
  for (const address of [...new Set([...spec.subscriptions, ...dependencies])].sort()) {
    const queue = neighbour(node, ctx, address, "aws:sqs_queue");
    if (queue.ownership !== "managed") {
      throw new DriverCompileError("policy_refused", node.address, "SQS subscription delivery requires a queue Zenith manages; external queue policies cannot be replaced.");
    }
    const policyLabel = `${tfLabel(queue.address)}_sns_delivery`;
    b.resource("aws_sqs_queue_policy", policyLabel, {
      queue_url: refExpr(ctx.ref(queue.address, "url")),
      policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
          Sid: "SnsDelivery", Effect: "Allow", Principal: { Service: "sns.amazonaws.com" },
          Action: "sqs:SendMessage", Resource: refExpr(ctx.ref(queue.address, "arn")),
          Condition: { ArnEquals: { "aws:SourceArn": refExpr(`${topic}.arn`) } },
        }],
      }),
    });
    b.resource("aws_sns_topic_subscription", `${label}_${tfLabel(queue.address)}`, {
      topic_arn: refExpr(`${topic}.arn`), protocol: "sqs",
      endpoint: refExpr(ctx.ref(queue.address, "arn")), raw_message_delivery: true,
      depends_on: [`aws_sqs_queue_policy.${policyLabel}`],
    });
  }
  return b.build();
}

/** Portable queue dependencies identify their type by address; native edges need explicit bindings. */
function subscriptionAddresses(node: ResourceNode): string[] {
  const spec = readSpec(node, SNS_TOPIC_SCHEMA);
  return [...new Set([...spec.subscriptions, ...node.dependsOn.filter((address) => address.startsWith("queue/"))])].sort();
}
export function expectedSnsAttributes(node: ResourceNode): Record<string, unknown> {
  return expectedFor(node, () => {
    const spec = readSpec(node, SNS_TOPIC_SCHEMA);
    return { encrypted: true, ...(spec.kmsKeyArn ? { kmsKeyArn: spec.kmsKeyArn } : {}), subscriptions: subscriptionAddresses(node) };
  });
}

export const snsTopicDriver: ResourceDriver<AwsSession> = {
  id: SOURCE, provider: "aws", kind: "pubsub", nativeType: "aws:sns_topic",
  capabilities: {
    compile: true, observe: true, verify: true, runtime: false, discover: false,
    operations: [], evidence: { compile: "contract", observe: "contract", verify: "contract" },
  },
  compile: compileSnsTopic,
  expectedAttributes: expectedSnsAttributes,
  async observe(ctx, node, externalId) {
    return guardObserve(ctx, node, SOURCE, SNS_ATTRIBUTES, undefined, () => safeMetadataRead(ctx, async () => {
      if (ctx.provider !== "aws" || node.provider !== "aws" || node.region !== ctx.region) {
        return { kind: "ambiguous", detail: "the SNS node must be in this AWS provider region" };
      }
      const hint = externalId ?? node.externalRef;
      if (hint !== undefined && (!SNS_TOPIC_ARN.test(hint) || parseArn(hint)?.region !== ctx.region || parseArn(hint)?.accountId !== ctx.session.accountId || parseArn(hint)?.partition !== partitionOfRegion(ctx.region))) {
        return { kind: "ambiguous", detail: "the SNS identifier must be an exact topic ARN in this session's account and region" };
      }
      const { matches, truncated } = await findByTags(ctx, node, "sns:topic");
      const scoped = [...new Map(matches.filter((m) => SNS_TOPIC_ARN.test(m.arn) && matchesNodeTags(m.tags, ctx, node.address)
        && parseArn(m.arn)?.region === ctx.region && parseArn(m.arn)?.accountId === ctx.session.accountId
        && parseArn(m.arn)?.partition === partitionOfRegion(ctx.region)).map((m) => [m.arn, m])).values()];
      if (truncated || scoped.length !== 1 || (hint !== undefined && scoped[0].arn !== hint)) {
        return { kind: "ambiguous", detail: "the eventually-consistent tagging index did not resolve exactly one scoped SNS topic" };
      }
      const read = await readSnsTopic(ctx, node, scoped[0].arn, subscriptionAddresses(node));
      // Arbitrary tag values can contain secrets. Preserve only verified scope
      // fields and the closed managed flag, rather than copying provider tags.
      const tags = Object.fromEntries(Object.entries(scoped[0].tags).filter(([key, value]) =>
        ["zenith:workspace", "zenith:environment", "zenith:resource"].includes(key)
        || (key === "zenith:managed" && (value === "true" || value === "false"))));
      return { kind: "present", externalId: scoped[0].arn, attributes: read.attributes, native: { ...read.native, tags, lookup: "tagging_index+sns" } };
    }));
  },
  async verify(ctx, node, observation) {
    return standardVerification(ctx, node, observation, { encrypted: true, ...expectedSnsAttributes(node) }, "the SNS topic");
  },
};
