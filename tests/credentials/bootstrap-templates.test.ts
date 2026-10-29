/**
 * Static checks on the customer bootstrap artifacts: deploy/aws/zenith-connection.cfn.yaml
 * and its OpenTofu equivalent. These parse and EVALUATE the template (Ref, Sub,
 * If, Join …) for several parameter sets and assert the security properties the
 * README promises. They do not — cannot — prove the policies work against real
 * AWS; see the README's "verified vs unverified" section.
 */
import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { boundarySizes, checkBoundarySizes, checkPolicies, generate, POLICIES_DIR, TEMPLATE_PATH } from "../../deploy/aws/tools/generate-tofu-policies";
import { sessionPolicyFor } from "@/lib/credentials/aws";
import { AWS_ROLE_BOUNDARIES, BUILD_ROLE_NAME_PATTERN } from "@/lib/credentials/aws/naming";
import { boundaryAllows } from "./workload-boundary";
import {
  asList,
  compactSize,
  iamGlob,
  loadTemplate,
  makeEvaluator,
  resolveResource,
  statementsOf,
  type Evaluator,
  type Statement,
} from "./cfn";
import { ACCOUNT } from "./helpers";

const template = loadTemplate(TEMPLATE_PATH);
const MODULE_DIR = path.resolve(path.dirname(TEMPLATE_PATH), "tofu-module");
const execFileAsync = promisify(execFile);

const ISSUER_HOST = "app.tryzenith.cloud/api/oidc";
const SUBJECT = "zenith:ws:ws_1:conn:conn_1";
const KMS = "arn:aws:kms:ap-south-1:123456789012:key/11111111-2222-3333-4444-555555555555";
const ZONES = "arn:aws:route53:::hostedzone/Z0123456789ABC,arn:aws:route53:::hostedzone/Z9876543210XYZ";
const PRINCIPAL = "arn:aws:iam::210987654321:role/zenith-control";

const SCENARIOS: Record<string, Record<string, string>> = {
  oidc: { ZenithIssuerHost: ISSUER_HOST, ZenithOidcSubject: SUBJECT },
  everything: {
    ZenithIssuerHost: ISSUER_HOST,
    ZenithOidcSubject: SUBJECT,
    CreateOidcProvider: "no",
    ZenithPrincipalArn: PRINCIPAL,
    ExternalId: "zx-0123456789abcdef",
    StateBucketKmsKeyArn: KMS,
    Route53HostedZoneArns: ZONES,
    NameSuffix: "-team-a",
    EnvironmentTagValue: "env_prod1",
  },
  assumeRoleOnly: { ZenithPrincipalArn: PRINCIPAL, ExternalId: "zx-0123456789abcdef" },
};

const MANAGED = Object.entries(template.Resources)
  .filter(([, r]) => r.Type === "AWS::IAM::ManagedPolicy")
  .map(([id]) => id);
const DEPLOY_POLICIES = MANAGED.filter((id) => id.startsWith("Deploy"));

const evaluatorFor = (name: string): Evaluator => makeEvaluator(template, { params: SCENARIOS[name] });

function policyDoc(ev: Evaluator, logicalId: string): unknown {
  return resolveResource(template, ev, logicalId)!.PolicyDocument;
}

function allPolicyDocuments(ev: Evaluator): { where: string; doc: unknown }[] {
  const docs: { where: string; doc: unknown }[] = [];
  for (const [id, res] of Object.entries(template.Resources)) {
    const props = resolveResource(template, ev, id);
    if (!props) continue;
    if (res.Type === "AWS::IAM::ManagedPolicy" || res.Type === "AWS::S3::BucketPolicy") docs.push({ where: id, doc: props.PolicyDocument });
    if (res.Type === "AWS::IAM::Role") {
      docs.push({ where: `${id}.AssumeRolePolicyDocument`, doc: props.AssumeRolePolicyDocument });
      for (const p of (props.Policies as { PolicyName: string; PolicyDocument: unknown }[] | undefined) ?? []) {
        docs.push({ where: `${id}.Policies.${p.PolicyName}`, doc: p.PolicyDocument });
      }
    }
  }
  return docs;
}

const READ_VERB = /^[a-z0-9-]+:(Describe|List|Get|BatchGet|Lookup|Search|Check|Head|View|Query|Scan|Filter|StartQuery|StopQuery|Decrypt|GenerateDataKey|Batch(Check|Get))/i;

const allows = (statements: Statement[]) => statements.filter((s) => s.Effect === "Allow");

describe("template structure", () => {
  it("parses with CloudFormation tags and declares the resources the README documents", () => {
    const types = Object.fromEntries(Object.entries(template.Resources).map(([id, r]) => [id, r.Type]));
    expect(types).toMatchObject({
      OidcProvider: "AWS::IAM::OIDCProvider",
      StateBucket: "AWS::S3::Bucket",
      StateBucketPolicy: "AWS::S3::BucketPolicy",
      WorkloadBoundary: "AWS::IAM::ManagedPolicy",
      ObserveRole: "AWS::IAM::Role",
      DeployRole: "AWS::IAM::Role",
      CodeBuildRole: "AWS::IAM::Role",
    });
    expect(Object.keys(template.Outputs)).toEqual(
      expect.arrayContaining(["ObserveRoleArn", "DeployRoleArn", "StateBucketName", "CodeBuildRoleArn", "WorkloadBoundaryArn", "AccountId"])
    );
    expect(Object.keys(template.Parameters)).toEqual(
      expect.arrayContaining(["ZenithIssuerHost", "ZenithOidcSubject", "CreateOidcProvider", "ExternalId", "ZenithPrincipalArn", "EnvironmentTagValue"])
    );
  });

  it("creates the OIDC provider for sts.amazonaws.com against the issuer (and only when asked)", () => {
    const on = resolveResource(template, evaluatorFor("oidc"), "OidcProvider")!;
    expect(on.Url).toBe(`https://${ISSUER_HOST}`);
    expect(on.ClientIdList).toEqual(["sts.amazonaws.com"]);
    expect(resolveResource(template, evaluatorFor("everything"), "OidcProvider")).toBeUndefined();
    expect(resolveResource(template, evaluatorFor("assumeRoleOnly"), "OidcProvider")).toBeUndefined();
  });

  it("validates parameters: exact subject only, no wildcards, no scheme, sane suffix", () => {
    const ok = (name: string, value: string) => new RegExp(template.Parameters[name].AllowedPattern!).test(value);
    expect(ok("ZenithOidcSubject", SUBJECT)).toBe(true);
    for (const bad of ["zenith:ws:*:conn:*", "zenith:ws:ws_1:conn:*", "zenith:ws:a:conn:b:c", "zenith:ws:ws_1", "repo:evil/x:*", "zenith:ws:ws 1:conn:c"]) {
      expect(ok("ZenithOidcSubject", bad)).toBe(false);
    }
    expect(ok("ZenithIssuerHost", ISSUER_HOST)).toBe(true);
    for (const bad of [`https://${ISSUER_HOST}`, "App.Example.com", "app.example.com/api oidc", "-bad.example.com"]) {
      expect(ok("ZenithIssuerHost", bad)).toBe(false);
    }
    expect(ok("NameSuffix", "-team-a")).toBe(true);
    expect(ok("NameSuffix", "team-a")).toBe(false);
    expect(ok("ExternalId", "x")).toBe(false);
    expect(ok("ExternalId", "zx-0123456789abcdef")).toBe(true);
    expect(ok("ZenithPrincipalArn", PRINCIPAL)).toBe(true);
    expect(ok("ZenithPrincipalArn", "*")).toBe(false);
  });
});

describe.each(["aws", "aws-cn", "aws-us-gov"])("boundary size in %s", (partition) => {
  it.each(Object.keys(SCENARIOS))("fits IAM's 6,144-character limit for %s", (scenario) => {
    const ev = makeEvaluator(template, { params: SCENARIOS[scenario], pseudo: { partition, accountId: ACCOUNT, region: "eu-west-1" } });
    for (const id of MANAGED) expect(compactSize(policyDoc(ev, id)), id).toBeLessThanOrEqual(6144);
  });
});

it("all selectable family boundaries preserve headroom at maximum suffix/environment lengths, and all deploy policies fit in every partition", () => {
  expect(checkBoundarySizes).not.toThrow();
  const sizes = boundarySizes();
  expect(sizes).toHaveLength(MANAGED.length * 3);
  for (const { logicalId, size, limit } of sizes) {
    expect(size, logicalId).toBeLessThanOrEqual(limit);
    if (Object.values(AWS_ROLE_BOUNDARIES).some((spec) => spec.logicalId === logicalId)) expect(limit).toBe(5800);
  }
});

it("adds the exact bootstrap version read statement and preserves the reviewed resource and policy inventory", () => {
  const resources = structuredClone(template.Resources);
  const properties = resources.ObservePolicy.Properties;
  const document = properties?.PolicyDocument;
  if (!properties || !document || typeof document !== "object" || Array.isArray(document) || !("Statement" in document) || !Array.isArray(document.Statement)) throw new Error("Malformed observe policy source.");
  const additions = document.Statement.filter((statement: unknown) => statement !== null && typeof statement === "object" && "Sid" in statement && statement.Sid === "ReadBootstrapBoundaryVersions");
  expect(additions).toEqual([{
    Sid: "ReadBootstrapBoundaryVersions", Effect: "Allow", Action: ["iam:GetPolicy", "iam:GetPolicyVersion"],
    Resource: ["AppBoundary", "BuildBoundary", "MachineBoundary", "SchedulerBoundary", "EksClusterBoundary", "EksNodeBoundary", "WorkloadBoundary"].map((Ref) => ({ Ref })),
  }]);
  properties.PolicyDocument = { ...document, Statement: document.Statement.filter((statement: unknown) => !additions.includes(statement)) };
  // Reviewed 9b568108 resource inventory with the exact read-only statement removed.
  // Incoming bootstrap changes include suffix-scoped image pointers and bounded flow-log/IAM policies, and EC2 child
  // creation authorized against tagged parents plus tagged security-group rules, then flow-log tag-on-create, the
  // ELB-forwarded ec2:GetSecurityGroupsForVpc read, role instance-profile listing and EIP disassociation for destroy
  // (DEPLOY-01 live denials, 2026-10-26), then lambda:GetFunctionCodeSigningConfig, which the AWS provider reads after every
  // Zip function create and refresh (MIX-03 live denial, 2026-10-28), then secretsmanager:GetResourcePolicy (observe), which
  // the AWS provider reads for every managed secret container on create, refresh and destroy (OPS-06 live denial, 2026-10-29).
  expect(createHash("sha256").update(JSON.stringify(resources)).digest("hex")).toBe("17c3da155f32260f67535d71cd3d3dff2798b6549bc25303181066a011fb3f6e");
});

describe.each(["aws", "aws-cn", "aws-us-gov"])("exact bootstrap boundary reads in %s", (partition) => {
  it.each(["", "-team-a", `-${"x".repeat(19)}`])("allows only the seven exact account/partition/suffix policy identities for suffix %j", (NameSuffix) => {
    const ev = makeEvaluator(template, { params: { NameSuffix }, pseudo: { partition, accountId: ACCOUNT, region: "eu-west-1" } });
    const statements = statementsOf(policyDoc(ev, "ObservePolicy"));
    const read = statements.find((statement) => statement.Sid === "ReadBootstrapBoundaryVersions")!;
    const arns = [...Object.values(AWS_ROLE_BOUNDARIES).map((family) => `arn:${partition}:iam::${ACCOUNT}:policy/${family.policyName}${NameSuffix}`), `arn:${partition}:iam::${ACCOUNT}:policy/ZenithWorkloadBoundary${NameSuffix}`];
    expect(read.Action).toEqual(["iam:GetPolicy", "iam:GetPolicyVersion"]);
    expect(read.Resource).toEqual(arns);
    expect(read.Condition).toBeUndefined();
    for (const arn of arns) {
      for (const action of ["iam:GetPolicy", "iam:GetPolicyVersion"]) expect(boundaryAllows(statements, action, arn)).toBe(true);
      for (const action of ["iam:CreatePolicyVersion", "iam:SetDefaultPolicyVersion", "iam:DeletePolicy", "iam:PutRolePermissionsBoundary", "iam:DeleteRolePermissionsBoundary"]) expect(boundaryAllows(statements, action, arn)).toBe(false);
      for (const foreign of [arn.replace(ACCOUNT, "210987654321"), arn.replace(`arn:${partition}:`, `arn:${partition === "aws" ? "aws-cn" : "aws"}:`), `${arn}-foreign`, arn.replace(":policy/", ":policy/foreign/")]) {
        for (const action of ["iam:GetPolicy", "iam:GetPolicyVersion"]) expect(boundaryAllows(statements, action, foreign)).toBe(false);
      }
    }
    expect(compactSize(policyDoc(ev, "ObservePolicy"))).toBeLessThanOrEqual(6144);
  });
});

it("legacy retains every pre-split grant and escalation deny, strengthening only the state namespace deny", () => {
  const prior = fs.readFileSync(path.resolve("tests/credentials/legacy-workload-boundary.json"), "utf8");
  for (const partition of ["aws", "aws-cn", "aws-us-gov"]) {
    const ev = makeEvaluator(template, { pseudo: { partition, accountId: ACCOUNT, region: "eu-west-1" } });
    const stateArn = `arn:${partition}:s3:::${ev.resourceRef("StateBucket")}`;
    const vars: Record<string, string> = { partition, account_id: ACCOUNT, region: "eu-west-1", environment_tag_value: "*", state_bucket_arn: stateArn };
    const baseline = JSON.parse(prior.replace(/\$\{(\w+)\}/g, (_match, key: string) => vars[key]));
    const actual = JSON.parse(JSON.stringify(policyDoc(ev, "WorkloadBoundary")));
    const stateDeny = actual.Statement.find((statement: Statement) => statement.Effect === "Deny" && statement.Action === "s3:*");
    expect(stateDeny.Resource).toBe(`${stateArn}*`);
    const principal = { "aws:PrincipalArn": `arn:${partition}:iam::${ACCOUNT}:role/zenith-env-web-build`, "s3:ResourceAccount": ACCOUNT };
    for (const resource of [stateArn, `${stateArn}/state.tf`, `${stateArn}-prefix-collision/object`]) expect(boundaryAllows(statementsOf(actual), "s3:GetObject", resource, principal)).toBe(false);
    stateDeny.Resource = [stateArn, `${stateArn}/*`];
    expect(actual).toEqual(baseline);
  }
});

describe.each(Object.keys(SCENARIOS))("IAM policies (%s)", (scenario) => {
  const ev = evaluatorFor(scenario);
  const docs = allPolicyDocuments(ev);
  it("uploads and reads C3 source objects only in the configured environment and customer account", () => {
    const source = statementsOf(policyDoc(ev, "DeployDataPolicy")).find((s) => s.Sid === "S3SourceBundleObjects")!;
    const environment = scenario === "everything" ? "env_prod1" : "*";
    expect(source.Effect).toBe("Allow");
    expect(asList(source.Action).sort()).toEqual(["s3:GetObject", "s3:GetObjectVersion", "s3:PutObject"]);
    expect(source.Resource).toBe(`arn:aws:s3:::zenith-*/zenith/${environment}/*`);
    expect(source.Condition).toEqual({ StringEquals: { "s3:ResourceAccount": ACCOUNT } });
    const arn = `arn:aws:s3:::zenith-env-prod-web-src/zenith/env_prod1/web/${"a".repeat(64)}.zip`;
    expect(iamGlob(asList(source.Resource)[0], arn)).toBe(true);
    for (const foreign of [arn.replace("zenith-env-prod", "foreign-env-prod"), arn.replace("/zenith/", "/source/"), arn.replace("/zenith/", "/artifacts/")]) {
      expect(iamGlob(asList(source.Resource)[0], foreign)).toBe(false);
    }
    if (scenario === "everything") {
      expect(iamGlob(asList(source.Resource)[0], arn.replace("/env_prod1/", "/env_prod10/"))).toBe(false);
      expect(iamGlob(asList(source.Resource)[0], arn.replace("/env_prod1/", "/foreign/"))).toBe(false);
    }
  });
  it("SNS/EBS/EKS mutations require creation or resource tags and account/environment ARN scopes", () => {
    const statement = (policy: string, sid: string) => statementsOf(policyDoc(ev, policy)).find((s) => s.Sid === sid)!;
    for (const [policy, sid, tag] of [
      ["DeployDataPolicy", "SnsCreateTaggedTopics", "RequestTag"], ["DeployDataPolicy", "SnsManageTaggedTopics", "ResourceTag"],
      ["DeployNetworkPolicy", "EbsCreateTaggedVolumes", "RequestTag"], ["DeployNetworkPolicy", "EbsManageTaggedVolumesAndInstances", "ResourceTag"],
      ["DeployComputePolicy", "EksCreateTaggedCluster", "RequestTag"], ["DeployComputePolicy", "EksCreateTaggedChildren", "RequestTag"],
      ["DeployComputePolicy", "EksManageTaggedResources", "ResourceTag"],
    ]) {
      const s = statement(policy, sid);
      expect(s.Condition?.StringEquals?.[`aws:${tag}/zenith:managed`], sid).toBe("true");
      expect(s.Condition?.StringLike?.[`aws:${tag}/zenith:environment`], sid).toBe(scenario === "everything" ? "env_prod1" : "*");
      if (sid !== "EksCreateTaggedCluster") expect(asList(s.Resource).every((arn) => arn.includes(ACCOUNT) && arn !== "*"), sid).toBe(true);
    }
    const attach = statement("DeployNetworkPolicy", "EbsManageTaggedVolumesAndInstances");
    expect(asList(attach.Resource)).toEqual([`arn:aws:ec2:*:${ACCOUNT}:volume/*`, `arn:aws:ec2:*:${ACCOUNT}:instance/*`]);
    expect(statement("DeployComputePolicy", "EksCreateTaggedCluster").Condition?.Bool).toEqual({ "eks:bootstrapClusterCreatorAdminPermissions": "false" });
    expect(statement("DeployEdgePolicy", "KmsGrantToAwsResources").Condition?.Bool).toEqual({ "kms:GrantIsForAWSResource": "true" });
    expect(asList(statement("DeployNetworkPolicy", "Ec2TagOnCreate").Condition?.StringEquals?.["ec2:CreateAction"] as string[])).toContain("CreateVolume");
  });

  it("permits native CNI ENIs without Zenith tags while protecting node and resource tags", () => {
    const statements = statementsOf(policyDoc(ev, "WorkloadBoundary"));
    const eni = statements.find((s) => asList(s.Action).includes("ec2:AttachNetworkInterface") && !s.Condition)!;
    expect(asList(eni.Resource).filter((r) => r.split(":")[2] === "ec2")).toEqual([`arn:aws:ec2:*:${ACCOUNT}:network-interface/*`]);
    expect(eni.Condition).toBeUndefined();
    const node = statements.find((s) => asList(s.Action).includes("ec2:AttachNetworkInterface") && s.Condition)!;
    expect(asList(node.Resource)).toEqual([`arn:aws:ec2:*:${ACCOUNT}:instance/*`]);
    expect(node.Condition?.StringEquals?.["aws:ResourceTag/zenith:managed"]).toBe("true");
    expect(node.Condition?.StringLike?.["aws:ResourceTag/zenith:environment"]).toBe(scenario === "everything" ? "env_prod1" : "*");
    const tagging = statements.find((s) => s.Action === "ec2:CreateTags")!;
    expect(asList(tagging.Resource)).toEqual([`arn:aws:ec2:*:${ACCOUNT}:network-interface/*`]);
    expect(asList(tagging.Condition?.["ForAllValues:StringEquals"]?.["aws:TagKeys"] as string[])).toEqual([
      "node.k8s.amazonaws.com/instance_id", "node.k8s.amazonaws.com/createdAt", "cluster.k8s.amazonaws.com/name", "eks:eni:owner",
    ]);
  });

  it("never allows Action * or service:* — and never Action * on Resource *", () => {
    for (const { where, doc } of docs) {
      for (const s of allows(statementsOf(doc))) {
        for (const a of asList(s.Action)) {
          expect(a, `${where}/${s.Sid}`).not.toMatch(/^\*$|:\*$/);
        }
        const wild = asList(s.Action).includes("*") && asList(s.Resource).includes("*");
        expect(wild, `${where}/${s.Sid} allows * on *`).toBe(false);
        expect(s.NotAction, `${where}/${s.Sid}`).toBeUndefined();
      }
    }
  });

  it("has unique Sids, no Principal in identity policies, and stays within IAM size limits", () => {
    for (const { where, doc } of docs) {
      const statements = statementsOf(doc);
      const sids = statements.map((s) => s.Sid).filter(Boolean);
      expect(new Set(sids).size, `${where} duplicate Sid`).toBe(sids.length);
      if (!where.includes("AssumeRolePolicyDocument") && !where.startsWith("StateBucketPolicy")) {
        for (const s of statements) expect(s.Principal, `${where}/${s.Sid}`).toBeUndefined();
      }
      if (MANAGED.includes(where)) expect(compactSize(doc), `${where} (managed policy limit 6,144)`).toBeLessThanOrEqual(6144);
      if (where.includes("AssumeRolePolicyDocument")) {
        expect(JSON.stringify(typeof doc === "string" ? JSON.parse(doc) : doc).length, `${where} trust policy (2,048)`).toBeLessThanOrEqual(2048);
      }
    }
    for (const role of ["ObserveRole", "DeployRole", "CodeBuildRole"]) {
      const props = resolveResource(template, ev, role)!;
      const inline = ((props.Policies as { PolicyDocument: unknown }[] | undefined) ?? []).reduce((n, p) => n + compactSize(p.PolicyDocument), 0);
      expect(inline, `${role} inline policies (10,240)`).toBeLessThanOrEqual(10240);
      expect(asList(props.ManagedPolicyArns as string[] | undefined).length, `${role} managed policies`).toBeLessThanOrEqual(8);
    }
  });

  it("observe policy is read-only and can never read secret values", () => {
    const statements = statementsOf(policyDoc(ev, "ObservePolicy"));
    for (const s of allows(statements)) {
      for (const a of asList(s.Action)) expect(a, `${s.Sid}`).toMatch(READ_VERB);
    }
    const deny = statements.find((s) => s.Sid === "NeverReadSecretValues")!;
    expect(deny.Effect).toBe("Deny");
    expect(asList(deny.Action)).toEqual(expect.arrayContaining(["secretsmanager:GetSecretValue", "ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"]));
    // secretsmanager: describe/list and the resource policy only (the AWS provider reads it for every managed secret); never a value
    const secrets = allows(statements).flatMap((s) => asList(s.Action)).filter((a) => a.startsWith("secretsmanager:"));
    expect(secrets.sort()).toEqual(["secretsmanager:DescribeSecret", "secretsmanager:GetResourcePolicy", "secretsmanager:ListSecrets"]);
  });

  it("every mutating deploy-role permission is tag- or name-conditioned (documented exceptions only)", () => {
    // AWS offers no resource-level control for these; each is called out in the template header.
    const EXCEPTIONS: Record<string, string> = {
      EcsTaskDefinitionRevisions: "ecs:RegisterTaskDefinition/DeregisterTaskDefinition only support Resource *",
      Ec2RunInstancesFromImages: "AMIs and snapshots are not ours; RunInstances is still denied without tagged instance/volume/ENI",
      SsmImagePointerParameters: "SSM parameters have no tag scoping for new values; access is limited to the plain-String ECS image pointer prefix /zenith<suffix>/image-pointer/*, and the read deny carves out only that prefix",
      CloudFrontOriginAccessControls: "CloudFront origin access controls support neither tags nor name scoping in IAM; they only restrict origin access",
      Ec2DisassociateAddressByAssociation: "DisassociateAddress by AssociationId (OpenTofu's EIP destroy) resolves to no resource ARN; it only detaches an address (availability, not access)",
    };
    const seen = new Set<string>();
    for (const id of DEPLOY_POLICIES) {
      for (const s of allows(statementsOf(policyDoc(ev, id)))) {
        const mutating = asList(s.Action).filter((a) => !READ_VERB.test(a));
        if (mutating.length === 0) continue;
        if (s.Sid! in EXCEPTIONS) {
          seen.add(s.Sid!);
          continue;
        }
        const condKeys = Object.values(s.Condition ?? {}).flatMap((c) => Object.keys(c));
        const tagged = condKeys.some((k) => /^aws:(Request|Resource)Tag\/zenith:managed$/.test(k));
        const iamGuard = condKeys.some((k) => ["iam:PermissionsBoundary", "iam:PassedToService", "iam:AWSServiceName"].includes(k));
        const resources = asList(s.Resource);
        const scoped = resources.length > 0 && resources.every((r) => r !== "*" && (r.includes("zenith") || !r.includes("*")));
        expect(tagged || iamGuard || scoped, `${id}/${s.Sid} mutates ${mutating.join(", ")} without a tag or name condition`).toBe(true);
      }
    }
    // the exceptions list itself must not go stale
    expect([...seen].sort()).toEqual(Object.keys(EXCEPTIONS).sort());
  });

  it("the deploy role can never read or write secret values, mint credentials or touch the OIDC provider", () => {
    const allowed = DEPLOY_POLICIES.flatMap((id) => allows(statementsOf(policyDoc(ev, id))));
    // Documented, path-scoped exception: plain-String ECS image pointers under /zenith<suffix>/ only.
    const pointer = allowed.filter((s) => s.Sid === "SsmImagePointerParameters");
    expect(pointer).toHaveLength(1);
    expect(asList(pointer[0].Resource)).toEqual([`arn:aws:ssm:*:${ACCOUNT}:parameter/zenith${SCENARIOS[scenario].NameSuffix ?? ""}/image-pointer/*`]);
    expect(asList(pointer[0].Action).sort()).toEqual(["ssm:AddTagsToResource", "ssm:DeleteParameter", "ssm:GetParameter", "ssm:GetParameters", "ssm:ListTagsForResource", "ssm:PutParameter", "ssm:RemoveTagsFromResource"]);
    expect(pointer[0].Condition).toBeUndefined();
    const actions = allowed.filter((s) => s.Sid !== "SsmImagePointerParameters").flatMap((s) => asList(s.Action));
    for (const forbidden of [
      "secretsmanager:GetSecretValue",
      "secretsmanager:PutSecretValue",
      "ssm:GetParameter",
      "ssm:PutParameter",
      "iam:CreateAccessKey",
      "iam:CreateUser",
      "iam:CreateLoginProfile",
      "iam:CreateOpenIDConnectProvider",
      "sts:AssumeRole",
      "iam:DeleteRolePermissionsBoundary",
    ]) {
      expect(actions, forbidden).not.toContain(forbidden);
    }
  });

  it("IAM: roles are created/changed only with the permission boundary, PassRole is service-limited, self-modification is denied", () => {
    const statements = statementsOf(policyDoc(ev, "DeployIamPolicy"));
    const boundary = Object.values(AWS_ROLE_BOUNDARIES).map((spec) => evaluatorForRef(ev, spec.logicalId));
    const byActionAllowed = (action: string) => allows(statements).filter((s) => asList(s.Action).includes(action));

    for (const action of ["iam:CreateRole", "iam:PutRolePolicy", "iam:AttachRolePolicy", "iam:DetachRolePolicy", "iam:DeleteRolePolicy", "iam:DeleteRole"]) {
      const found = byActionAllowed(action);
      expect(found.length, action).toBe(1);
      expect(found[0].Condition?.StringEquals?.["iam:PermissionsBoundary"], action).toEqual(boundary);
      expect(asList(found[0].Resource), action).toEqual([`arn:aws:iam::${ACCOUNT}:role/zenith-*`]);
    }
    const attach = byActionAllowed("iam:AttachRolePolicy")[0];
    expect(asList(attach.Condition?.ArnLike?.["iam:PolicyARN"] as string[]).every((a) => /policy\/zenith-\*$|policy\/(AmazonEKSClusterPolicy|AmazonEKSWorkerNodePolicy|AmazonEKS_CNI_Policy|AmazonEC2ContainerRegistryReadOnly|AmazonSSMManagedInstanceCore)$|policy\/service-role\/(AmazonECSTaskExecutionRolePolicy|AWSLambda(Basic|VPCAccess)ExecutionRole)$/.test(a))).toBe(true);

    const pass = byActionAllowed("iam:PassRole")[0];
    expect(pass.Condition?.StringEquals?.["iam:PassedToService"]).toEqual(["ecs-tasks.amazonaws.com", "codebuild.amazonaws.com", "lambda.amazonaws.com", "eks.amazonaws.com", "ec2.amazonaws.com", "vpc-flow-logs.amazonaws.com"]);
    expect(asList(pass.Resource)).toEqual([`arn:aws:iam::${ACCOUNT}:role/zenith-*`]);

    const self = statements.find((s) => s.Sid === "DenyBootstrapChanges")!;
    expect(self.Effect).toBe("Deny");
    const resources = asList(self.Resource).join(" ");
    for (const p of ["role/ZenithDeploy*", "role/ZenithObserve*", "role/zenith-codebuild*", "policy/Zenith*"]) {
      expect(resources).toContain(p);
    }
    expect(asList(self.Action)).toEqual(expect.arrayContaining(["iam:AttachRolePolicy", "iam:PutRolePolicy", "iam:UpdateAssumeRolePolicy", "iam:DeleteRole", "iam:CreatePolicyVersion", "iam:SetDefaultPolicyVersion"]));

    const boundaryGuard = statements.find((s) => s.Sid === "DenyRemovingAnyPermissionsBoundary")!;
    expect(asList(boundaryGuard.Action)).toEqual(["iam:DeleteRolePermissionsBoundary", "iam:PutRolePermissionsBoundary"]);
    expect(boundaryGuard.Resource).toBe("*");
    expect(boundaryGuard.Condition?.StringNotEquals?.["iam:PermissionsBoundary"]).toEqual(boundary);
    const role = `arn:aws:iam::${ACCOUNT}:role/zenith-env-web-role`;
    for (const action of ["iam:CreateRole", "iam:PutRolePolicy", "iam:PutRolePermissionsBoundary"]) {
      for (const arn of boundary) expect(boundaryAllows(statements, action, role, { "iam:PermissionsBoundary": arn, "aws:RequestTag/zenith:managed": "true" })).toBe(true);
      for (const arn of [undefined, ev.resourceRef("WorkloadBoundary"), `arn:aws:iam::${ACCOUNT}:policy/ZenithOtherBoundary`, boundary[0].replace(ACCOUNT, "210987654321")]) {
        expect(boundaryAllows(statements, action, role, { ...(arn ? { "iam:PermissionsBoundary": arn } : {}), "aws:RequestTag/zenith:managed": "true" }), `${action} ${arn}`).toBe(false);
      }
    }
    for (const arn of [undefined, ...boundary]) expect(boundaryAllows(statements, "iam:DeleteRolePermissionsBoundary", role, arn ? { "iam:PermissionsBoundary": arn } : {})).toBe(false);
    for (const arn of boundary) {
      for (const action of ["iam:CreatePolicy", "iam:CreatePolicyVersion", "iam:SetDefaultPolicyVersion", "iam:DeletePolicy", "iam:DeletePolicyVersion", "iam:TagPolicy", "iam:UntagPolicy"]) expect(boundaryAllows(statements, action, arn)).toBe(false);
    }

    const oidc = statements.find((s) => s.Sid === "DenyPrincipalCreation")!;
    expect(asList(oidc.Action)).toEqual(expect.arrayContaining(["iam:DeleteOpenIDConnectProvider", "iam:CreateUser", "iam:CreateAccessKey", "organizations:*"]));
  });

  it("permission boundary allows only events PassRole in IAM and denies administration and the state bucket", () => {
    const statements = statementsOf(policyDoc(ev, "WorkloadBoundary"));
    const denied = statements.filter((s) => s.Effect === "Deny");
    expect(denied.flatMap((s) => asList(s.Action))).toEqual(expect.arrayContaining(["iam:*", "organizations:*", "account:*", "s3:*"]));
    const stateDeny = denied.find((s) => s.Action === "s3:*")!;
    expect(asList(stateDeny.Resource).some((r) => r.includes("zenith-state-"))).toBe(true);
    const actions = allows(statements).flatMap((s) => asList(s.Action));
    expect(actions.filter((a) => a.startsWith("iam:") || a.startsWith("sts:") || a.startsWith("organizations:"))).toEqual(["iam:PassRole"]);
    const events = { "aws:PrincipalArn": `arn:aws:iam::${ACCOUNT}:role/zenith-env-nightly-events` };
    for (const action of ["iam:CreateRole", "iam:PutRolePolicy", "iam:AttachRolePolicy", "iam:DeleteRolePermissionsBoundary", "iam:UpdateAssumeRolePolicy", "organizations:ListAccounts", "account:GetContactInformation"]) {
      expect(boundaryAllows(statements, action, events["aws:PrincipalArn"], events), action).toBe(false);
    }
    // secret reads exist only for the workload's own secrets, by ARN prefix
    const secretStmt = allows(statements).find((s) => asList(s.Action).includes("secretsmanager:GetSecretValue"))!;
    expect(asList(secretStmt.Resource).filter((r) => ["ssm", "secretsmanager"].includes(r.split(":")[2]))).toEqual([
      `arn:aws:secretsmanager:*:${ACCOUNT}:secret:zenith/*`, `arn:aws:ssm:*:${ACCOUNT}:parameter/zenith/*`,
    ]);
  });

  it("conditions every new build grant on the shared role discriminator and narrow resources", () => {
    const statements = statementsOf(policyDoc(ev, "WorkloadBoundary"));
    const principalPattern = `arn:aws:iam::${ACCOUNT}:role/${BUILD_ROLE_NAME_PATTERN}`;
    const grants = statements.filter((s) => s.Effect === "Allow" && s.Condition?.ArnLike?.["aws:PrincipalArn"] === principalPattern);
    expect(grants).toHaveLength(3);
    for (const grant of grants) {
      expect(grant.Effect).toBe("Allow");
      expect(grant.Condition?.ArnLike).toEqual({ "aws:PrincipalArn": principalPattern });
      expect(iamGlob(principalPattern, `arn:aws:iam::${ACCOUNT}:role/zenith-env-web-build`)).toBe(true);
      for (const role of ["zenith-env-web", "zenith-env-web-exec", "zenith-env-web-fn", "zenith-env-web-ec2", "zenith-env-web-build-exec"]) {
        expect(iamGlob(principalPattern, `arn:aws:iam::${ACCOUNT}:role/${role}`), role).toBe(false);
      }
      expect(iamGlob(principalPattern, `arn:aws:iam::210987654321:role/zenith-env-web-build`)).toBe(false);
    }
    expect(grants[0].Resource).toBe(`arn:aws:ecr:*:${ACCOUNT}:repository/zenith-*`);
    expect(asList(grants[0].Action)).toEqual(["ecr:InitiateLayerUpload", "ecr:UploadLayerPart", "ecr:CompleteLayerUpload", "ecr:PutImage", "ecr:DescribeImages"]);
    expect(grants[1]).toMatchObject({ Action: "s3:GetObjectVersion", Resource: "arn:aws:s3:::zenith-*/*", Condition: { StringEquals: { "s3:ResourceAccount": ACCOUNT } } });
    expect(grants[2]).toMatchObject({ Action: "cloudfront:CreateInvalidation", Resource: `arn:aws:cloudfront::${ACCOUNT}:distribution/*`, Condition: { StringEquals: { "aws:ResourceTag/zenith:managed": "true" } } });
  });

  it("build grants fail closed for apps, foreign resources and missing conditions; state denial still wins", () => {
    const statements = statementsOf(policyDoc(ev, "WorkloadBoundary"));
    const build = { "aws:PrincipalArn": `arn:aws:iam::${ACCOUNT}:role/zenith-env-web-build`, "s3:ResourceAccount": ACCOUNT, "aws:ResourceTag/zenith:managed": "true" };
    const requests = [
      ...["ecr:InitiateLayerUpload", "ecr:UploadLayerPart", "ecr:CompleteLayerUpload", "ecr:PutImage", "ecr:DescribeImages"].map((action) => [action, `arn:aws:ecr:eu-west-1:${ACCOUNT}:repository/zenith-env-web`]),
      ["s3:GetObjectVersion", "arn:aws:s3:::zenith-env-web-src/zenith/env/web.zip"],
      ["cloudfront:CreateInvalidation", `arn:aws:cloudfront::${ACCOUNT}:distribution/EWEB`],
    ];
    for (const [action, resource] of requests) {
      expect(boundaryAllows(statements, action, resource, build), action).toBe(true);
      expect(boundaryAllows(statements, action, resource, { ...build, "aws:PrincipalArn": build["aws:PrincipalArn"].replace(/-build$/, "-exec") }), action).toBe(false);
      expect(boundaryAllows(statements, action, resource, {}), action).toBe(false);
      expect(boundaryAllows(statements, action, resource.replace(ACCOUNT, "210987654321").replace("zenith-env", "foreign-env"), build), action).toBe(false);
    }
    expect(boundaryAllows(statements, "s3:GetObjectVersion", requests[5][1], { ...build, "s3:ResourceAccount": "210987654321" })).toBe(false);
    expect(boundaryAllows(statements, "cloudfront:CreateInvalidation", requests[6][1], { ...build, "aws:ResourceTag/zenith:managed": "false" })).toBe(false);
    expect(boundaryAllows(statements, "cloudfront:CreateInvalidation", requests[6][1], { "aws:PrincipalArn": build["aws:PrincipalArn"] })).toBe(false);
    const state = `${ev.resourceRef("StateBucket")}/artifacts/source.zip`;
    expect(boundaryAllows(statements, "s3:GetObjectVersion", `arn:aws:s3:::${state}`, build)).toBe(false);
    expect(boundaryAllows(statements, "iam:PutRolePolicy", build["aws:PrincipalArn"], build)).toBe(false);
    for (const action of ["ecr:BatchGetImage", "ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer"]) {
      expect(boundaryAllows(statements, action, requests[0][1], { "aws:PrincipalArn": build["aws:PrincipalArn"].replace(/-build$/, "-exec") })).toBe(true);
    }
  });

  it("state bucket policy denies plain HTTP and TLS < 1.2; deploy role cannot administer or shorten its history", () => {
    const bucket = statementsOf(policyDoc(ev, "StateBucketPolicy"));
    expect(bucket.find((s) => s.Sid === "DenyInsecureTransport")).toMatchObject({ Effect: "Deny", Condition: { Bool: { "aws:SecureTransport": "false" } } });
    expect(bucket.find((s) => s.Sid === "DenyTlsBelow12")).toMatchObject({ Effect: "Deny", Condition: { NumericLessThan: { "s3:TlsVersion": "1.2" } } });
    const state = statementsOf(policyDoc(ev, "DeployStatePolicy"));
    const admin = state.find((s) => s.Sid === "DenyStateBucketAdministration")!;
    expect(asList(admin.Action)).toEqual(expect.arrayContaining(["s3:DeleteBucket", "s3:PutBucketPolicy", "s3:PutBucketVersioning", "s3:PutEncryptionConfiguration", "s3:PutBucketPublicAccessBlock"]));
    expect(state.find((s) => s.Sid === "DenyStateHistoryDeletion")).toMatchObject({ Effect: "Deny", Action: "s3:DeleteObjectVersion" });
    // the state bucket is not something the deploy role may reconfigure through the zenith-* bucket statement... which is why the explicit deny exists
    const data = statementsOf(policyDoc(ev, "DeployDataPolicy"));
    const buckets = data.find((s) => s.Sid === "S3ManageZenithBuckets")!;
    expect(buckets.Resource).toBe("arn:aws:s3:::zenith-*");
  });

  it("CodeBuild role: assumable only by CodeBuild in this account; pushes only to zenith-* repositories; reads only the artifact prefix", () => {
    const props = resolveResource(template, ev, "CodeBuildRole")!;
    const trust = statementsOf(props.AssumeRolePolicyDocument);
    expect(trust).toHaveLength(1);
    expect(trust[0]).toMatchObject({ Principal: { Service: "codebuild.amazonaws.com" }, Condition: { StringEquals: { "aws:SourceAccount": ACCOUNT } } });
    const statements = statementsOf((props.Policies as { PolicyDocument: unknown }[])[0].PolicyDocument);
    const push = statements.find((s) => s.Sid === "PushImagesToZenithRepositories")!;
    expect(push.Resource).toBe(`arn:aws:ecr:*:${ACCOUNT}:repository/zenith-*`);
    const reads = statements.find((s) => s.Sid === "ReadBuildArtifacts")!;
    expect(asList(reads.Resource).every((r) => r.endsWith("/artifacts/*"))).toBe(true);
    expect(asList(reads.Action).every((a) => a.startsWith("s3:Get"))).toBe(true);
    expect(allows(statements).flatMap((s) => asList(s.Action)).filter((a) => a.startsWith("iam:") || a.startsWith("secretsmanager:"))).toEqual([]);
  });
});

/** The ARN `Ref` yields for a resource under the scenario's parameters. */
function evaluatorForRef(ev: Evaluator, logicalId: string): string {
  return ev.resourceRef(logicalId);
}

describe("trust policies", () => {
  for (const role of ["ObserveRole", "DeployRole"]) {
    it(`${role}: OIDC statements pin issuer, audience and the exact subject; nothing else can assume it`, () => {
      const trust = statementsOf(resolveResource(template, evaluatorFor("oidc"), role)!.AssumeRolePolicyDocument);
      const pinned = { StringEquals: { [`${ISSUER_HOST}:aud`]: "sts.amazonaws.com", [`${ISSUER_HOST}:sub`]: SUBJECT } };
      const principal = { Federated: `arn:aws:iam::${ACCOUNT}:oidc-provider/${ISSUER_HOST}` };
      expect(trust).toEqual([
        {
          Sid: "ZenithOidc",
          Effect: "Allow",
          Principal: principal,
          Action: "sts:AssumeRoleWithWebIdentity",
          Condition: { ...pinned, StringLike: { "sts:RoleSessionName": "zenith-*" } },
        },
        // session tags travel in the token, so the trust policy must also allow TagSession (same pins)
        { Sid: "ZenithOidcTagSession", Effect: "Allow", Principal: principal, Action: "sts:TagSession", Condition: pinned },
      ]);
      expect(JSON.stringify(trust)).not.toMatch(/"StringLike":\{"[^"]*:sub"/);
    });

    it(`${role}: AssumeRole path requires the ExternalId and the principal; TagSession is a separate statement`, () => {
      const trust = statementsOf(resolveResource(template, evaluatorFor("everything"), role)!.AssumeRolePolicyDocument);
      expect(trust.map((s) => s.Sid)).toEqual(["ZenithOidc", "ZenithOidcTagSession", "ZenithAssumeRole", "ZenithTagSession"]);
      expect(trust[2]).toMatchObject({
        Principal: { AWS: PRINCIPAL },
        Action: "sts:AssumeRole",
        Condition: { StringEquals: { "sts:ExternalId": "zx-0123456789abcdef" } },
      });
      expect(trust[3]).toEqual({ Sid: "ZenithTagSession", Effect: "Allow", Principal: { AWS: PRINCIPAL }, Action: "sts:TagSession" });
      const only = statementsOf(resolveResource(template, evaluatorFor("assumeRoleOnly"), role)!.AssumeRolePolicyDocument);
      expect(only.map((s) => s.Sid)).toEqual(["ZenithAssumeRole", "ZenithTagSession"]);
    });
  }
});

describe("state bucket", () => {
  it("is versioned, private, encrypted (AES256 or the given KMS key), TLS-only and survives stack deletion", () => {
    expect(template.Resources.StateBucket.DeletionPolicy).toBe("Retain");
    expect(template.Resources.StateBucket.UpdateReplacePolicy).toBe("Retain");
    const plain = resolveResource(template, evaluatorFor("oidc"), "StateBucket")!;
    expect(plain.BucketName).toBe(`zenith-state-${ACCOUNT}-ap-south-1`);
    expect(plain.VersioningConfiguration).toEqual({ Status: "Enabled" });
    expect(plain.PublicAccessBlockConfiguration).toEqual({ BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true });
    expect(plain.OwnershipControls).toEqual({ Rules: [{ ObjectOwnership: "BucketOwnerEnforced" }] });
    expect(plain.BucketEncryption).toEqual({ ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } }] });
    const kms = resolveResource(template, evaluatorFor("everything"), "StateBucket")!;
    expect(kms.BucketName).toBe(`zenith-state-${ACCOUNT}-ap-south-1-team-a`);
    expect(kms.BucketEncryption).toEqual({
      ServerSideEncryptionConfiguration: [{ BucketKeyEnabled: true, ServerSideEncryptionByDefault: { SSEAlgorithm: "aws:kms", KMSMasterKeyID: KMS } }],
    });
    // the bootstrap tag is NOT the managed tag: the deploy role must not be able to see it as its own
    for (const r of ["StateBucket", "ObserveRole", "DeployRole", "CodeBuildRole"]) {
      const tags = resolveResource(template, evaluatorFor("oidc"), r)!.Tags as { Key: string }[];
      expect(tags.map((t) => t.Key)).toEqual(["zenith:bootstrap"]);
    }
  });
});

describe("optional features change only what they should", () => {
  it("route53 write access exists only for listed zones; KMS statements only with a key", () => {
    const data = (s: string) => statementsOf(policyDoc(evaluatorFor(s), "DeployEdgePolicy"));
    expect(data("oidc").some((s) => s.Sid === "Route53ChangeRecordsInListedZones")).toBe(false);
    const dns = data("everything").find((s) => s.Sid === "Route53ChangeRecordsInListedZones")!;
    expect(dns.Resource).toEqual(ZONES.split(","));
    expect(dns.Action).toBe("route53:ChangeResourceRecordSets");
    for (const [id, sid] of [["ObservePolicy", "ReadStateKmsKey"], ["DeployStatePolicy", "StateKmsKey"]] as const) {
      expect(statementsOf(policyDoc(evaluatorFor("oidc"), id)).some((s) => s.Sid === sid)).toBe(false);
      const on = statementsOf(policyDoc(evaluatorFor("everything"), id)).find((s) => s.Sid === sid)!;
      expect(on.Resource).toBe(KMS);
    }
  });

  it("the environment scope reaches every tag condition on the deploy role", () => {
    const network = JSON.stringify(policyDoc(evaluatorFor("everything"), "DeployNetworkPolicy"));
    expect(network).toContain('"aws:RequestTag/zenith:environment":"env_prod1"');
    expect(network).toContain('"aws:ResourceTag/zenith:environment":"env_prod1"');
    expect(JSON.stringify(policyDoc(evaluatorFor("oidc"), "DeployNetworkPolicy"))).toContain('"aws:ResourceTag/zenith:environment":"*"');
  });
});

describe("the broker's session policies stay inside the roles they narrow", () => {
  const ev = evaluatorFor("oidc");
  const grants = (ids: string[]) =>
    ids.flatMap((id) => allows(statementsOf(policyDoc(ev, id)))).map((s) => ({ actions: asList(s.Action), resources: asList(s.Resource) }));
  const observe = grants(["ObservePolicy"]);
  const deploy = grants(["ObservePolicy", ...DEPLOY_POLICIES]);
  const ctx = { accountId: ACCOUNT, region: "ap-south-1", environmentId: "env_1" };

  const isGranted = (granted: ReturnType<typeof grants>, action: string, resource: string) =>
    granted.some((g) => g.actions.some((ga) => iamGlob(ga.toLowerCase(), action.toLowerCase())) && g.resources.some((gr) => iamGlob(gr, resource)));

  it.each([
    ["infrastructure.observe", observe],
    ["topology.read", observe],
    ["firewall.inspect", observe],
    ["metrics.read", observe],
    ["logs.read", observe],
    ["service.restart", deploy],
    ["service.scale", deploy],
    ["database.snapshot", deploy],
  ] as const)("%s only asks for permissions its role grants (by action and resource pattern)", (cap, granted) => {
    const policy = sessionPolicyFor(cap, ctx)!;
    for (const stmt of policy.Statement as Statement[]) {
      const missing = asList(stmt.Action).flatMap((a) =>
        asList(stmt.Resource)
          .filter((r) => !isGranted(granted, a, r))
          .map((r) => `${a} on ${r}`)
      );
      expect(missing, `${cap} asks for permissions its role does not grant`).toEqual([]);
    }
  });
});

describe("OpenTofu module", () => {
  const strip = (s: string) => s.replace(/\r\n/g, "\n");

  it("the --check implementation detects edited and missing generated files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-policy-check-"));
    try {
      for (const [name, content] of Object.entries(generate())) fs.writeFileSync(path.join(dir, name), content);
      expect(checkPolicies(dir)).toEqual([]);
      fs.appendFileSync(path.join(dir, "workload-boundary.json.tftpl"), "\n");
      expect(checkPolicies(dir)).toEqual(["workload-boundary.json.tftpl"]);
      fs.unlinkSync(path.join(dir, "workload-boundary.json.tftpl"));
      expect(checkPolicies(dir)).toEqual(["workload-boundary.json.tftpl"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("policy templates are exactly what the generator derives from the CloudFormation template", () => {
    const generated = generate();
    const onDisk = fs.readdirSync(POLICIES_DIR).sort();
    expect(onDisk).toEqual(Object.keys(generated).sort());
    for (const [name, text] of Object.entries(generated)) {
      expect(strip(fs.readFileSync(path.join(POLICIES_DIR, name), "utf8")), `${name} is stale; run npx tsx deploy/aws/tools/generate-tofu-policies.ts --write`).toBe(text);
    }
  });

  it("rendered templates equal the evaluated CloudFormation policies (default scenario)", () => {
    const ev = evaluatorFor("oidc");
    const vars: Record<string, string> = {
      partition: "aws",
      account_id: ACCOUNT,
      region: "ap-south-1",
      state_bucket: `zenith-state-${ACCOUNT}-ap-south-1`,
      state_bucket_arn: `arn:aws:s3:::zenith-state-${ACCOUNT}-ap-south-1`,
      boundary_arn: ev.resourceRef("WorkloadBoundary"),
      environment_tag_value: "*",
      dns_suffix: "amazonaws.com",
      ...Object.fromEntries(Object.entries(AWS_ROLE_BOUNDARIES).map(([family, spec]) => [`${family}_boundary_arn`, ev.resourceRef(spec.logicalId)])),
    };
    const render = (file: string) => JSON.parse(strip(fs.readFileSync(path.join(POLICIES_DIR, file), "utf8")).replace(/\$\{(\w+)\}/g, (_m, k: string) => vars[k]));
    const files: Record<string, string> = {
      ObservePolicy: "observe.json.tftpl",
      DeployNetworkPolicy: "deploy-network.json.tftpl",
      DeployComputePolicy: "deploy-compute.json.tftpl",
      DeployDataPolicy: "deploy-data.json.tftpl",
      DeployStatePolicy: "deploy-state.json.tftpl",
      DeployIamPolicy: "deploy-iam.json.tftpl",
      WorkloadBoundary: "workload-boundary.json.tftpl",
      ...Object.fromEntries(Object.values(AWS_ROLE_BOUNDARIES).map((spec) => [spec.logicalId, `${spec.template}.json.tftpl`])),
    };
    for (const [id, file] of Object.entries(files)) {
      expect(render(file), id).toEqual(JSON.parse(JSON.stringify(policyDoc(ev, id))));
    }
    const cb = (resolveResource(template, ev, "CodeBuildRole")!.Policies as { PolicyDocument: unknown }[])[0].PolicyDocument;
    expect(render("codebuild.json.tftpl")).toEqual(JSON.parse(JSON.stringify(cb)));
  });

  it("main.tf pins the same trust conditions and bucket protections as the template", () => {
    const main = fs.readFileSync(path.join(MODULE_DIR, "main.tf"), "utf8");
    for (const needle of [
      '"${var.zenith_issuer_host}:aud" = "sts.amazonaws.com"',
      '"${var.zenith_issuer_host}:sub" = var.zenith_oidc_subject',
      '"sts:RoleSessionName" = "zenith-*"',
      '"sts:ExternalId" = var.external_id',
      'client_id_list = ["sts.amazonaws.com"]',
      'status = "Enabled"',
      "block_public_acls       = true",
      "restrict_public_buckets = true",
      '"aws:SecureTransport" = "false"',
      '"s3:TlsVersion" = "1.2"',
      "force_destroy = false",
      "max_session_duration = 3600",
    ]) {
      expect(main, needle).toContain(needle);
    }
    expect(main).not.toMatch(/"zenith:managed"s*=/);
  });

  const tofuAvailable = spawnSync("tofu", ["version"], { encoding: "utf8" }).status === 0;
  // Needs the AWS provider from registry.opentofu.org (~60 s the first time).
  it.skipIf(!process.env.ZENITH_TEST_TOFU || !tofuAvailable)("tofu init + validate + test (mock provider, offline after init)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-tofu-"));
    fs.cpSync(MODULE_DIR, dir, { recursive: true });
    // Provider installation can exceed Vitest's RPC timeout. Awaiting the
    // child keeps this worker responsive while preserving the real gates.
    const run = async (...args: string[]) => (await execFileAsync("tofu", args, { cwd: dir, encoding: "utf8", timeout: 240_000 })).stdout;
    await run("init", "-backend=false", "-input=false");
    expect(await run("validate")).toContain("valid");
    expect(await run("test")).toMatch(/Success!/);
  }, 300_000);
});
