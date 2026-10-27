import {
  GetRoleCommand,
  GetRolePolicyCommand,
  IAMClient,
  ListAttachedRolePoliciesCommand,
  ListRolePoliciesCommand,
  ListRolesCommand,
  ListRoleTagsCommand,
} from "@aws-sdk/client-iam";
import { GetResourcesCommand, ResourceGroupsTaggingAPIClient } from "@aws-sdk/client-resource-groups-tagging-api";
import { mockClient } from "aws-sdk-client-mock";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GRANT_RULES, iamRoleDriver as driver } from "@/lib/providers/aws/drivers/data";
import { DriverCompileError } from "@/lib/providers/aws/drivers/shared";
import { assertNoWildcards, compileGrantStatements, expectedGrantActions, type PolicyStatement } from "@/lib/providers/aws/drivers/data/iam-grants";
import { normalizePolicyDocument, roleNameFor, roleNameOf, summarizePolicies, trustPrincipalsOf } from "@/lib/providers/aws/drivers/data/iam-role";
import { environmentName } from "@/lib/credentials/aws/naming";
import type { IdentityGrant } from "@/lib/resources/specs";
import type { ResourceNode } from "@/lib/resources/types";
import { driftOf } from "./_drift";
import { awsError, compileCtx, driverCtx as unboundDriverCtx, mkNode, standardNodes, tagList } from "./_helpers";
const awsBootstrap = { accountId: "123456789012", partition: "aws" as const, bootstrapNameSuffix: "" };
const driverCtx = () => ({ ...unboundDriverCtx(), awsBootstrap });
const expectedAttributes = (node: Parameters<NonNullable<typeof driver.expectedAttributes>>[0]) => driver.expectedAttributes!(node, { awsBootstrap });

const iam = mockClient(IAMClient);
const tagging = mockClient(ResourceGroupsTaggingAPIClient);
beforeEach(() => {
  iam.reset();
  tagging.reset();
});
afterAll(() => {
  iam.restore();
  tagging.restore();
});

const nodes = standardNodes();
const ctx = compileCtx(nodes);
const identity = (grants: IdentityGrant[], over: Record<string, unknown> = {}, workload = "container_service/web") =>
  mkNode("identity/web", "identity", { principal: "workload", workload, grants, ...over });
const ACCT = { partition: "${data.aws_partition.p.partition}", accountId: "${data.aws_caller_identity.a.account_id}" };
const statements = (grants: IdentityGrant[], extra: ResourceNode[] = []) => {
  const id = identity(grants);
  return compileGrantStatements(id, compileCtx([...nodes, ...extra]), grants, ACCT);
};
const grant = (target: string, ...access: string[]): IdentityGrant => ({ target, access, via: ["test"] });
const compile = (id: ResourceNode, all = nodes) => driver.compile!(id, compileCtx([...all, id].filter((n, i, a) => a.findIndex((m) => m.address === n.address) === i)));

describe("grant → IAM mapping table", () => {
  it("has explicit actions for every (kind, verb), none of them a wildcard", () => {
    for (const [kind, verbs] of Object.entries(GRANT_RULES)) {
      for (const [verb, rules] of Object.entries(verbs)) {
        expect(rules.length, `${kind}.${verb}`).toBeGreaterThan(0);
        for (const rule of rules) {
          expect(rule.actions.length).toBeGreaterThan(0);
          for (const action of rule.actions) expect(action, `${kind}.${verb}`).toMatch(/^[a-z0-9-]+:[A-Za-z]+$/);
        }
      }
    }
  });

  it.each([
    ["object_store/uploads", ["read"], [{ actions: ["s3:GetObject"], resources: ["${local.ref_object_store_uploads__arn}/*"] }]],
    ["object_store/uploads", ["list"], [{ actions: ["s3:ListBucket"], resources: ["${local.ref_object_store_uploads__arn}"] }]],
    ["object_store/uploads", ["write"], [{ actions: ["s3:AbortMultipartUpload", "s3:ListMultipartUploadParts", "s3:PutObject"], resources: ["${local.ref_object_store_uploads__arn}/*"] }]],
    ["object_store/uploads", ["delete"], [{ actions: ["s3:DeleteObject"], resources: ["${local.ref_object_store_uploads__arn}/*"] }]],
    ["queue/jobs", ["publish"], [{ actions: ["sqs:GetQueueAttributes", "sqs:GetQueueUrl", "sqs:SendMessage"], resources: ["${local.ref_queue_jobs__arn}"] }]],
    ["queue/jobs", ["consume"], [{ actions: ["sqs:ChangeMessageVisibility", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:GetQueueUrl", "sqs:ReceiveMessage"], resources: ["${local.ref_queue_jobs__arn}"] }]],
    ["secret/api-key-deadbeef", ["read"], [{ actions: ["secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue"], resources: ["${local.ref_secret_api_key_deadbeef__arn}"] }]],
    ["log_group/web", ["write"], [{ actions: ["logs:CreateLogStream", "logs:PutLogEvents"], resources: ['${trimsuffix(local.ref_log_group_web__arn, ":*")}:*'] }]],
    [
      "log_group/web",
      ["logs"],
      [{ actions: ["logs:DescribeLogStreams", "logs:FilterLogEvents", "logs:GetLogEvents"], resources: ['${trimsuffix(local.ref_log_group_web__arn, ":*")}', '${trimsuffix(local.ref_log_group_web__arn, ":*")}:*'] }],
    ],
    ["container_registry/web", ["pull"], [{ actions: ["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"], resources: ["${local.ref_container_registry_web__arn}"] }]],
    ["postgres/db", ["read_credentials"], [{ actions: ["secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue"], resources: ["${local.ref_postgres_db__master_user_secret_arn}"] }]],
    [
      "postgres/db",
      ["connect"],
      [{ actions: ["rds-db:connect"], resources: ["arn:${data.aws_partition.p.partition}:rds-db:ap-south-1:${data.aws_caller_identity.a.account_id}:dbuser:${local.ref_postgres_db__resource_id}/zenith_app"] }],
    ],
    ["redis/cache", ["connect"], [{ actions: ["elasticache:Connect"], resources: ["${local.ref_redis_cache__arn}", "${local.ref_redis_cache__iam_user_arn}"] }]],
  ] as const)("%s %j compiles to exactly the mapped actions and ARNs", (target, verbs, expected) => {
    const out = statements([grant(target, ...verbs)]);
    expect(out.map(({ actions, resources }) => ({ actions, resources }))).toEqual(expected);
  });

  it("merges verbs that share a resource shape into one statement and splits the rest", () => {
    const out = statements([grant("object_store/uploads", "delete", "list", "read", "write")]);
    expect(out).toHaveLength(2);
    expect(out.find((s) => s.resources[0].endsWith("/*"))!.actions).toEqual(["s3:AbortMultipartUpload", "s3:DeleteObject", "s3:GetObject", "s3:ListMultipartUploadParts", "s3:PutObject"]);
    expect(out.find((s) => !s.resources[0].endsWith("/*"))!.actions).toEqual(["s3:ListBucket"]);
  });

  it("is deterministic regardless of grant and verb order, with unique alphanumeric Sids", () => {
    const a = statements([grant("queue/jobs", "publish", "consume"), grant("object_store/uploads", "write", "read")]);
    const b = statements([grant("object_store/uploads", "read", "write"), grant("queue/jobs", "consume", "publish")]);
    expect(a).toEqual(b);
    expect(new Set(a.map((s) => s.sid)).size).toBe(a.length);
    for (const s of a) expect(s.sid).toMatch(/^[A-Za-z0-9]+$/);
  });

  it("expectedGrantActions agrees with compile for the standard identity", () => {
    const id = nodes.find((n) => n.address === "identity/web")!;
    const grants = (id.spec as { grants: IdentityGrant[] }).grants;
    const fromCompile = [...new Set(compileGrantStatements(id, ctx, grants, ACCT).flatMap((s) => s.actions))].sort();
    expect(expectedGrantActions(id.address, grants)).toEqual(fromCompile);
  });
});

describe("wildcards are refused at compile time", () => {
  const bad = (grants: IdentityGrant[]) => () => statements(grants);

  it.each([
    ["a wildcard target", grant("object_store/*", "read")],
    ["a wildcard target with ?", grant("object_store/up?oads", "read")],
    ["an empty target", grant("", "read")],
    ["a wildcard verb", grant("object_store/uploads", "*")],
    ["an unknown verb", grant("object_store/uploads", "admin")],
    ["a verb from another kind", grant("queue/jobs", "read")],
    ["a verb the kind has no mapping for (sql read)", grant("postgres/db", "read")],
    ["no verbs at all", grant("queue/jobs")],
    ["a target that is not in the graph", grant("queue/ghost", "publish")],
    ["a kind with no IAM mapping", grant("container_service/web", "read")],
  ])("refuses %s", (_name, g) => {
    expect(bad([g])).toThrow(DriverCompileError);
  });

  it("assertNoWildcards refuses wildcard actions and Resource '*' whatever produced them", () => {
    const ok: PolicyStatement = { sid: "Ok", actions: ["s3:GetObject"], resources: ["arn:aws:s3:::b/*"] };
    expect(() => assertNoWildcards("identity/web", [ok])).not.toThrow();
    for (const s of [
      { ...ok, actions: ["*"] },
      { ...ok, actions: ["s3:*"] },
      { ...ok, actions: ["s3:Get*"] },
      { ...ok, actions: ["s3:Get?bject"] },
      { ...ok, resources: ["*"] },
      { ...ok, resources: ["arn:aws:s3:::*"] },
      { ...ok, actions: [] },
      { ...ok, resources: [] },
    ]) {
      expect(() => assertNoWildcards("identity/web", [s])).toThrow(/wildcard|no actions|no resources/);
    }
  });

  it("emits wildcards only as the intrinsic suffix of one resource's own sub-resources", () => {
    const all = statements([grant("object_store/uploads", "read", "list"), grant("log_group/web", "write", "logs")]);
    for (const s of all) {
      for (const a of s.actions) expect(a).not.toMatch(/[*?]/);
      for (const r of s.resources) {
        expect(r).not.toBe("*");
        // the `*` that does appear is always directly after one resource's own ARN: `…}/*` or `…}:*`
        const stripped = r.replace(/\$\{[^}]*\}/g, "X");
        expect(stripped.replace(/^X[/:]\*$/, "X")).not.toMatch(/\*/);
      }
    }
  });
});

describe("referenced targets", () => {
  const referencedBucket = mkNode("object_store/legacy", "object_store", bucketSpecLike(), { ownership: "referenced", externalRef: "arn:aws:s3:::legacy-bucket" });
  function bucketSpecLike() {
    return { size: "small", deletionPolicy: "approval", encryption: true, versioning: false, publicAccess: false };
  }

  it("uses the validated ARN literal from externalRef", () => {
    const out = statements([grant("object_store/legacy", "read", "list")], [referencedBucket]);
    expect(out.flatMap((s) => s.resources).sort()).toEqual(["arn:aws:s3:::legacy-bucket", "arn:aws:s3:::legacy-bucket/*"]);
  });

  it.each([
    ["not an ARN", "legacy-bucket"],
    ["a wildcard ARN", "arn:aws:s3:::legacy-*"],
    ["another service's ARN", "arn:aws:sqs:ap-south-1:123456789012:q"],
    ["an ARN carrying an HCL interpolation", "arn:aws:s3:::legacy${aws_s3_bucket.other.arn}"],
    ["an ARN carrying an HCL directive", "arn:aws:s3:::legacy%{ if true }x%{ endif }"],
    ["an ARN with a quote, space or backslash", "arn:aws:s3:::le\"gacy bucket\\"],
    ["an ARN with a single-character wildcard", "arn:aws:s3:::legacy-?"],
  ])("refuses a referenced bucket whose externalRef is %s", (_n, externalRef) => {
    const n = mkNode("object_store/legacy", "object_store", bucketSpecLike(), { ownership: "referenced", externalRef });
    expect(() => statements([grant("object_store/legacy", "read")], [n])).toThrow(DriverCompileError);
  });

  it("refuses database and cache grants to referenced nodes (their ids are unknown), never guesses", () => {
    const db = mkNode("postgres/legacy", "postgres", { engine: "postgres" }, { ownership: "referenced", externalRef: "arn:aws:rds:ap-south-1:123456789012:db:legacy" });
    expect(() => statements([grant("postgres/legacy", "connect")], [db])).toThrow(/unknown/);
    expect(() => statements([grant("postgres/legacy", "read_credentials")], [db])).toThrow(/unknown|secret ARN/);
  });
});

describe("aws:iam_role compile", () => {
  const id = nodes.find((n) => n.address === "identity/web")!;

  it("defines the role first, with the boundary, a scoped trust and ONE inline policy from the grants", () => {
    const f = compile(id);
    expect(f.addresses).toEqual([
      "aws_iam_role.identity_web",
      "aws_iam_role_policy.identity_web_grants",
      "data.aws_caller_identity.identity_web_account",
      "data.aws_partition.identity_web_partition",
      "data.aws_iam_policy_document.identity_web_trust",
      "data.aws_iam_policy_document.identity_web_grants",
    ]);
    const role = (f.resource!.aws_iam_role as Record<string, Record<string, unknown>>).identity_web;
    expect(role).toMatchObject({
      name: "zen-prod-web-role",
      permissions_boundary: "arn:${data.aws_partition.identity_web_partition.partition}:iam::${data.aws_caller_identity.identity_web_account.account_id}:policy/ZenithAppBoundary",
      assume_role_policy: "${data.aws_iam_policy_document.identity_web_trust.json}",
    });
    expect(f.resource!.aws_iam_role_policy).toEqual({ identity_web_grants: { name: "zenith-grants", role: "${aws_iam_role.identity_web.id}", policy: "${data.aws_iam_policy_document.identity_web_grants.json}" } });
  });

  it("compiles every grant of the standard identity and no wildcard action or Resource '*' anywhere", () => {
    const f = compile(id);
    const doc = (f.data!.aws_iam_policy_document as Record<string, { statement: { actions: string[]; resources: string[]; effect: string }[] }>).identity_web_grants;
    expect(doc.statement.length).toBeGreaterThanOrEqual(10);
    for (const s of doc.statement) {
      expect(s.effect).toBe("Allow");
      expect(s.actions.every((a) => !/[*?]/.test(a))).toBe(true);
      expect(s.resources.every((r) => r !== "*")).toBe(true);
    }
    const all = new Set(doc.statement.flatMap((s) => s.actions));
    expect(all).toContain("rds-db:connect");
    expect(all).toContain("elasticache:Connect");
    expect(all).toContain("secretsmanager:GetSecretValue");
    expect(JSON.stringify(f)).not.toMatch(/"Resource":\s*"\*"|"actions":\s*\[[^\]]*"\*"/);
  });

  it.each([
    ["container_service/web", "ecs-tasks.amazonaws.com", true],
    ["scheduled_job/nightly", "ecs-tasks.amazonaws.com", true],
    ["function/fn", "lambda.amazonaws.com", true],
    ["build_pipeline/web", "codebuild.amazonaws.com", true],
    ["compute_instance/vm", "ec2.amazonaws.com", false],
  ])("workload %s is trusted as %s (source-account condition: %s)", (workload, principal, scoped) => {
    const f = compile(identity([], {}, workload));
    const trust = (f.data!.aws_iam_policy_document as Record<string, { statement: { principals: { identifiers: string[] }[]; condition?: unknown[] }[] }>).identity_web_trust;
    expect(trust.statement[0].principals).toEqual([{ type: "Service", identifiers: [principal] }]);
    expect(trust.statement[0].condition !== undefined).toBe(scoped);
    // a role with no grants has no inline policy at all
    expect(f.resource!.aws_iam_role_policy).toBeUndefined();
  });

  it("refuses an unknown workload kind and malformed specs", () => {
    expect(() => compile(identity([], {}, "static_site/docs"))).toThrow(/no trust principal/);
    expect(() => compile(mkNode("identity/web", "identity", { principal: "workload", grants: [] }))).toThrow(DriverCompileError);
    expect(() => compile(mkNode("identity/web", "identity", { principal: "workload", workload: "container_service/web", grants: "all" }))).toThrow(DriverCompileError);
    expect(() => compile(mkNode("identity/web", "identity", { principal: "workload", workload: "container_service/web", grants: [{ target: "queue/jobs", access: [1] }] }))).toThrow(DriverCompileError);
  });

  it("refuses a policy that would exceed IAM's inline limit", () => {
    const many: ResourceNode[] = [];
    const grants: IdentityGrant[] = [];
    for (let i = 0; i < 60; i++) {
      many.push(mkNode(`object_store/bucket-${i}`, "object_store", { size: "small", deletionPolicy: "approval", encryption: true, versioning: false, publicAccess: false }));
      grants.push(grant(`object_store/bucket-${i}`, "read", "write", "delete", "list"));
    }
    expect(() => compile(identity(grants), [...nodes, ...many])).toThrow(/10000-character/);
  });

  it("publishes arn, id and name; is deterministic; non-managed identities compile to nothing", () => {
    expect(Object.keys(compile(id).locals!).sort()).toEqual(["ref_identity_web__arn", "ref_identity_web__id", "ref_identity_web__name"]);
    expect(JSON.stringify(compile(id))).toBe(JSON.stringify(compile(id)));
    expect(compile(mkNode("identity/web", "identity", id.spec, { ownership: "referenced" }))).toEqual({ addresses: [] });
  });
});

/* --------------------------------- reading --------------------------------- */

const ROLE_ARN = "arn:aws:iam::123456789012:role/zen-prod-web-role";
const id = nodes.find((n) => n.address === "identity/web")!;
const enc = (doc: unknown) => encodeURIComponent(JSON.stringify(doc));
const trustDoc = { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "ecs-tasks.amazonaws.com" }, Action: "sts:AssumeRole" }] };
const expectedActions = expectedGrantActions(id.address, (id.spec as { grants: IdentityGrant[] }).grants);
const policyDoc = (actions: string[], resource: string | string[] = ["arn:aws:s3:::b/*"]) => ({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: actions, Resource: resource }] });

function healthyRole(actions = expectedActions, boundary: string | undefined = "arn:aws:iam::123456789012:policy/ZenithAppBoundary") {
  iam.on(GetRoleCommand).resolves({
    Role: {
      RoleName: "zen-prod-web-role",
      Path: "/",
      RoleId: "AROAX",
      CreateDate: new Date(),
      Arn: ROLE_ARN,
      AssumeRolePolicyDocument: enc(trustDoc),
      PermissionsBoundary: boundary ? { PermissionsBoundaryType: "PermissionsBoundaryPolicy", PermissionsBoundaryArn: boundary } : undefined,
      Tags: tagList("identity/web"),
    },
  });
  iam.on(ListRolePoliciesCommand).resolves({ PolicyNames: ["zenith-grants"] });
  iam.on(GetRolePolicyCommand).resolves({ RoleName: "zen-prod-web-role", PolicyName: "zenith-grants", PolicyDocument: enc(policyDoc(actions)) });
  iam.on(ListAttachedRolePoliciesCommand).resolves({ AttachedPolicies: [] });
}

describe("aws:iam_role observe", () => {
  it.each([
    "arn:aws:iam::123456789012:policy/ZenithAppBoundary-team-a",
    "arn:aws:iam::210987654321:policy/ZenithAppBoundary-team-a",
    "arn:aws-cn:iam::123456789012:policy/ZenithAppBoundary-team-a",
    "arn:aws:iam::123456789012:policy/foreign/ZenithAppBoundary-team-a",
    "arn:aws:iam::123456789012:policy/ZenithAppBoundary",
    "none",
  ])("observes and verifies the entire boundary ARN %s", async (boundary) => {
    healthyRole(expectedActions, boundary === "none" ? undefined : boundary);
    // Override the default fixture explicitly for the boundary-absent response.
    if (boundary === "none") iam.on(GetRoleCommand).resolves({ Role: { RoleName: "zen-prod-web-role", Path: "/", RoleId: "x", CreateDate: new Date(), Arn: ROLE_ARN, AssumeRolePolicyDocument: enc(trustDoc) } });
    const c = { ...driverCtx(), awsBootstrap: { ...awsBootstrap, bootstrapNameSuffix: "-team-a" } };
    const observation = await driver.observe!(c, id, ROLE_ARN);
    expect(observation.attributes.permissionsBoundaryArn).toMatchObject({ state: "known", value: boundary });
    const good = boundary === "arn:aws:iam::123456789012:policy/ZenithAppBoundary-team-a";
    expect((await driver.verify!(c, id, observation)).status).toBe(good ? "passed" : "failed");
    const findings = driftOf(id, observation, (node) => driver.expectedAttributes!(node, c));
    expect(findings.some((finding) => finding.fields?.some((field) => field.attribute === "permissionsBoundaryArn"))).toBe(!good);
  });

  it("keeps missing trusted context or unreadable boundary verification unknown", async () => {
    healthyRole();
    const observation = await driver.observe!(driverCtx(), id, ROLE_ARN);
    expect((await driver.verify!(unboundDriverCtx(), id, observation)).status).toBe("unknown");
    observation.attributes.permissionsBoundaryArn = { state: "unknown", reason: "access_denied" };
    expect((await driver.verify!(driverCtx(), id, observation)).status).toBe("unknown");
  });
  it("reads boundary, trust, normalized inline actions and attachments; matches the spec", async () => {
    healthyRole();
    const obs = await driver.observe!(driverCtx(), id, ROLE_ARN);
    expect(obs).toMatchObject({ presence: "present", externalId: ROLE_ARN, source: "aws.iam_role@1" });
    const v = (n: string) => (obs.attributes[n] as { value: unknown }).value;
    expect(v("permissionsBoundaryArn")).toBe("arn:aws:iam::123456789012:policy/ZenithAppBoundary");
    expect(v("trustPrincipals")).toEqual(["ecs-tasks.amazonaws.com"]);
    expect(v("wildcardAccess")).toBe(false);
    expect(v("attachedPolicyCount")).toBe(0);
    expect(v("inlinePolicyActions")).toEqual(expectedActions);
    expect((obs.native as { tags: Record<string, string> }).tags["zenith:resource"]).toBe("identity/web");
    expect(driftOf(id, obs, expectedAttributes)).toEqual([]);
    expect(iam.commandCalls(GetRoleCommand)[0].args[0].input).toEqual({ RoleName: "zen-prod-web-role" });
  });

  it("flags widened access as HIGH drift: a wildcard action, an attached managed policy, a missing boundary", async () => {
    healthyRole([...expectedActions, "s3:*"]);
    iam.on(GetRoleCommand).resolves({ Role: { RoleName: "zen-prod-web-role", Path: "/", RoleId: "x", CreateDate: new Date(), Arn: ROLE_ARN, AssumeRolePolicyDocument: enc(trustDoc), Tags: [] } });
    iam.on(ListAttachedRolePoliciesCommand).resolves({ AttachedPolicies: [{ PolicyName: "AdministratorAccess", PolicyArn: "arn:aws:iam::aws:policy/AdministratorAccess" }] });
    const obs = await driver.observe!(driverCtx(), id, ROLE_ARN);
    const f = driftOf(id, obs, expectedAttributes);
    expect(f[0]).toMatchObject({ class: "changed", severity: "high" });
    expect(f[0].fields!.map((x) => x.attribute).sort()).toEqual(["attachedPolicyCount", "inlinePolicyActions", "permissionsBoundaryArn", "wildcardAccess"]);
  });

  it("detects a Resource '*' and NotAction as wildcard access", () => {
    expect(summarizePolicies([normalizePolicyDocument(JSON.stringify(policyDoc(["s3:GetObject"], "*")))!]).wildcard).toBe(true);
    expect(summarizePolicies([normalizePolicyDocument(JSON.stringify({ Statement: [{ Effect: "Allow", NotAction: "iam:*", Resource: "arn:aws:s3:::b" }] }))!]).wildcard).toBe(true);
    expect(summarizePolicies([normalizePolicyDocument(JSON.stringify(policyDoc(["s3:GetObject"])))!])).toEqual({ actions: ["s3:GetObject"], wildcard: false });
    // a Deny statement widens nothing
    expect(summarizePolicies([normalizePolicyDocument(JSON.stringify({ Statement: [{ Effect: "Deny", Action: "*", Resource: "*" }] }))!])).toEqual({ actions: [], wildcard: false });
  });

  it("decodes percent-encoded documents and tolerates plain JSON, single statements and garbage", () => {
    expect(normalizePolicyDocument(enc(policyDoc(["s3:PutObject", "s3:GetObject"])))![0].actions).toEqual(["s3:GetObject", "s3:PutObject"]);
    expect(normalizePolicyDocument(JSON.stringify({ Statement: { Effect: "Allow", Action: "s3:GetObject", Resource: "x" } }))).toHaveLength(1);
    expect(normalizePolicyDocument("{not json")).toBeUndefined();
    expect(trustPrincipalsOf(enc(trustDoc))).toEqual(["ecs-tasks.amazonaws.com"]);
    expect(trustPrincipalsOf(JSON.stringify({ Statement: [{ Effect: "Allow", Principal: "*", Action: "sts:AssumeRole" }] }))).toEqual(["*"]);
    expect(trustPrincipalsOf("garbage")).toBeUndefined();
  });

  it("keeps independent failures independent: denied policy reads make only those attributes unknown", async () => {
    healthyRole();
    iam.on(ListRolePoliciesCommand).rejects(awsError("AccessDenied", "no", 403));
    const obs = await driver.observe!(driverCtx(), id, ROLE_ARN);
    expect(obs.presence).toBe("present");
    expect(obs.attributes.inlinePolicyActions).toMatchObject({ state: "unknown", reason: "access_denied" });
    expect(obs.attributes.wildcardAccess).toMatchObject({ state: "unknown", reason: "access_denied" });
    expect(obs.attributes.permissionsBoundaryArn).toMatchObject({ state: "known", value: "arn:aws:iam::123456789012:policy/ZenithAppBoundary" });
    expect(obs.attributes.attachedPolicyCount).toMatchObject({ state: "known", value: 0 });
  });

  it("does not claim the inline policy is wildcard-free when an inline policy could not be parsed", async () => {
    healthyRole();
    iam.on(GetRolePolicyCommand).resolves({ RoleName: "r", PolicyName: "p", PolicyDocument: "%%%garbage" });
    const obs = await driver.observe!(driverCtx(), id, ROLE_ARN);
    expect(obs.attributes.wildcardAccess).toMatchObject({ state: "unknown" });
  });

  it("keeps native within 4 KiB for a large policy, dropping the policy text before the tags", async () => {
    healthyRole();
    const big = {
      Version: "2012-10-17",
      Statement: Array.from({ length: 80 }, (_, i) => ({ Effect: "Allow", Action: [`s3:GetObject`, `s3:PutObject`], Resource: `arn:aws:s3:::bucket-number-${i}-with-a-long-name/*` })),
    };
    iam.on(GetRolePolicyCommand).resolves({ RoleName: "r", PolicyName: "p", PolicyDocument: enc(big) });
    const obs = await driver.observe!(driverCtx(), id, ROLE_ARN);
    expect(Buffer.byteLength(JSON.stringify(obs.native))).toBeLessThanOrEqual(4096);
    expect((obs.native as { tags: Record<string, string> }).tags["zenith:resource"]).toBe("identity/web");
    expect(obs.native).toMatchObject({ roleName: "zen-prod-web-role" });
    // the action summary in `attributes` is unaffected by trimming the native bag
    expect((obs.attributes.inlinePolicyActions as { value: string[] }).value).toEqual(["s3:GetObject", "s3:PutObject"]);
  });

  it("classifies NoSuchEntity as missing, AccessDenied as inaccessible, throttling as unknown", async () => {
    iam.on(GetRoleCommand).rejects(awsError("NoSuchEntityException", "The role cannot be found.", 404));
    expect((await driver.observe!(driverCtx(), id, ROLE_ARN)).presence).toBe("missing");
    iam.on(GetRoleCommand).rejects(awsError("AccessDenied", "no", 403));
    const denied = await driver.observe!(driverCtx(), id, ROLE_ARN);
    expect(denied.presence).toBe("inaccessible");
    expect(driftOf(id, denied, expectedAttributes)[0].class).toBe("inaccessible");
    iam.on(GetRoleCommand).rejects(awsError("Throttling", "slow", 400));
    expect((await driver.observe!(driverCtx(), id, ROLE_ARN)).presence).toBe("unknown");
  });

  it("finds the role by tags in us-east-1 (IAM is global) and refuses ambiguity", async () => {
    healthyRole();
    tagging.on(GetResourcesCommand).resolves({ ResourceTagMappingList: [{ ResourceARN: ROLE_ARN }] });
    expect((await driver.observe!(driverCtx(), id)).presence).toBe("present");
    expect(tagging.commandCalls(GetResourcesCommand)[0].args[0].input.ResourceTypeFilters).toEqual(["iam:role"]);
    tagging.on(GetResourcesCommand).resolves({ ResourceTagMappingList: [{ ResourceARN: ROLE_ARN }, { ResourceARN: `${ROLE_ARN}2` }] });
    expect((await driver.observe!(driverCtx(), id)).presence).toBe("unknown");
    tagging.on(GetResourcesCommand).resolves({ ResourceTagMappingList: [] });
    iam.on(GetRoleCommand).rejects(awsError("NoSuchEntityException", "The role cannot be found.", 404));
    expect((await driver.observe!(driverCtx(), id)).presence).toBe("missing");
  });

  it("falls back to the compiled role name when the IAM tagging index lags, only for this node's exact tags", async () => {
    tagging.on(GetResourcesCommand).resolves({ ResourceTagMappingList: [] });
    const compiled = roleNameFor({ namePrefix: environmentName("env_test") }, id.address);
    healthyRole();
    iam.on(GetRoleCommand, { RoleName: compiled }).resolves({ Role: { RoleName: compiled, Path: "/", RoleId: "x", CreateDate: new Date(), Arn: ROLE_ARN, AssumeRolePolicyDocument: enc(trustDoc), Tags: tagList(id.address) } });
    const found = await driver.observe!(driverCtx(), id);
    expect(iam.commandCalls(GetRoleCommand)[0].args[0].input).toEqual({ RoleName: compiled });
    expect(found.presence).toBe("present");
    iam.on(GetRoleCommand, { RoleName: compiled }).resolves({ Role: { RoleName: compiled, Path: "/", RoleId: "x", CreateDate: new Date(), Arn: ROLE_ARN, AssumeRolePolicyDocument: enc(trustDoc), Tags: tagList("identity/other") } });
    expect((await driver.observe!(driverCtx(), id)).presence).toBe("missing");
  });

  it("parses role references strictly", () => {
    expect(roleNameOf(ROLE_ARN)).toBe("zen-prod-web-role");
    expect(roleNameOf("arn:aws:iam::123456789012:role/some/path/name")).toBe("name");
    expect(roleNameOf("plain-name")).toBe("plain-name");
    expect(roleNameOf("arn:aws:iam::123456789012:user/bob")).toBeUndefined();
    expect(roleNameOf("has space")).toBeUndefined();
  });

  it("verify passes for a compliant role and fails for widened access", async () => {
    healthyRole();
    const c = driverCtx();
    expect((await driver.verify!(c, id, await driver.observe!(c, id, ROLE_ARN))).status).toBe("passed");
    iam.on(ListAttachedRolePoliciesCommand).resolves({ AttachedPolicies: [{ PolicyName: "x", PolicyArn: "arn:aws:iam::aws:policy/x" }] });
    const r = await driver.verify!(c, id, await driver.observe!(c, id, ROLE_ARN));
    expect(r.status).toBe("failed");
    expect(r.checks.find((x) => x.id === "no_managed_policies")!.passed).toBe(false);
  });

  it("expectedAttributes omits the action set for an invalid spec instead of throwing, so drift stays computable", () => {
    const broken = identity([grant("object_store/uploads", "frobnicate")]);
    const expected = expectedAttributes(broken);
    expect(expected).not.toHaveProperty("inlinePolicyActions");
    expect(expected).toMatchObject({ permissionsBoundaryArn: "arn:aws:iam::123456789012:policy/ZenithAppBoundary", wildcardAccess: false, attachedPolicyCount: 0 });
  });

  it("discover skips service-linked and reserved roles, reads tags within a bound, marks Zenith-tagged ones", async () => {
    iam.on(ListRolesCommand).resolves({
      IsTruncated: false,
      Roles: [
        { RoleName: "zen-prod-web-role", Path: "/", Arn: ROLE_ARN, RoleId: "a", CreateDate: new Date(), PermissionsBoundary: { PermissionsBoundaryArn: "arn:aws:iam::123456789012:policy/ZenithAppBoundary" } },
        { RoleName: "AWSServiceRoleForX", Path: "/aws-service-role/x.amazonaws.com/", Arn: "arn:aws:iam::123456789012:role/aws-service-role/x.amazonaws.com/AWSServiceRoleForX", RoleId: "b", CreateDate: new Date() },
        { RoleName: "AWSReservedSSO_Admin_1", Path: "/", Arn: "arn:aws:iam::123456789012:role/AWSReservedSSO_Admin_1", RoleId: "c", CreateDate: new Date() },
        { RoleName: "app-role", Path: "/", Arn: "arn:aws:iam::123456789012:role/app-role", RoleId: "d", CreateDate: new Date() },
      ],
    });
    iam.on(ListRoleTagsCommand, { RoleName: "zen-prod-web-role" }).resolves({ Tags: tagList("identity/web") });
    iam.on(ListRoleTagsCommand, { RoleName: "app-role" }).resolves({ Tags: [] });
    const found = await driver.discover!(driverCtx());
    expect(found.map((f) => [f.name, f.zenithTagged])).toEqual([
      ["app-role", false],
      ["zen-prod-web-role", true],
    ]);
  });
});
