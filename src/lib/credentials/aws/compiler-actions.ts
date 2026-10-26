/**
 * The IAM write actions each Terraform resource type needs when OpenTofu
 * creates, updates and deletes it through the AWS provider. This is the
 * "actions the compiler uses" side of the least-privilege diff.
 *
 * Keys are exactly the `aws_*` resource types the AWS drivers emit with
 * `b.resource("<type>", ...)`; a test scans the driver sources and requires the
 * two sets to be identical, so a new driver resource type cannot ship without
 * its actions being declared here (and therefore diffed against the bootstrap).
 *
 * Read verbs (Describe/List/Get) are intentionally omitted: refresh needs many
 * of them and the observe policy is read-only by construction. Tagging actions
 * are included because the drivers tag everything they create.
 *
 * This table is maintained by hand from the provider's API calls. It is a
 * contract-level model, not proof of effective permissions.
 */
import type { UsedAction } from "./least-privilege";

const PASS_ROLE = "iam:PassRole";
const SLR = "iam:CreateServiceLinkedRole";

export const COMPILER_RESOURCE_ACTIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  aws_acm_certificate: ["acm:RequestCertificate", "acm:DeleteCertificate", "acm:AddTagsToCertificate", "acm:RemoveTagsFromCertificate", "acm:UpdateCertificateOptions"],
  aws_acm_certificate_validation: [],
  aws_cloudfront_distribution: ["cloudfront:CreateDistributionWithTags", "cloudfront:UpdateDistribution", "cloudfront:DeleteDistribution", "cloudfront:TagResource"],
  aws_cloudfront_origin_access_control: ["cloudfront:CreateOriginAccessControl", "cloudfront:UpdateOriginAccessControl", "cloudfront:DeleteOriginAccessControl"],
  aws_cloudwatch_event_rule: ["events:PutRule", "events:DeleteRule", "events:EnableRule", "events:DisableRule", "events:TagResource", "events:UntagResource"],
  aws_cloudwatch_event_target: ["events:PutTargets", "events:RemoveTargets", PASS_ROLE],
  aws_cloudwatch_log_group: ["logs:CreateLogGroup", "logs:DeleteLogGroup", "logs:PutRetentionPolicy", "logs:DeleteRetentionPolicy", "logs:TagResource", "logs:UntagResource"],
  aws_codebuild_project: ["codebuild:CreateProject", "codebuild:UpdateProject", "codebuild:DeleteProject", PASS_ROLE],
  aws_db_instance: ["rds:CreateDBInstance", "rds:ModifyDBInstance", "rds:DeleteDBInstance", "rds:CreateDBSnapshot", "rds:AddTagsToResource", "rds:RemoveTagsFromResource", SLR, "kms:CreateGrant"],
  aws_db_parameter_group: ["rds:CreateDBParameterGroup", "rds:ModifyDBParameterGroup", "rds:DeleteDBParameterGroup", "rds:AddTagsToResource"],
  aws_db_subnet_group: ["rds:CreateDBSubnetGroup", "rds:ModifyDBSubnetGroup", "rds:DeleteDBSubnetGroup", "rds:AddTagsToResource"],
  aws_ebs_volume: ["ec2:CreateVolume", "ec2:DeleteVolume", "ec2:ModifyVolume", "ec2:CreateTags", "kms:CreateGrant"],
  aws_ecr_lifecycle_policy: ["ecr:PutLifecyclePolicy", "ecr:DeleteLifecyclePolicy"],
  aws_ecr_repository: ["ecr:CreateRepository", "ecr:DeleteRepository", "ecr:PutImageScanningConfiguration", "ecr:PutImageTagMutability", "ecr:TagResource", "ecr:UntagResource"],
  aws_ecs_cluster: ["ecs:CreateCluster", "ecs:DeleteCluster", "ecs:UpdateCluster", "ecs:UpdateClusterSettings", "ecs:PutClusterCapacityProviders", "ecs:TagResource", "ecs:UntagResource", SLR],
  aws_ecs_service: ["ecs:CreateService", "ecs:UpdateService", "ecs:DeleteService", "ecs:TagResource", "ecs:UntagResource", PASS_ROLE, SLR],
  aws_ecs_task_definition: ["ecs:RegisterTaskDefinition", "ecs:DeregisterTaskDefinition", "ecs:TagResource", PASS_ROLE],
  aws_eip: ["ec2:AllocateAddress", "ec2:ReleaseAddress", "ec2:AssociateAddress", "ec2:DisassociateAddress", "ec2:CreateTags"],
  aws_eks_addon: ["eks:CreateAddon", "eks:UpdateAddon", "eks:DeleteAddon", "eks:TagResource"],
  aws_eks_cluster: ["eks:CreateCluster", "eks:DeleteCluster", "eks:UpdateClusterConfig", "eks:UpdateClusterVersion", "eks:TagResource", "eks:UntagResource", PASS_ROLE, SLR, "kms:CreateGrant"],
  aws_eks_node_group: ["eks:CreateNodegroup", "eks:DeleteNodegroup", "eks:UpdateNodegroupConfig", "eks:UpdateNodegroupVersion", "eks:TagResource", PASS_ROLE, SLR],
  aws_elasticache_replication_group: ["elasticache:CreateReplicationGroup", "elasticache:ModifyReplicationGroup", "elasticache:DeleteReplicationGroup", "elasticache:AddTagsToResource", "elasticache:RemoveTagsFromResource", "elasticache:IncreaseReplicaCount", "elasticache:DecreaseReplicaCount", SLR, "kms:CreateGrant"],
  aws_elasticache_subnet_group: ["elasticache:CreateCacheSubnetGroup", "elasticache:ModifyCacheSubnetGroup", "elasticache:DeleteCacheSubnetGroup", "elasticache:AddTagsToResource"],
  aws_elasticache_user: ["elasticache:CreateUser", "elasticache:ModifyUser", "elasticache:DeleteUser"],
  aws_elasticache_user_group: ["elasticache:CreateUserGroup", "elasticache:ModifyUserGroup", "elasticache:DeleteUserGroup"],
  aws_flow_log: ["ec2:CreateFlowLogs", "ec2:DeleteFlowLogs", "ec2:CreateTags", PASS_ROLE],
  aws_iam_instance_profile: ["iam:CreateInstanceProfile", "iam:DeleteInstanceProfile", "iam:AddRoleToInstanceProfile", "iam:RemoveRoleFromInstanceProfile", "iam:TagInstanceProfile"],
  aws_iam_openid_connect_provider: ["iam:CreateOpenIDConnectProvider", "iam:DeleteOpenIDConnectProvider", "iam:AddClientIDToOpenIDConnectProvider", "iam:UpdateOpenIDConnectProviderThumbprint", "iam:TagOpenIDConnectProvider"],
  aws_iam_role: ["iam:CreateRole", "iam:DeleteRole", "iam:UpdateAssumeRolePolicy", "iam:UpdateRole", "iam:UpdateRoleDescription", "iam:PutRolePermissionsBoundary", "iam:TagRole", "iam:UntagRole"],
  aws_iam_role_policy: ["iam:PutRolePolicy", "iam:DeleteRolePolicy"],
  aws_iam_role_policy_attachment: ["iam:AttachRolePolicy", "iam:DetachRolePolicy"],
  aws_instance: ["ec2:RunInstances", "ec2:TerminateInstances", "ec2:StopInstances", "ec2:StartInstances", "ec2:ModifyInstanceAttribute", "ec2:CreateTags", PASS_ROLE],
  aws_internet_gateway: ["ec2:CreateInternetGateway", "ec2:DeleteInternetGateway", "ec2:AttachInternetGateway", "ec2:DetachInternetGateway", "ec2:CreateTags"],
  aws_kms_key: ["kms:CreateKey", "kms:EnableKeyRotation", "kms:DisableKeyRotation", "kms:UpdateKeyDescription", "kms:TagResource", "kms:UntagResource", "kms:ScheduleKeyDeletion"],
  aws_lambda_function: ["lambda:CreateFunction", "lambda:DeleteFunction", "lambda:UpdateFunctionCode", "lambda:UpdateFunctionConfiguration", "lambda:PutFunctionConcurrency", "lambda:DeleteFunctionConcurrency", "lambda:TagResource", "lambda:UntagResource", PASS_ROLE],
  aws_launch_template: ["ec2:CreateLaunchTemplate", "ec2:DeleteLaunchTemplate", "ec2:CreateLaunchTemplateVersion", "ec2:ModifyLaunchTemplate", "ec2:CreateTags"],
  aws_lb: ["elasticloadbalancing:CreateLoadBalancer", "elasticloadbalancing:DeleteLoadBalancer", "elasticloadbalancing:ModifyLoadBalancerAttributes", "elasticloadbalancing:SetSecurityGroups", "elasticloadbalancing:SetSubnets", "elasticloadbalancing:SetIpAddressType", "elasticloadbalancing:AddTags", "elasticloadbalancing:RemoveTags", SLR],
  aws_lb_listener: ["elasticloadbalancing:CreateListener", "elasticloadbalancing:ModifyListener", "elasticloadbalancing:DeleteListener", "elasticloadbalancing:AddTags"],
  aws_lb_listener_certificate: ["elasticloadbalancing:AddListenerCertificates", "elasticloadbalancing:RemoveListenerCertificates"],
  aws_lb_listener_rule: ["elasticloadbalancing:CreateRule", "elasticloadbalancing:ModifyRule", "elasticloadbalancing:DeleteRule", "elasticloadbalancing:SetRulePriorities", "elasticloadbalancing:AddTags"],
  aws_lb_target_group: ["elasticloadbalancing:CreateTargetGroup", "elasticloadbalancing:ModifyTargetGroup", "elasticloadbalancing:ModifyTargetGroupAttributes", "elasticloadbalancing:DeleteTargetGroup", "elasticloadbalancing:AddTags", "elasticloadbalancing:RemoveTags"],
  aws_nat_gateway: ["ec2:CreateNatGateway", "ec2:DeleteNatGateway", "ec2:CreateTags"],
  aws_route: ["ec2:CreateRoute", "ec2:DeleteRoute", "ec2:ReplaceRoute"],
  aws_route53_record: ["route53:ChangeResourceRecordSets"],
  aws_route_table: ["ec2:CreateRouteTable", "ec2:DeleteRouteTable", "ec2:CreateTags"],
  aws_route_table_association: ["ec2:AssociateRouteTable", "ec2:DisassociateRouteTable"],
  aws_s3_bucket: ["s3:CreateBucket", "s3:DeleteBucket", "s3:PutBucketTagging"],
  aws_s3_bucket_lifecycle_configuration: ["s3:PutLifecycleConfiguration"],
  aws_s3_bucket_ownership_controls: ["s3:PutBucketOwnershipControls"],
  aws_s3_bucket_policy: ["s3:PutBucketPolicy", "s3:DeleteBucketPolicy"],
  aws_s3_bucket_public_access_block: ["s3:PutBucketPublicAccessBlock"],
  aws_s3_bucket_server_side_encryption_configuration: ["s3:PutEncryptionConfiguration"],
  aws_s3_bucket_versioning: ["s3:PutBucketVersioning"],
  aws_secretsmanager_secret: ["secretsmanager:CreateSecret", "secretsmanager:DeleteSecret", "secretsmanager:UpdateSecret", "secretsmanager:TagResource", "secretsmanager:UntagResource"],
  aws_security_group: ["ec2:CreateSecurityGroup", "ec2:DeleteSecurityGroup", "ec2:RevokeSecurityGroupEgress", "ec2:CreateTags"],
  aws_sns_topic: ["sns:CreateTopic", "sns:DeleteTopic", "sns:SetTopicAttributes", "sns:TagResource", "sns:UntagResource"],
  aws_sns_topic_subscription: ["sns:Subscribe", "sns:Unsubscribe", "sns:SetSubscriptionAttributes"],
  aws_sqs_queue: ["sqs:CreateQueue", "sqs:DeleteQueue", "sqs:SetQueueAttributes", "sqs:TagQueue", "sqs:UntagQueue"],
  aws_sqs_queue_policy: ["sqs:SetQueueAttributes"],
  aws_sqs_queue_redrive_allow_policy: ["sqs:SetQueueAttributes"],
  aws_ssm_parameter: ["ssm:PutParameter", "ssm:DeleteParameter", "ssm:AddTagsToResource", "ssm:RemoveTagsFromResource"],
  aws_subnet: ["ec2:CreateSubnet", "ec2:DeleteSubnet", "ec2:ModifySubnetAttribute", "ec2:CreateTags"],
  aws_volume_attachment: ["ec2:AttachVolume", "ec2:DetachVolume"],
  aws_vpc: ["ec2:CreateVpc", "ec2:DeleteVpc", "ec2:ModifyVpcAttribute", "ec2:CreateTags"],
  aws_vpc_endpoint: ["ec2:CreateVpcEndpoint", "ec2:DeleteVpcEndpoints", "ec2:ModifyVpcEndpoint", "ec2:CreateTags"],
  aws_vpc_security_group_egress_rule: ["ec2:AuthorizeSecurityGroupEgress", "ec2:RevokeSecurityGroupEgress", "ec2:ModifySecurityGroupRules", "ec2:UpdateSecurityGroupRuleDescriptionsEgress", "ec2:CreateTags"],
  aws_vpc_security_group_ingress_rule: ["ec2:AuthorizeSecurityGroupIngress", "ec2:RevokeSecurityGroupIngress", "ec2:ModifySecurityGroupRules", "ec2:UpdateSecurityGroupRuleDescriptionsIngress", "ec2:CreateTags"],
});

/**
 * Actions Zenith's execution path itself needs from the deploy role beyond the
 * resource types OpenTofu manages: the S3 state backend (with the optional state
 * KMS key) and the build/run operations. Keys are labels, not resource types.
 */
export const COMPILER_RUNTIME_ACTIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "runtime:state_backend": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket", "s3:GetBucketLocation", "s3:GetBucketVersioning", "kms:Decrypt", "kms:GenerateDataKey"],
  "runtime:source_objects": ["s3:GetObject", "s3:PutObject", "s3:GetObjectVersion"],
  "runtime:image_build": ["codebuild:StartBuild", "codebuild:StopBuild", "codebuild:BatchGetBuilds"],
  "runtime:scheduled_tasks": ["ecs:RunTask", "ecs:StopTask"],
});

export function usedRuntimeActions(): readonly UsedAction[] {
  const byAction = new Map<string, Set<string>>();
  for (const [label, actions] of Object.entries(COMPILER_RUNTIME_ACTIONS)) {
    for (const action of actions) byAction.set(action, (byAction.get(action) ?? new Set()).add(label));
  }
  return Object.freeze([...byAction].sort(([a], [b]) => a.localeCompare(b)).map(([action, via]) => Object.freeze({ action, via: Object.freeze([...via].sort()) })));
}

export interface UsedActionsResult {
  readonly used: readonly UsedAction[];
  /** Resource types with no catalog entry; the diff cannot be trusted while this is non-empty. */
  readonly uncatalogued: readonly string[];
}

/** Needed actions for a set of emitted resource types. Non-AWS types (random_id, terraform_data) need none. */
export function usedActionsForResourceTypes(types: Iterable<string>): UsedActionsResult {
  const byAction = new Map<string, Set<string>>();
  const uncatalogued = new Set<string>();
  for (const type of new Set(types)) {
    if (!type.startsWith("aws_")) continue;
    const actions = Object.hasOwn(COMPILER_RESOURCE_ACTIONS, type) ? COMPILER_RESOURCE_ACTIONS[type] : undefined;
    if (!actions) { uncatalogued.add(type); continue; }
    for (const action of actions) byAction.set(action, (byAction.get(action) ?? new Set()).add(type));
  }
  return Object.freeze({
    used: Object.freeze([...byAction].sort(([a], [b]) => a.localeCompare(b)).map(([action, via]) => Object.freeze({ action, via: Object.freeze([...via].sort()) }))),
    uncatalogued: Object.freeze([...uncatalogued].sort()),
  });
}
