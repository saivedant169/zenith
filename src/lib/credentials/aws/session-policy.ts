/**
 * Least-privilege inline session policies per capability (ADR-0006).
 *
 * How they compose: a session policy is intersected with the assumed role's
 * own policies, so it can only remove permissions. The customer's observe and
 * deploy roles (deploy/aws) are the ceiling; these policies are the narrower
 * per-operation ceiling underneath.
 *
 * What is and is not narrowed, honestly:
 *  - `infrastructure.observe`, `topology.read`, `firewall.inspect`,
 *    `metrics.read`: read-only describe/list/get. Most Describe/List APIs do
 *    not support resource-level scoping, so these are action-scoped over `*`.
 *  - `logs.read`: log-group ARN prefixes for ONE environment. The query-result
 *    calls (`GetQueryResults`, `StopQuery`, `DescribeQueries`) accept only
 *    `Resource: "*"` in IAM; query ids are unguessable and only the caller that
 *    started a query has one, which is the accepted residual.
 *  - `service.restart` / `service.scale`: `ecs:UpdateService` on services in the
 *    environment's cluster, additionally requiring the service's
 *    `zenith:environment` tag to match. IAM cannot restrict WHICH parameters
 *    UpdateService is called with (a force-new-deployment restart versus a
 *    task-definition change) — the driver only sends what it should; this
 *    policy bounds the blast radius to one environment's services.
 *  - `database.snapshot`: create/tag snapshots named `zenith-<env>-*` of DBs
 *    and clusters named `zenith-<env>-*`.
 *  - `infrastructure.apply`/`destroy`, `deployment.*`, `drift.repair` and every
 *    other capability: NO session policy. Tofu applies touch too many services
 *    to enumerate in 2,048 characters; the deploy role (tag/name-conditioned,
 *    permission-boundary-enforced) is the control. `sessionPolicyFor` returns
 *    `undefined` for them and the broker passes no `Policy`.
 *
 * Every policy is ≤ 2,048 compact characters (AWS limit) — asserted in tests.
 * Naming/tag conventions come from `./naming`.
 */
import { isCapability } from "@/lib/capabilities/catalog";
import { ENVIRONMENT_ID_PATTERN, TAG_ENVIRONMENT, environmentName } from "./naming";
import { SessionPolicyError } from "./policy";

export interface SessionPolicyContext {
  accountId: string;
  region: string;
  partition?: "aws" | "aws-cn" | "aws-us-gov";
  /** the grant's environment id; required for environment-scoped capabilities */
  environmentId?: string;
}

export interface SessionPolicyDocument {
  Version: "2012-10-17";
  Statement: Record<string, unknown>[];
}

const READ_ACTIONS = [
  "ec2:Describe*",
  "ecs:Describe*",
  "ecs:List*",
  "ecr:Describe*",
  "ecr:List*",
  "elasticloadbalancing:Describe*",
  "rds:Describe*",
  "rds:ListTagsForResource",
  "elasticache:Describe*",
  "elasticache:ListTagsForResource",
  "sqs:GetQueueAttributes",
  "sqs:GetQueueUrl",
  "sqs:ListQueues",
  "sqs:ListQueueTags",
  "sns:ListTopics",
  "eks:ListClusters",
  "eks:DescribeAddonVersions",
  "route53:Get*",
  "route53:List*",
  "acm:Describe*",
  "acm:List*",
  "cloudwatch:Describe*",
  "cloudwatch:Get*",
  "cloudwatch:List*",
  "logs:Describe*",
  "ssm:Describe*",
  "secretsmanager:DescribeSecret",
  "secretsmanager:GetResourcePolicy",
  "secretsmanager:ListSecrets",
  "codebuild:BatchGet*",
  "lambda:GetFunctionConfiguration",
  "lambda:ListFunctions",
  "lambda:ListTags",
  "events:Describe*",
  "events:List*",
  "cloudfront:GetDistribution",
  "autoscaling:Describe*",
  "application-autoscaling:Describe*",
  "tag:GetResources",
  "s3:ListAllMyBuckets",
];

function partitionOf(ctx: SessionPolicyContext): string {
  return ctx.partition ?? "aws";
}

function requireEnvironment(ctx: SessionPolicyContext, capabilityName: string): string {
  const env = ctx.environmentId;
  if (!env) {
    throw new SessionPolicyError(`${capabilityName} needs an environment-scoped grant (grant.env is missing).`);
  }
  if (!ENVIRONMENT_ID_PATTERN.test(env)) {
    throw new SessionPolicyError(
      "The environment id contains characters that cannot be embedded in an ARN pattern safely."
    );
  }
  return env;
}

const doc = (statements: Record<string, unknown>[]): SessionPolicyDocument => ({
  Version: "2012-10-17",
  Statement: statements,
});

function observePolicy(ctx: SessionPolicyContext): SessionPolicyDocument {
  const p = partitionOf(ctx);
  return doc([
    { Effect: "Allow", Action: READ_ACTIONS, Resource: "*" },
    {
      Effect: "Allow",
      Action: ["sns:GetTopicAttributes", "sns:GetSubscriptionAttributes", "sns:ListTagsForResource", "sns:ListSubscriptionsByTopic", "eks:Describe*", "eks:List*", "eks:DescribeCluster", "eks:ListNodegroups", "eks:DescribeNodegroup", "eks:ListTagsForResource"],
      Resource: [`arn:${p}:sns:*:${ctx.accountId}:zenith-*`, `arn:${p}:eks:*:${ctx.accountId}:cluster/zenith-*`,
        `arn:${p}:eks:*:${ctx.accountId}:nodegroup/zenith-*/*/*`, `arn:${p}:eks:*:${ctx.accountId}:addon/zenith-*/*/*`],
    },
    {
      Effect: "Allow",
      Action: ["s3:GetBucket*", "s3:ListBucket", "s3:GetEncryptionConfiguration"],
      Resource: `arn:${p}:s3:::zenith-*`,
    },
    {
      Effect: "Allow",
      Action: ["iam:GetRole", "iam:GetRolePolicy", "iam:ListRolePolicies", "iam:ListAttachedRolePolicies", "iam:ListRoleTags"],
      Resource: `arn:${p}:iam::${ctx.accountId}:role/zenith-*`,
    },
  ]);
}

function metricsPolicy(): SessionPolicyDocument {
  return doc([
    {
      Effect: "Allow",
      Action: [
        "cloudwatch:GetMetricData",
        "cloudwatch:GetMetricStatistics",
        "cloudwatch:ListMetrics",
        "cloudwatch:DescribeAlarms",
        "cloudwatch:DescribeAlarmHistory",
      ],
      Resource: "*",
    },
  ]);
}

/** Log-group name prefixes that belong to one environment (see `naming.ts`). */
export function logGroupPrefixes(environmentId: string): string[] {
  const name = environmentName(environmentId);
  return [`/zenith/${environmentId}/`, `/aws/ecs/${name}-`, `/aws/lambda/${name}-`, `/aws/codebuild/${name}-`];
}

function logsPolicy(ctx: SessionPolicyContext): SessionPolicyDocument {
  const env = requireEnvironment(ctx, "logs.read");
  const p = partitionOf(ctx);
  return doc([
    {
      Effect: "Allow",
      Action: ["logs:FilterLogEvents", "logs:GetLogEvents", "logs:StartQuery", "logs:DescribeLogStreams"],
      Resource: logGroupPrefixes(env).map((prefix) => `arn:${p}:logs:${ctx.region}:${ctx.accountId}:log-group:${prefix}*`),
    },
    { Effect: "Allow", Action: ["logs:GetQueryResults", "logs:StopQuery", "logs:DescribeQueries"], Resource: "*" },
  ]);
}

function ecsServicePolicy(ctx: SessionPolicyContext, capabilityName: string): SessionPolicyDocument {
  const env = requireEnvironment(ctx, capabilityName);
  const p = partitionOf(ctx);
  const cluster = environmentName(env);
  return doc([
    {
      Effect: "Allow",
      Action: ["ecs:UpdateService", "ecs:DescribeServices"],
      Resource: `arn:${p}:ecs:${ctx.region}:${ctx.accountId}:service/${cluster}/*`,
      Condition: { StringEquals: { [`aws:ResourceTag/${TAG_ENVIRONMENT}`]: env } },
    },
    {
      Effect: "Allow",
      Action: "ecs:DescribeClusters",
      Resource: `arn:${p}:ecs:${ctx.region}:${ctx.accountId}:cluster/${cluster}`,
    },
  ]);
}

function snapshotPolicy(ctx: SessionPolicyContext): SessionPolicyDocument {
  const env = requireEnvironment(ctx, "database.snapshot");
  const p = partitionOf(ctx);
  const base = `arn:${p}:rds:${ctx.region}:${ctx.accountId}`;
  const name = environmentName(env);
  return doc([
    {
      Effect: "Allow",
      Action: ["rds:CreateDBSnapshot", "rds:CreateDBClusterSnapshot", "rds:AddTagsToResource"],
      Resource: [
        `${base}:db:${name}-*`,
        `${base}:cluster:${name}-*`,
        `${base}:snapshot:${name}-*`,
        `${base}:cluster-snapshot:${name}-*`,
      ],
    },
    {
      Effect: "Allow",
      Action: ["rds:DescribeDBSnapshots", "rds:DescribeDBClusterSnapshots", "rds:DescribeDBInstances", "rds:DescribeDBClusters"],
      Resource: "*",
    },
  ]);
}

/** Capabilities that need `ctx.environmentId`. */
const ENVIRONMENT_SCOPED = new Set(["logs.read", "service.restart", "service.scale", "database.snapshot"]);

export const sessionPolicyNeedsEnvironment = (capabilityName: string): boolean => ENVIRONMENT_SCOPED.has(capabilityName);

/**
 * The narrowing policy for a capability, or `undefined` when the role's own
 * policy is the control (see the module comment). Throws `SessionPolicyError`
 * for an unknown capability or missing/unsafe environment id.
 */
export function sessionPolicyFor(capabilityName: string, ctx: SessionPolicyContext): SessionPolicyDocument | undefined {
  if (!isCapability(capabilityName)) throw new SessionPolicyError(`Unknown capability "${capabilityName}".`);
  switch (capabilityName) {
    case "infrastructure.observe":
    case "topology.read":
    case "firewall.inspect":
      return observePolicy(ctx);
    case "metrics.read":
      return metricsPolicy();
    case "logs.read":
      return logsPolicy(ctx);
    case "service.restart":
    case "service.scale":
      return ecsServicePolicy(ctx, capabilityName);
    case "database.snapshot":
      return snapshotPolicy(ctx);
    default:
      return undefined;
  }
}
