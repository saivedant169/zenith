# OWNER ONLY after DEC-CLOUD. Never applied by the acceptance harness.
terraform {
  required_version = "~> 1.12.5"
  required_providers {
    aws = { source = "hashicorp/aws", version = "6.0.0" }
  }
}
provider "aws" {
  region              = var.region
  allowed_account_ids = [var.account_id]
  default_tags { tags = { "zenith:bootstrap" = "live-sandbox" } }
}
variable "account_id" {
  type = string
  validation {
    condition     = can(regex("^[0-9]{12}$", var.account_id)) && var.account_id != "000000000000"
    error_message = "An explicitly approved sandbox account ID is required."
  }
}
variable "region" {
  type = string
  validation {
    condition     = can(regex("^(us|eu|ap|ca|sa|me|af|il|mx)-(central|north|south|east|west|northeast|northwest|southeast|southwest)-[0-9]$", var.region))
    error_message = "Only an owner-approved commercial region is supported."
  }
}
variable "budget_usd" {
  type = number
  validation {
    condition     = var.budget_usd > 0 && var.budget_usd <= 50
    error_message = "Explicit approved monthly budget required (0 < USD <= 50)."
  }
}
variable "alert_email" { type = string }
variable "connection_name_suffix" {
  description = "NameSuffix the Zenith connection stack zenith-connection-live was installed with (deploy/aws/zenith-connection.cfn.yaml)."
  type        = string
  default     = "-live"
  validation {
    condition     = can(regex("^(-[a-z0-9-]{1,19})?$", var.connection_name_suffix))
    error_message = "Must match the connection template NameSuffix pattern: empty, or a hyphen then 1-19 of [a-z0-9-]."
  }
}
variable "connection_lane_suffixes" {
  description = "NameSuffix of every installed sandbox lane connection stack: zenith-connection-live, and zenith-connection-live2 for the second lane."
  type        = list(string)
  default     = ["-live"]
  validation {
    condition     = length(var.connection_lane_suffixes) > 0 && alltrue([for s in var.connection_lane_suffixes : startswith(s, var.connection_name_suffix) && can(regex("^-[a-z0-9-]{1,19}$", s))])
    error_message = "Each lane suffix starts with connection_name_suffix and matches the connection template NameSuffix pattern."
  }
}
variable "dec_cloud_approved" {
  type    = bool
  default = false
}
variable "github_repository" {
  description = "The GitHub owner/name whose protected live-sandbox environment may assume the role (the repository that runs live acceptance)."
  type        = string
  validation {
    condition     = can(regex("^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$", var.github_repository))
    error_message = "GitHub repository must be exactly owner/name."
  }
}
variable "github_oidc_subject_prefix" {
  description = "Subject prefix GitHub puts in this repository's OIDC tokens, or empty for repo:<github_repository>. Repositories using immutable subjects send repo:<owner>@<owner_id>/<name>@<repo_id> (gh api repos/<owner>/<name>/actions/oidc/customization/sub)."
  type        = string
  default     = ""
  validation {
    condition     = var.github_oidc_subject_prefix == "" || can(regex("^repo:[A-Za-z0-9-]+(@[0-9]+)?/[A-Za-z0-9._-]+(@[0-9]+)?$", var.github_oidc_subject_prefix))
    error_message = "Subject prefix must be repo:owner/name, optionally with @id suffixes."
  }
}
variable "github_oidc_provider_arn" {
  description = "Existing GitHub OIDC provider ARN, or empty to create it in this new sandbox."
  type        = string
  default     = ""
  validation {
    condition     = var.github_oidc_provider_arn == "" || var.github_oidc_provider_arn == "arn:aws:iam::${var.account_id}:oidc-provider/token.actions.githubusercontent.com"
    error_message = "GitHub OIDC provider must belong to the declared sandbox."
  }
}
locals {
  name                 = "ZenithLiveAcceptance"
  base                 = "arn:aws"
  iam                  = "${local.base}:iam::${var.account_id}"
  tags                 = { "zenith:bootstrap" = "live-sandbox" }
  workload_role        = "${local.iam}:role/zenith-zlive-*-lambda"
  boundary             = "${local.iam}:policy/ZenithLiveWorkloadBoundary"
  # One pattern per role covers every lane (-live, -live2): the inline policy is capped at 10240 characters.
  # The secret writer role is here because the product writes service secrets only through it (PROD-OPS-06).
  connection_role_arns = ["${local.iam}:role/ZenithObserveRole${var.connection_name_suffix}*", "${local.iam}:role/ZenithDeployRole${var.connection_name_suffix}*", "${local.iam}:role/ZenithSecretWriterRole${var.connection_name_suffix}*"]
  lane_roles           = flatten([for s in var.connection_lane_suffixes : ["ZenithObserveRole${s}", "ZenithDeployRole${s}"]])
  owned_tags = {
    StringEquals = { "aws:ResourceTag/zenith:purpose" = "live-acceptance", "aws:ResourceTag/zenith:managed" = "true" }
  }
  request_tags = {
    StringEquals = { "aws:RequestTag/zenith:purpose" = "live-acceptance", "aws:RequestTag/zenith:managed" = "true" }
    StringLike   = { "aws:RequestTag/zenith:live-run" = "zlive-*" }
  }
  managed_tag      = { StringEquals = { "aws:ResourceTag/zenith:managed" = "true" } }
  zenith_role_glob = "${local.iam}:role/zenith-*"
  # Connection stack names (deploy/aws/zenith-connection.cfn.yaml) with the connection suffix. zenith-codebuild is lower-case,
  # so it matches zenith-* and is denied explicitly. The other roles are capitalised and do not match.
  connection_protected_roles = concat(local.connection_role_arns, ["${local.iam}:role/zenith-codebuild${var.connection_name_suffix}*"])
  # One pattern, not 15 ARNs: the inline policy is capped at 10240 characters. Matches the 15 connection managed policies
  # (Zenith*-live); the bootstrap policies do not end in the suffix.
  connection_protected_policies = ["${local.iam}:policy/Zenith*${var.connection_name_suffix}*"]
}
resource "aws_iam_openid_connect_provider" "github" {
  count          = var.github_oidc_provider_arn == "" ? 1 : 0
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}
resource "aws_iam_policy" "workload_boundary" {
  name = "ZenithLiveWorkloadBoundary"
  # The nonce echo function needs no AWS data-plane access, including log writes.
  policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Deny", Action = "*", Resource = "*" }] })
}
resource "aws_iam_role" "acceptance" {
  name                 = local.name
  max_session_duration = 3600
  permissions_boundary = aws_iam_policy.runner_boundary.arn
  lifecycle {
    precondition {
      condition     = var.dec_cloud_approved
      error_message = "Owner must approve DEC-CLOUD before bootstrap."
    }
  }
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow", Action = "sts:AssumeRoleWithWebIdentity"
      Principal = { Federated = var.github_oidc_provider_arn != "" ? var.github_oidc_provider_arn : aws_iam_openid_connect_provider.github[0].arn }
      Condition = { StringEquals = {
        "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
        "token.actions.githubusercontent.com:sub" = "${var.github_oidc_subject_prefix != "" ? var.github_oidc_subject_prefix : "repo:${var.github_repository}"}:environment:live-sandbox"
      } }
    }]
  })
}
locals {
  statements = [
    # Read/list APIs that AWS cannot resource-scope. No write wildcard grant.
    { Sid = "UnscopableInventory", Effect = "Allow", Action = ["sts:GetCallerIdentity", "tag:GetResources", "ec2:DescribeSecurityGroups", "route53:ListHostedZonesByName"], Resource = "*" },
    { Sid = "SandboxMarker", Effect = "Allow", Action = ["ssm:GetParameter"], Resource = "${local.base}:ssm:${var.region}:${var.account_id}:parameter/zenith/live-sandbox" },
    { Sid = "RunReceiptRead", Effect = "Allow", Action = ["ssm:GetParameter"], Resource = "${local.base}:ssm:${var.region}:${var.account_id}:parameter/zenith/live-runs/zlive-*" },
    { Sid = "RunReceiptClaim", Effect = "Allow", Action = ["ssm:PutParameter"], Resource = "${local.base}:ssm:${var.region}:${var.account_id}:parameter/zenith/live-runs/zlive-*", Condition = { StringEquals = { "ssm:Overwrite" = "false", "aws:RequestTag/zenith:purpose" = "live-acceptance-receipt", "aws:RequestTag/zenith:managed" = "true" }, StringLike = { "aws:RequestTag/zenith:live-run" = "zlive-*" } } },
    { Sid = "RunReceiptTags", Effect = "Allow", Action = ["ssm:AddTagsToResource"], Resource = "${local.base}:ssm:${var.region}:${var.account_id}:parameter/zenith/live-runs/zlive-*", Condition = { StringEquals = { "aws:RequestTag/zenith:purpose" = "live-acceptance-receipt", "aws:RequestTag/zenith:managed" = "true" } } },
    { Sid = "PrivateDBSubnetRead", Effect = "Allow", Action = ["rds:DescribeDBSubnetGroups"], Resource = "${local.base}:rds:${var.region}:${var.account_id}:subgrp:zenith-live-sandbox" },
    { Sid = "OwnedS3", Effect = "Allow", Action = ["s3:CreateBucket", "s3:PutBucketTagging", "s3:GetBucketTagging", "s3:PutBucketPublicAccessBlock", "s3:GetBucketPublicAccessBlock", "s3:PutEncryptionConfiguration", "s3:ListBucket", "s3:DeleteBucket"], Resource = "${local.base}:s3:::zenith-zlive-*-${var.account_id}" },
    { Sid = "OwnedS3Probe", Effect = "Allow", Action = ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"], Resource = "${local.base}:s3:::zenith-zlive-*-${var.account_id}/probe" },
    { Sid = "RetentionArchiveObjects", Effect = "Allow", Action = ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"], Resource = "${local.base}:s3:::zenith-zlive-*-${var.account_id}/retention/*" },
    { Sid = "BoundedRoleCreate", Effect = "Allow", Action = ["iam:CreateRole"], Resource = local.workload_role, Condition = merge(local.request_tags, { ArnEquals = { "iam:PermissionsBoundary" = local.boundary } }) },
    { Sid = "RoleCreationTags", Effect = "Allow", Action = ["iam:TagRole"], Resource = local.workload_role, Condition = local.request_tags },
    { Sid = "RoleRead", Effect = "Allow", Action = ["iam:GetRole", "iam:ListRoleTags"], Resource = local.workload_role },
    { Sid = "RoleDelete", Effect = "Allow", Action = ["iam:DeleteRole"], Resource = local.workload_role, Condition = local.owned_tags },
    { Sid = "PassOnlyNonceRole", Effect = "Allow", Action = ["iam:PassRole"], Resource = local.workload_role, Condition = { StringEquals = { "iam:PassedToService" = "lambda.amazonaws.com" } } },
    { Sid = "LambdaCreate", Effect = "Allow", Action = ["lambda:CreateFunction", "lambda:TagResource"], Resource = "${local.base}:lambda:${var.region}:${var.account_id}:function:zenith-zlive-*-fn", Condition = local.request_tags },
    { Sid = "LambdaRead", Effect = "Allow", Action = ["lambda:GetFunctionConfiguration", "lambda:ListTags"], Resource = "${local.base}:lambda:${var.region}:${var.account_id}:function:zenith-zlive-*-fn" },
    { Sid = "LambdaExecuteDelete", Effect = "Allow", Action = ["lambda:InvokeFunction", "lambda:DeleteFunction"], Resource = "${local.base}:lambda:${var.region}:${var.account_id}:function:zenith-zlive-*-fn", Condition = local.owned_tags },
    { Sid = "ECSCreate", Effect = "Allow", Action = ["ecs:CreateCluster", "ecs:TagResource"], Resource = "${local.base}:ecs:${var.region}:${var.account_id}:cluster/zenith-zlive-*-ecs", Condition = local.request_tags },
    { Sid = "ECSRead", Effect = "Allow", Action = ["ecs:DescribeClusters", "ecs:ListTagsForResource"], Resource = "${local.base}:ecs:${var.region}:${var.account_id}:cluster/zenith-zlive-*-ecs" },
    { Sid = "ECSDelete", Effect = "Allow", Action = ["ecs:DeleteCluster"], Resource = "${local.base}:ecs:${var.region}:${var.account_id}:cluster/zenith-zlive-*-ecs", Condition = local.owned_tags },
    { Sid = "DBCreate", Effect = "Allow", Action = ["rds:CreateDBInstance", "rds:AddTagsToResource"], Resource = "${local.base}:rds:${var.region}:${var.account_id}:db:zenith-zlive-*-db", Condition = merge(local.request_tags, { Bool = { "rds:MultiAz" = "false" }, StringEquals = merge(local.request_tags.StringEquals, { "rds:DatabaseClass" = "db.t4g.micro", "rds:DatabaseEngine" = "postgres" }) }) },
    { Sid = "DBDependencies", Effect = "Allow", Action = ["rds:CreateDBInstance"], Resource = ["${local.base}:rds:${var.region}:${var.account_id}:subgrp:zenith-live-sandbox", "${local.base}:rds:${var.region}:${var.account_id}:pg:default.postgres*"] },
    { Sid = "DBRead", Effect = "Allow", Action = ["rds:DescribeDBInstances", "rds:ListTagsForResource"], Resource = "${local.base}:rds:${var.region}:${var.account_id}:db:zenith-zlive-*-db" },
    { Sid = "DBDelete", Effect = "Allow", Action = ["rds:DeleteDBInstance"], Resource = "${local.base}:rds:${var.region}:${var.account_id}:db:zenith-zlive-*-db", Condition = local.owned_tags },
    # RDS owns the generated credential; the runner cannot retrieve its value.
    { Sid = "RDSManagedSecret", Effect = "Allow", Action = ["secretsmanager:CreateSecret", "secretsmanager:TagResource"], Resource = "${local.base}:secretsmanager:${var.region}:${var.account_id}:secret:rds!db-*" },
    { Sid = "ManagedSecretAbsence", Effect = "Allow", Action = ["secretsmanager:DescribeSecret"], Resource = "${local.base}:secretsmanager:${var.region}:${var.account_id}:secret:rds!db-*" },
    { Sid = "ManagedKeyMetadata", Effect = "Allow", Action = ["kms:DescribeKey"], Resource = "${local.base}:kms:${var.region}:${var.account_id}:key/*" },
    { Sid = "ManagedEncryptionGrant", Effect = "Allow", Action = ["kms:CreateGrant"], Resource = "${local.base}:kms:${var.region}:${var.account_id}:key/*", Condition = { StringEquals = { "kms:ViaService" = ["rds.${var.region}.amazonaws.com", "secretsmanager.${var.region}.amazonaws.com"] }, Bool = { "kms:GrantIsForAWSResource" = "true" } } },
    # Route53 cannot scope creation to an ID that does not yet exist, nor tag on
    # create. Updates are restricted to reserved .invalid TXT names. Runtime
    # teardown additionally requires exact run tags and a durable owned identity.
    { Sid = "DisposableZoneCreate", Effect = "Allow", Action = ["route53:CreateHostedZone"], Resource = "*" },
    { Sid = "ZoneReadTag", Effect = "Allow", Action = ["route53:GetHostedZone", "route53:ListTagsForResource", "route53:ListResourceRecordSets", "route53:ChangeTagsForResource"], Resource = "${local.base}:route53:::hostedzone/*" },
    { Sid = "DisposableTXT", Effect = "Allow", Action = ["route53:ChangeResourceRecordSets"], Resource = "${local.base}:route53:::hostedzone/*", Condition = { "ForAllValues:StringLike" = { "route53:ChangeResourceRecordSetsNormalizedRecordNames" = "probe.zenith-zlive-*.invalid" }, "ForAllValues:StringEquals" = { "route53:ChangeResourceRecordSetsRecordTypes" = "TXT", "route53:ChangeResourceRecordSetsActions" = ["CREATE", "DELETE"] } } },
    { Sid = "ZoneDelete", Effect = "Allow", Action = ["route53:DeleteHostedZone"], Resource = "${local.base}:route53:::hostedzone/*" },
    # Option A (owner decision 2026-10-26): each live run rewrites the ExternalId in the trust policy of these two connection roles, then assumes them.
    # AWS cannot constrain trust-document content, so the automatic deny-all spend stop (aws_budgets_budget_action.spend_stop) is the compensating control.
    { Sid = "ConnectionAssume", Effect = "Allow", Action = ["sts:AssumeRole", "sts:TagSession"], Resource = local.connection_role_arns },
    { Sid = "ConnectionTrustRewrite", Effect = "Allow", Action = ["iam:GetRole", "iam:UpdateAssumeRolePolicy"], Resource = local.connection_role_arns },
    # MIX-03 cleanup (owner decision 2026-10-26): deletes only what a PROD-MIX-03 run created. Names match zenith-* and the
    # product tag zenith:managed=true (written by the connection deploy role) is required. tag:GetResources is already
    # granted by UnscopableInventory. Lambda does not copy function tags onto /aws/lambda/<name>, so log groups are name-scoped only.
    { Sid = "MixCleanupLambda", Effect = "Allow", Action = ["lambda:GetFunctionConfiguration", "lambda:DeleteFunction"], Resource = "${local.base}:lambda:${var.region}:${var.account_id}:function:zenith-*", Condition = local.managed_tag },
    { Sid = "MixCleanupLogGroup", Effect = "Allow", Action = ["logs:DeleteLogGroup"], Resource = "${local.base}:logs:${var.region}:${var.account_id}:log-group:/aws/lambda/zenith-*" },
    # IAM ARN matching is case-sensitive: the bootstrap and connection roles are capitalised (Zenith*) and do not match zenith-*.
    { Sid = "MixCleanupRole", Effect = "Allow", Action = ["iam:GetRole", "iam:ListAttachedRolePolicies", "iam:ListRolePolicies", "iam:DeleteRolePolicy", "iam:DeleteRole"], Resource = local.zenith_role_glob, Condition = local.managed_tag },
    { Sid = "MixCleanupRolePolicyDetach", Effect = "Allow", Action = ["iam:DetachRolePolicy"], Resource = local.zenith_role_glob, Condition = merge(local.managed_tag, { ArnLike = { "iam:PolicyARN" = "${local.iam}:policy/zenith-*" } }) },
    # Name-only: S3 bucket-level tag conditions (aws:ResourceTag, s3:ResourceTag) are not confirmed for DeleteBucket and
    # depend on per-bucket ABAC. The MIX-03 teardown checks zenith:managed and zenith:environment on each bucket first.
    { Sid = "MixCleanupBucket", Effect = "Allow", Action = ["s3:ListBucket", "s3:GetBucketTagging", "s3:DeleteBucket"], Resource = "${local.base}:s3:::zenith-*" },
    # Explicit denies override every allow above (defense in depth).
    { Sid = "DenyStateBucketDelete", Effect = "Deny", Action = ["s3:DeleteBucket", "s3:DeleteObject"], Resource = ["${local.base}:s3:::zenith-state-*", "${local.base}:s3:::zenith-state-*/*"] },
    { Sid = "DenyConnectionRoleDelete", Effect = "Deny", Action = ["iam:DeleteRole", "iam:DeleteRolePolicy", "iam:DetachRolePolicy", "iam:DeleteRolePermissionsBoundary"], Resource = local.connection_protected_roles },
    { Sid = "DenyConnectionPolicyDelete", Effect = "Deny", Action = ["iam:DeletePolicy", "iam:DeletePolicyVersion"], Resource = local.connection_protected_policies }
  ]
  runner_policy = jsonencode({ Version = "2012-10-17", Statement = local.statements })
}
resource "aws_iam_policy" "runner_boundary" {
  name = "ZenithLiveRunnerBoundary"
  # Action ceiling only; the role's identity policy below further narrows every
  # operation to its supported resources/conditions. No policy edit/attach grant.
  # Deny statements are excluded so the ceiling lists only granted actions.
  policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = distinct(flatten([for statement in local.statements : statement.Action if statement.Effect == "Allow"])), Resource = "*" }] })
}
resource "aws_iam_role_policy" "runner" {
  name   = "LiveAcceptance"
  role   = aws_iam_role.acceptance.id
  policy = local.runner_policy
  lifecycle {
    precondition {
      condition     = length(local.runner_policy) <= 10240
      error_message = "Inline role policy exceeds the AWS 10240 character limit."
    }
  }
}
resource "aws_ssm_parameter" "marker" {
  name  = "/zenith/live-sandbox"
  type  = "String"
  value = "true"
}
resource "aws_budgets_budget" "sandbox" {
  name         = "zenith-live-sandbox"
  budget_type  = "COST"
  limit_amount = tostring(var.budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alert_email]
  }
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.alert_email]
  }
}
# Hard spend stop (owner decision 2026-10-26, automatic, no approval step). When
# ACTUAL spend reaches 100% of budget_usd, Budgets attaches the deny-all policy to
# the acceptance role and both connection roles. Recovery: detach it (LIVE-ACCEPTANCE.md).
resource "aws_iam_policy" "spend_stop_deny_all" {
  name   = "ZenithLiveSpendStopDenyAll"
  policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Deny", Action = "*", Resource = "*" }] })
}
resource "aws_iam_role" "spend_stop" {
  name = "ZenithLiveSpendStopExecution"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow", Action = "sts:AssumeRole"
      Principal = { Service = "budgets.amazonaws.com" }
      Condition = { StringEquals = { "aws:SourceAccount" = var.account_id } }
    }]
  })
}
resource "aws_iam_role_policy" "spend_stop" {
  name = "AttachDenyAllToLiveRolesOnly"
  role = aws_iam_role.spend_stop.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect    = "Allow", Action = ["iam:AttachRolePolicy", "iam:DetachRolePolicy"]
    Resource  = concat([aws_iam_role.acceptance.arn], [for r in local.lane_roles : "${local.iam}:role/${r}"])
    Condition = { ArnEquals = { "iam:PolicyARN" = aws_iam_policy.spend_stop_deny_all.arn } }
  }] })
}
resource "aws_budgets_budget_action" "spend_stop" {
  account_id         = var.account_id
  budget_name        = aws_budgets_budget.sandbox.name
  action_type        = "APPLY_IAM_POLICY"
  approval_model     = "AUTOMATIC"
  notification_type  = "ACTUAL"
  execution_role_arn = aws_iam_role.spend_stop.arn
  action_threshold {
    action_threshold_type  = "PERCENTAGE"
    action_threshold_value = 100
  }
  definition {
    iam_action_definition {
      policy_arn = aws_iam_policy.spend_stop_deny_all.arn
      roles      = concat([aws_iam_role.acceptance.name], local.lane_roles)
    }
  }
  subscriber {
    address           = var.alert_email
    subscription_type = "EMAIL"
  }
}
# Lean profile: private RDS, no ingress, NAT, EKS, ALB or paid VPC endpoints.
resource "aws_vpc" "sandbox" {
  cidr_block           = "10.247.0.0/24"
  enable_dns_support   = true
  enable_dns_hostnames = true
}
variable "availability_zones" {
  type = list(string)
  validation {
    condition     = length(var.availability_zones) == 2 && length(distinct(var.availability_zones)) == 2
    error_message = "Two explicitly approved availability zones required."
  }
}
resource "aws_subnet" "private" {
  count                   = 2
  vpc_id                  = aws_vpc.sandbox.id
  cidr_block              = cidrsubnet(aws_vpc.sandbox.cidr_block, 1, count.index)
  availability_zone       = var.availability_zones[count.index]
  map_public_ip_on_launch = false
}
resource "aws_security_group" "database" {
  name   = "zenith-live-private-db"
  vpc_id = aws_vpc.sandbox.id
  # No ingress or egress, including from the internet or other tenants.
}
resource "aws_db_subnet_group" "private" {
  name       = "zenith-live-sandbox"
  subnet_ids = aws_subnet.private[*].id
}
variable "create_service_linked_roles" {
  description = "Set false only when the owner independently proves both roles already exist."
  type        = bool
  default     = true
}
resource "aws_iam_service_linked_role" "ecs" {
  count            = var.create_service_linked_roles ? 1 : 0
  aws_service_name = "ecs.amazonaws.com"
}
resource "aws_iam_service_linked_role" "rds" {
  count            = var.create_service_linked_roles ? 1 : 0
  aws_service_name = "rds.amazonaws.com"
}
output "role_arn" { value = aws_iam_role.acceptance.arn }
output "db_subnet_group" { value = aws_db_subnet_group.private.name }
output "db_security_group" { value = aws_security_group.database.id }
output "workload_boundary_arn" { value = aws_iam_policy.workload_boundary.arn }
