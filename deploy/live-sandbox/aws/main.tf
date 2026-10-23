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
  name          = "ZenithLiveAcceptance"
  base          = "arn:aws"
  iam           = "${local.base}:iam::${var.account_id}"
  tags          = { "zenith:bootstrap" = "live-sandbox" }
  workload_role = "${local.iam}:role/zenith-zlive-*-lambda"
  boundary      = "${local.iam}:policy/ZenithLiveWorkloadBoundary"
  owned_tags = {
    StringEquals = { "aws:ResourceTag/zenith:purpose" = "live-acceptance", "aws:ResourceTag/zenith:managed" = "true" }
  }
  request_tags = {
    StringEquals = { "aws:RequestTag/zenith:purpose" = "live-acceptance", "aws:RequestTag/zenith:managed" = "true" }
    StringLike   = { "aws:RequestTag/zenith:live-run" = "zlive-*" }
  }
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
        "token.actions.githubusercontent.com:sub" = "repo:${var.github_repository}:environment:live-sandbox"
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
    { Sid = "ZoneDelete", Effect = "Allow", Action = ["route53:DeleteHostedZone"], Resource = "${local.base}:route53:::hostedzone/*" }
  ]
  runner_policy = jsonencode({ Version = "2012-10-17", Statement = local.statements })
}
resource "aws_iam_policy" "runner_boundary" {
  name = "ZenithLiveRunnerBoundary"
  # Action ceiling only; the role's identity policy below further narrows every
  # operation to its supported resources/conditions. No policy edit/attach grant.
  policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = distinct(flatten([for statement in local.statements : statement.Action])), Resource = "*" }] })
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
