# Connecting an AWS account

For the person who owns the AWS account. Zenith never asks for an access key: it
proves who it is with a short-lived signed token (OpenID Connect) and AWS hands it
temporary credentials for one operation. This page explains what that gives
Zenith, what it does not, and how to take it back. **The commands and the
parameter tables are in [`deploy/aws/README.md`](../../../deploy/aws/README.md);
this page does not repeat them.**

Written against branch `ws/docs-sync-2`, based on `ws/integrate-w6` at `3c1fa66` (2026-10-01).

**Status, stated up front.** The bootstrap template and module, the broker and the
issuer are built and tested without an AWS account. **Nothing has been applied to
a real account and no real token has been exchanged with real STS.** The IAM
policies are written from the AWS documentation; expect that a first real
deployment may hit an `AccessDenied` that needs one more statement. The
deny-by-default posture makes that the safe direction. The Zenith-side form is
`/platform/connections/aws`, using the browser action adapter in
`src/app/(product)/platform/connections/aws/action/route.ts`. A standalone
`/api/platform/v1/connections` route remains absent; see
[What is not built](#what-is-not-built).

## What you run, and what it creates

You run one thing in your account, either as CloudFormation
(`deploy/aws/zenith-connection.cfn.yaml`) or as the equivalent OpenTofu module
(`deploy/aws/tofu-module/`). Both create the same resources. Steps and
parameters: [deploy/aws/README.md, Option A and B](../../../deploy/aws/README.md#option-a--cloudformation).

| Resource | What it is for |
|---|---|
| An IAM OIDC provider | Lets AWS verify Zenith's tokens (client id `sts.amazonaws.com`). One exists per issuer URL per account. |
| `ZenithObserveRole` | Read-only inspection. |
| `ZenithDeployRole` | The only role that changes things, and only things it is allowed to see as Zenith's. |
| Six family boundaries | App/identity, build, machine, scheduler, EKS cluster and EKS node roles each carry their own immutable boundary; the legacy `ZenithWorkloadBoundary` remains for migration. |
| A state bucket, `zenith-state-<account>-<region>` | OpenTofu state and build artifacts. Yours, and kept if you delete the stack. |
| `zenith-codebuild` role | Lets image builds run in **your** account, pushing only to `zenith-*` ECR repositories. |

There are no IAM users, access keys, passwords or secrets in any of it.

Zenith shows you two values when you start the connection, which you paste into
the parameters unchanged: the **issuer host** (for example
`app.example.com/api/oidc`, no scheme) and the **subject**
(`zenith:ws:<workspace>:conn:<connection>`). The trust policy compares the subject
**exactly**: only a token for that one workspace and connection can assume your
roles, and wildcards are refused. The issuer must be reachable on public HTTPS,
because AWS fetches its discovery document and key set itself.

## What Zenith can do in your account

Everything below is what the shipped policies grant, read from
`zenith-connection.cfn.yaml` and the deploy README; none of it has been exercised
against a live account.

### Observe (`ZenithObserveRole`)

Describe, list and get across the services Zenith manages (ECS, ECR, load
balancers, EC2 and networking, RDS, ElastiCache, SQS, Route 53, ACM, CloudWatch
metrics and logs, SSM describe-only, Secrets Manager describe and list only,
CodeBuild, Lambda configuration, EventBridge, Auto Scaling), tag lookups, and read
of `zenith-*` buckets, `zenith-*` IAM roles and the state bucket (OpenTofu plans
read state). This role is used for read capabilities and for the plan step.

### Deploy (`ZenithDeployRole`)

Create, change and delete **only** resources that carry the tag
`zenith:managed=true` or are named `zenith-*`. In detail, by policy:

| Area | What is allowed |
|---|---|
| Network | VPC, subnets, route tables, gateways, security groups, endpoints, launch templates, instances: create only with `zenith:managed=true` in the request; change or delete only what already carries it |
| Load balancing | ALB / NLB, target groups, listeners, rules, auto scaling groups named `zenith-*` |
| Compute | ECS clusters, services and tasks, ECR repositories, Lambda functions, EventBridge rules and CodeBuild projects, all `zenith-*` |
| Data | RDS, ElastiCache, S3 buckets, SQS queues and Secrets Manager **containers** (create, update, delete, tag), all `zenith-*` |
| Edge | Log groups and alarms named `zenith-*`, ACM certificates tagged `zenith:managed`, DNS record changes **only in the hosted zones you list** (an empty list means no DNS write access at all) |
| State | Read and write objects in the state bucket |
| IAM | Create, change and delete roles named `zenith-*` **only with one exact family boundary ARN attached**; attach only `zenith-*` policies plus enumerated AWS task/Lambda/EKS/SSM policies; `iam:PassRole` only to `zenith-*` roles for ECS tasks, CodeBuild and Lambda |

### How narrow a session is

Each operation gets its own session, not the role's full reach:

- **Short-lived.** The token Zenith presents lives two minutes and is used once;
  the resulting AWS session lasts 15 minutes by default and at most one hour
  (`DEFAULT_SESSION_SEC`, `MAX_SESSION_SEC` in `src/lib/credentials/aws/broker.ts`).
  The credentials exist in worker memory for one callback and are then
  invalidated; they are never stored, logged or returned.
- **Narrowed per capability.** For observation, log reads, service restart and
  scale, and database snapshots the broker adds an inline session policy that
  can only *remove* permissions from the role. Infrastructure apply and destroy
  get no session policy: a Terraform apply touches too many services to list in
  the 2,048-character limit, so the tag- and name-conditioned deploy role and the
  permission boundary are the control there
  ([session-policy.ts](../../../src/lib/credentials/aws/session-policy.ts) is explicit about this).
- **Tagged and named.** Every session carries the tags `zenith:workspace`,
  `zenith:operation` and `zenith:capability`, and the role session name is
  `zenith-<first 24 characters of the operation id>`, so a CloudTrail event can be
  traced to one Zenith operation. (How CloudTrail displays the tags was not
  checked.)

## What Zenith cannot do

As written in the template's explicit denies and its absence of grants:

- **Read secret values.** `secretsmanager:GetSecretValue` and `ssm:GetParameter*`
  are explicitly denied in the observe policy, which is attached to both the
  observe and the deploy role. The deploy role manages secret *containers* and
  never their values.
- **Create or change identities outside its fence.** It cannot create IAM users,
  access keys or login profiles, cannot touch OIDC or SAML providers, Organizations
  or the Account APIs, and cannot create a role without the permission boundary.
- **Change itself.** It cannot modify `ZenithDeploy*`, `ZenithObserve*`,
  `zenith-codebuild*` or the boundary, and cannot remove a permission boundary.
- **Touch the state bucket's security.** It can read and write state objects; it
  cannot delete or reconfigure the bucket or delete object versions.
- **Reach resources that do not follow the convention.** A resource that is not
  named `zenith-*` or tagged `zenith:managed=true` is simply outside its reach.
- **Write DNS outside the zones you listed.**
- **Run commands on your machines or containers.** The template grants no
  `ssm:SendCommand` and no `ecs:ExecuteCommand`, so the machine-plane transports
  are not enabled by it. The command-execution capabilities (`machine.exec`,
  `container.exec`) are a separate, critical-risk class that policy denies in
  production by default ([POLICY.md](POLICY.md)).

The build family boundary distinguishes CodeBuild roles through
`aws:PrincipalArn = arn:<partition>:iam::<account>:role/zenith-*-build` with
`ArnLike`. The driver reserves `-build` after shortening the role name, and
the generator checks the pattern against the shared naming constant.
Application role names do not match this pattern. Build-only grants cover
this account's `zenith-*` ECR repositories, `zenith-*/*` S3 object versions
(with `s3:ResourceAccount`), and this account's CloudFront distributions tagged
`zenith:managed=true`. The build's own policy narrows those grants to its exact
output resources and source prefix. CloudFront supports that resource-tag
condition for [CreateInvalidation](https://docs.aws.amazon.com/service-authorization/latest/reference/list_cloudfront.html).
CodeBuild project names must start with `zenith-`, so their logs fit the existing
`/aws/*/zenith-*` boundary. The deploy role cannot modify any family boundary policy.
Scheduled-job invocation roles use the reserved `-events` suffix and EC2
agent roles use `-ec2`, both appended after truncation/hashing. Their grants
require this account's matching `aws:PrincipalArn`; application, execution,
function and build roles cannot acquire them, including workloads named
`web-events` or `web-ec2`. Short role names stay stable; review replacements
when upgrading previously truncated names.

Events roles can run only this account's `task-definition/zenith-*`, with
`ecs:cluster` restricted to `cluster/zenith-*` ([AWS authorization support](https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazonelasticcontainerservice.html)).
They can pass only this account's `role/zenith-*` to
`ecs-tasks.amazonaws.com`; their inline policy narrows this further to the
job's task revision, cluster and exact roles. IAM administration remains
explicitly denied, as do other role families' PassRole requests, missing or
wrong destination services, Organizations, Account and state-bucket access.

EC2's [SSM managed core v2](https://docs.aws.amazon.com/aws-managed-policy/latest/reference/AmazonSSMManagedInstanceCore.html)
actions intersect the boundary at tagged, same-account EC2 instances,
same-account associations, AWS-owned documents and this account's
`document/Zenith-*`. Unscoped core inventory/manifest/list/package/patch calls
and agent message channels require the EC2 principal. Resource/condition
support for each action is recorded in the
[bootstrap boundary matrix](../../../deploy/aws/README.md#what-each-permission-is-for)
and [AWS's SSM authorization reference](https://docs.aws.amazon.com/service-authorization/latest/reference/list_awssystemsmanager.html).
`GetParameter(s)` remain confined to `parameter/zenith/*`; the agent needs no
additional parameter path for Zenith's command transport. This does not grant
the control plane `ssm:SendCommand` or `ecs:ExecuteCommand`.

The six family policies are selected centrally in `credentials/aws/naming.ts`.
App/identity roles also cover multipart uploads, log reads, both database engines'
IAM/credential grants, SNS/KMS publish and cache resource pairs. EKS cluster/node
policies cover every action in the frozen cluster v10, worker v3, CNI v6 and
registry read-only v3 inventories at the supported scoped request resources.
Every role-creating driver has local evaluator coverage in all three partitions.
Shared ECR login/pull, logs and EC2 reads are legitimate in multiple families;
a foreign-family principal is refused by a given family's boundary, while its
own boundary may permit a shared action. This is not live AWS acceptance.

The generator checks all managed policies at maximum environment-id/suffix
lengths, with optional KMS and two hosted zones enabled. Larger custom zone lists
need checking against the fully rendered deploy-edge policy.
Every new family boundary stays within 5,800 characters, legacy within 6,144,
and deploy policies within IAM's 6,144-character limit. Deploy's allow conditions
still enumerate exactly six policy ARNs; removing optional Allow Sids saves
space without changing permissions. Legacy keeps both IAM escalation denies;
its single state-ARN suffix pattern also denies bucket-name prefix collisions.
At maximum parameters GovCloud legacy uses 6,136/6,144 characters; only this
migration artifact is excepted from the 5,800 family budget. Foreign referenced targets and resources
outside the documented family scopes remain blocked; EKS cluster mutations
use same-account resource/principal fences where native resources lack Zenith
tags. See the [full scope and limitations](../../../deploy/aws/README.md#what-each-permission-is-for).

For existing connections, update the CloudFormation stack or bootstrap module
**first**. It creates the six family policies and updates deploy's allowlist,
while retaining the legacy policy. On the next environment apply, drivers move
each role to its family boundary; inspect previously truncated names and the
flow-log role's new `-flow` suffix, which can require replacements.
Never remove the boundary between steps. A customer administrator may retire the
legacy policy only after all roles have moved. Current compilers use default
unsuffixed policy names; nonempty bootstrap name suffixes need an as-yet unwired
connection-to-compiler family ARN mapping and are unsupported for workload apply.

Known limits of what IAM can express, from the template (not hidden): task
definition registration accepts only `Resource: "*"` in IAM, so Zenith can add
revisions to task definition families it can name but cannot change a running
service of yours (`UpdateService` is name- and boundary-scoped);
`ec2:RunInstances` on public AMIs has no tag to condition on, so the call fails
unless the instance, volumes and network interfaces are tagged
`zenith:managed=true`; `logs:GetQueryResults`, `StopQuery` and `DescribeQueries`
accept only `*`. EC2 instance profiles, application auto scaling and SSM
Parameter Store writes are **not** enabled.

One overlap to know about: name patterns end in `-` or `/`, so two environment ids
where one is a hyphen-delimited prefix of the other (`prod` and `prod-eu`) overlap
in name-based patterns. The exact-match `zenith:environment` tag is the precise
boundary where the AWS service supports it. Fixed-width ids (UUIDs) cannot overlap.

## What Zenith stores about your account

Only non-secret identifiers: account id, region, the two role ARNs, the state
bucket name, optionally a KMS key ARN, the optional legacy boundary and CodeBuild role ARNs
(`AwsConnectionConfig` in `src/lib/credentials/types.ts`, persisted in
`platform.provider_connections`). The store refuses a connection config that has
a member named like a secret (`secretAccessKey`, `password`, `token`, `apiKey`...)
or a value that looks like key material. Stealing Zenith's database yields no
cloud credential; the trust anchor is Zenith's OIDC signing key, which is why
production uses a KMS-backed one ([RECOVERY.md](RECOVERY.md#6-key-rotation)).

## Verifying the connection

You give Zenith the stack outputs: **account id, region, observe role ARN, deploy
role ARN, state bucket name** (and optional legacy boundary/CodeBuild outputs). Family boundary outputs are
bootstrap artifacts; current drivers select the unsuffixed family map. Zenith verifies by assuming the observe role and calling
`sts:GetCallerIdentity`; the account id must match. Until that passes the
connection stays `pending_verification` and nothing runs. That check is
`AwsCredentialBroker.verifyConnection`.

In the browser, save the non-secret identifiers, deploy the generated trust
bootstrap in the customer account, then verify using `connection.createAws`
and `connection.verifyAws`. The page's adapter checks the reviewed workspace
against the current workspace cookie and requires a live browser session.
The product connection is mirrored to `platform.provider_connections` by the
connection actions. Verification establishes observe-role identity only;
deploy permissions, runner availability and worker health remain unverified.

If assuming the role is denied, work through
[Troubleshooting `AccessDenied` on assume](../../../deploy/aws/README.md#troubleshooting-accessdenied-on-assume)
in the deploy README: the OIDC provider for exactly that issuer URL, the exact
subject, the audience `sts.amazonaws.com`, the two public endpoints returning
JSON without a login redirect, `sts:TagSession` still in the trust policy, and the
CloudTrail `AssumeRoleWithWebIdentity` event.

## Revoking Zenith

Fastest to slowest; each takes effect for **new** sessions immediately. A session
Zenith already holds lasts at most its 15 minute to one hour lifetime. The
step-by-step is in [deploy/aws/README.md, Revoke Zenith](../../../deploy/aws/README.md#revoke-zenith);
in short:

1. **Delete the OIDC provider.** Nothing can federate in any more. If other Zenith
   connections in this account share the provider they stop too.
2. **Delete the stack** (or `tofu destroy`): the roles, policies and, if the stack
   created it, the OIDC provider go. **The state bucket is kept.**
3. **Narrow instead of revoke:** redeploy with `EnvironmentTagValue` set to one
   environment and an empty `Route53HostedZoneArns`.

What survives revocation: the resources Zenith created (tagged
`zenith:managed=true`) are **yours** and keep running, and so does the state
bucket. Find everything Zenith made with
`aws resourcegroupstaggingapi get-resources --tag-filters Key=zenith:managed,Values=true`.
The exported OpenTofu in the product (`docs/LIMITATIONS.md`, AWS Preview) is real,
applyable IaC if you want to carry on without Zenith.

## Managed database backups

Private beta limitation: Zenith does not back up or restore managed databases (`aws:rds_instance`). The database lives in your account, so its recovery is yours to configure and rehearse:

- **Automated backups.** Zenith keeps AWS automated backups on with 7-day retention by default (no `backup` set, or `daily` or `hourly`). Keep it, or raise it in the RDS console or your own IaC. `backup: none` with `deletionPolicy: allow` sets retention to 0, which leaves no automated restore point; with `deny` or `approval` it keeps 1 day. Do not use `none` for data you need to recover.
- **Restore.** Zenith offers no restore in the beta. Restore with AWS point-in-time restore in the RDS console or CLI.
- **Final snapshot on delete.** Zenith always asks for a final snapshot named `<identifier>-final`. Deleting, recreating and deleting the same database again collides with that name, and AWS refuses to overwrite it. Copy or rename the earlier snapshot first.
- **Deletion protection.** On, unless `deletionPolicy: allow`.
- **Copies, restores and point-in-time recovery drills.** Cross-region or cross-account snapshot copies and restore tests are yours. Zenith's own platform backup (hosted backup to S3) is a separate system and is not described here.

Source: `src/lib/providers/aws/drivers/data/rds-compile.ts` (retention, final snapshot and deletion protection).

## Drift on AWS

Private beta limitation: drift is not alerted on AWS, and the legacy AWS adapter detects nothing.

- **Not detected:** the legacy Preview adapter (`src/lib/providers/aws/provider.ts`) refuses `observe` and `discover`; it reads no AWS account.
- **Detected, when the reconcile sweep runs:** for driver-backed resources, `missing` (not found on AWS) and `changed` (an attribute the driver compares differs, for example an RDS instance's engine, class, Multi-AZ, encryption, public access, deletion protection or backup retention). A driver that cannot observe reports `unknown`.
- **Not detected:** attributes the driver does not compare, and anything Zenith does not manage.
- **Manual check:** run the environment's next plan (the plan step of the next deploy). It refreshes the recorded state from AWS and lists the change that would correct each Terraform-managed difference, or recreate a resource deleted outside Zenith. Plan is read-only; review it before applying.
- **No alerts and no automatic fix.** Findings show on the environment's platform page when someone opens it. Nothing is sent, and Zenith does not change AWS to fix drift.

## What is not built

- **A standalone connections REST endpoint.** Browser AWS setup exists; bearer
  clients cannot infer a `/api/platform/v1/connections` API from that page.
- **Non-AWS connections.** Six providers' drivers are registered, and
  `src/lib/platform/credentials.ts` performs connection verification for GCP (STS exchange + projects.get), Azure (ARM token + subscription read), Kubernetes (namespaced read) and OCI (runner registration only; cloud permissions unverified).
  OCI ProviderSessions run only through an active registered runner (`oci.http`); runner-mode sessions for the other non-AWS providers are still refused.
- **Live deploy acceptance.** The worker registers execution implementations
  and the AWS registrar composes all driver groups (`src/lib/platform/drivers.ts`).
  They carry contract evidence, not a live-account run. An approved dispatch
  is not a verified deployment.
- **SSM permission by default.** Default composition supplies the `machines`
  port and selects AWS SSM fixed documents for observed EC2 targets. Calls use
  the operation's credential-broker session and existing policy/approval gates;
  `machine.exec` remains an admin-approved escape hatch. This wiring has no live
  transport evidence. The shipped bootstrap grants no `ssm:SendCommand`. Install
  the fixed documents in `deploy/aws/ssm-documents/` and deliberately extend
  permissions if enabling that transport.
- **Live runner end-to-end verification.** AWS runner sessions enqueue/await
  through `src/lib/runners/aws-runner-transport.ts`; signed paths pass session
  middleware, and cron reaps expired jobs. See [RUNNER.md](../RUNNER.md).
  That wiring has not been exercised against a customer runner and AWS here.
