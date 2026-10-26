/**
 * `aws:codebuild_project` (ADR-0016): compile, read side, and the build
 * helpers the deploy workflow calls (startBuild / waitForBuild / stopBuild).
 * Mocked CodeBuild / tagging clients; contract evidence only.
 */
import { BatchGetBuildsCommand, BatchGetProjectsCommand, CodeBuildClient, ListProjectsCommand, StartBuildCommand, StopBuildCommand, type Build } from "@aws-sdk/client-codebuild";
import { GetResourcesCommand, ResourceGroupsTaggingAPIClient } from "@aws-sdk/client-resource-groups-tagging-api";
import { mockClient } from "aws-sdk-client-mock";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { TofuFragment } from "@/lib/drivers/types";
import { BUILD_TIMEOUT_MINUTES, CODEBUILD_IMAGE, buildExpectsImage, codebuildProjectDriver as driver, dockerBuildspec, staticBuildspec } from "@/lib/providers/aws/drivers/compute/codebuild-project";
import { startBuild, stopBuild, waitForBuild } from "@/lib/providers/aws/drivers/compute/codebuild-builds";
import { DriverCompileError, refLocalName } from "@/lib/providers/aws/drivers/shared";
import { buildFullFixture, mkCompileContext, mkDriverContext, zenithTagList } from "./fixtures";
import { ACCOUNT } from "./ecs-mocks";
import { boundaryAllows, familyBoundary } from "../../../../credentials/workload-boundary";
import { BOUNDARY_ACCOUNT, BOUNDARY_PREFIX, policyRequests } from "./boundary-fixtures";

const cb = mockClient(CodeBuildClient);
const tagging = mockClient(ResourceGroupsTaggingAPIClient);
afterAll(() => {
  cb.restore();
  tagging.restore();
});
beforeEach(() => {
  cb.reset();
  tagging.reset();
});

type Body = Record<string, unknown>;
const res = (f: TofuFragment, type: string, label: string): Body => (f.resource as Record<string, Record<string, Body>>)[type][label];
const fx = buildFullFixture();
const ctx = () => mkCompileContext(fx.byAddress, { namePrefix: BOUNDARY_PREFIX });
const docker = driver.compile!(fx.pipeline, ctx());
const site = driver.compile!(fx.siteBuild, ctx());
const asList = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : [v as string]);
const policy = (f: TofuFragment, label: string): Body[] => JSON.parse(res(f, "aws_iam_role_policy", label).policy as string).Statement;

describe("build role policy intersects the bootstrap boundary", () => {
  it.each(["registry", "static site"])("allows every compiled %s action and resource for the build principal", (output) => {
    const node = output === "registry" ? fx.pipeline : fx.siteBuild;
    const label = output === "registry" ? "build_pipeline_web" : "build_pipeline_docs";
    const fragment = driver.compile!(node, mkCompileContext(fx.byAddress, { namePrefix: BOUNDARY_PREFIX }));
    const principal = `arn:aws:iam::${BOUNDARY_ACCOUNT}:role/${res(fragment, "aws_iam_role", label).name}`;
    const refs = {
      [`local.${refLocalName(fx.registry.address, "arn")}`]: `arn:aws:ecr:eu-west-1:${BOUNDARY_ACCOUNT}:repository/${BOUNDARY_PREFIX}-web`,
      [`local.${refLocalName(fx.site.address, "bucket_arn")}`]: `arn:aws:s3:::${BOUNDARY_PREFIX}-docs-abcdef12`,
      [`local.${refLocalName(fx.site.address, "distribution_arn")}`]: `arn:aws:cloudfront::${BOUNDARY_ACCOUNT}:distribution/EDOCS`,
    };
    const requests = policyRequests(fragment, refs);
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
      expect(boundaryAllows(familyBoundary("build"), request.action, request.resource, {
        "aws:PrincipalArn": principal, "aws:ResourceTag/zenith:managed": "true", "s3:ResourceAccount": BOUNDARY_ACCOUNT,
      }), `${request.action} ${request.resource}`).toBe(true);
    }
  });

  it.each(["web", "x".repeat(200), "web.with/odd_chars"])("keeps the build discriminator after cloudName sanitization/truncation: %s", (name) => {
    const node = { ...fx.pipeline, address: `build_pipeline/${name}` };
    const fragment = driver.compile!(node, mkCompileContext(fx.byAddress, { namePrefix: BOUNDARY_PREFIX }));
    const role = Object.values(fragment.resource!.aws_iam_role)[0];
    expect(role.name).toMatch(/^zenith-.*-build$/);
    expect(String(role.name).length).toBeLessThanOrEqual(64);
  });

  it.each(["zn-acme", "", "foreign-env"])("refuses a prefix outside the boundary log scope: %j", (namePrefix) => {
    expect(() => driver.compile!(fx.pipeline, mkCompileContext(fx.byAddress, { namePrefix }))).toThrow(/must start with zenith-/);
  });
});

describe("compile: registry output", () => {
  it("is a LINUX_CONTAINER on the pinned standard image, privileged for Docker, 30 minutes, no VPC, no artifacts", () => {
    expect(docker.addresses[0]).toBe("aws_codebuild_project.build_pipeline_web");
    const p = res(docker, "aws_codebuild_project", "build_pipeline_web");
    const env = (p.environment as Body[])[0];
    expect(env).toMatchObject({ type: "LINUX_CONTAINER", image: CODEBUILD_IMAGE, privileged_mode: true, compute_type: "BUILD_GENERAL1_MEDIUM", image_pull_credentials_type: "CODEBUILD" });
    expect(CODEBUILD_IMAGE).toBe("aws/codebuild/standard:7.0");
    expect(p.build_timeout).toBe(BUILD_TIMEOUT_MINUTES);
    expect(BUILD_TIMEOUT_MINUTES).toBe(30);
    expect(p).not.toHaveProperty("vpc_config");
    expect(p.artifacts).toEqual([{ type: "NO_ARTIFACTS" }]);
    expect(p.source).toMatchObject([{ type: "S3" }]);
    const source = (p.source as Body[])[0];
    expect(source.location).toBe("${aws_s3_bucket.build_pipeline_web_src.bucket}/zenith/env_1/bootstrap.zip");
  });

  it("passes the repository and Dockerfile as plain environment variables and never a credential", () => {
    const env = ((res(docker, "aws_codebuild_project", "build_pipeline_web").environment as Body[])[0].environment_variable as Body[]).map((v) => [v.name, v.value, v.type]);
    expect(env).toEqual([
      ["ZENITH_DOCKERFILE", "Dockerfile", "PLAINTEXT"],
      ["ZENITH_REPO_URL", `\${local.${refLocalName("container_registry/web", "repository_url")}}`, "PLAINTEXT"],
    ]);
    expect(JSON.stringify(docker)).not.toMatch(/AKIA|secret_access|aws_access_key|session_token/i);
  });

  it("builds with the repository Dockerfile, tags the image with the source digest, pushes it and exports the digest as a build variable", () => {
    const spec = dockerBuildspec();
    expect(spec).toContain("version: 0.2");
    expect(spec).toContain("exported-variables:\n    - ZENITH_IMAGE_DIGEST");
    expect(spec).toContain('docker build -f "$ZENITH_DOCKERFILE" -t "$ZENITH_REPO_URL:src-$ZENITH_SOURCE_DIGEST" .');
    expect(spec).toContain('docker push "$ZENITH_REPO_URL:src-$ZENITH_SOURCE_DIGEST"');
    expect(spec).toContain("ZENITH_IMAGE_DIGEST=$(aws ecr describe-images");
    expect(spec).toContain('echo "ZENITH_IMAGE_DIGEST=$ZENITH_IMAGE_DIGEST"'); // the machine-readable line
    // a failing step stops the build: post_build must not push after a failed build
    expect(spec.match(/on-failure: ABORT/g)).toHaveLength(3);
    // the buildspec is shell text; it must not contain a tofu interpolation
    expect(spec).not.toContain("${");
    const p = res(docker, "aws_codebuild_project", "build_pipeline_web");
    expect(((p.source as Body[])[0]).buildspec).toBe(spec);
  });

  it("uses the Dockerfile path from the spec and refuses paths that escape the repository", () => {
    const custom = { ...fx.pipeline, spec: { ...fx.pipeline.spec, source: { repo: "r", ref: "main", dockerfile: "services/api/Dockerfile.prod" } } };
    const env = ((res(driver.compile!(custom, ctx()), "aws_codebuild_project", "build_pipeline_web").environment as Body[])[0].environment_variable as Body[]).find((v) => v.name === "ZENITH_DOCKERFILE");
    expect(env!.value).toBe("services/api/Dockerfile.prod");
    for (const bad of ["../Dockerfile", "/etc/Dockerfile", "a b/Dockerfile", "Dockerfile;rm -rf /", "a/../../b", "${x}", "x".repeat(300)]) {
      const n = { ...fx.pipeline, spec: { ...fx.pipeline.spec, source: { repo: "r", ref: "main", dockerfile: bad } } };
      expect(() => driver.compile!(n, ctx()), bad).toThrow(DriverCompileError);
    }
  });

  it("keeps the source bundle in a private, encrypted bucket of its own that expires old bundles", () => {
    const bucket = "build_pipeline_web_src";
    expect(res(docker, "aws_s3_bucket", bucket)).toMatchObject({ force_destroy: true });
    expect(res(docker, "aws_s3_bucket_public_access_block", bucket)).toMatchObject({ block_public_acls: true, block_public_policy: true, ignore_public_acls: true, restrict_public_buckets: true });
    expect(res(docker, "aws_s3_bucket_ownership_controls", bucket).rule).toEqual([{ object_ownership: "BucketOwnerEnforced" }]);
    expect(res(docker, "aws_s3_bucket_server_side_encryption_configuration", bucket).rule).toEqual([{ apply_server_side_encryption_by_default: [{ sse_algorithm: "AES256" }] }]);
    const rule = (res(docker, "aws_s3_bucket_lifecycle_configuration", bucket).rule as Body[])[0];
    expect(rule).toMatchObject({ status: "Enabled", filter: [{ prefix: "zenith/env_1/" }], expiration: [{ days: 14 }] });
    expect(res(docker, "random_id", "build_pipeline_web_src_suffix")).toEqual({ byte_length: 4 });
    // no bucket policy that could open it up
    expect(docker.resource).not.toHaveProperty("aws_s3_bucket_policy");
  });

  it("gives the build role only its source prefix, its log streams and ITS repository", () => {
    const statements = policy(docker, "build_pipeline_web");
    expect(statements.map((s) => s.Sid)).toEqual(["WriteBuildLogs", "ReadSourceBundle", "LocateSourceBucket", "RegistryToken", "PushOwnRepository"]);
    const push = statements.find((s) => s.Sid === "PushOwnRepository")!;
    expect(push.Resource).toBe(`\${local.${refLocalName("container_registry/web", "arn")}}`);
    expect(asList(push.Action).sort()).toEqual(["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:CompleteLayerUpload", "ecr:DescribeImages", "ecr:GetDownloadUrlForLayer", "ecr:InitiateLayerUpload", "ecr:PutImage", "ecr:UploadLayerPart"]);
    const read = statements.find((s) => s.Sid === "ReadSourceBundle")!;
    expect(read.Resource).toBe("${aws_s3_bucket.build_pipeline_web_src.arn}/zenith/env_1/*");
    expect(asList(read.Action)).toEqual(["s3:GetObject", "s3:GetObjectVersion"]);
  });

  it("has no wildcard action, exactly one bare `*` resource (ecr:GetAuthorizationToken), and only trailing-suffix wildcards elsewhere", () => {
    for (const f of [docker, site]) {
      const all = policy(f, "build_pipeline_" + (f === docker ? "web" : "docs"));
      const bare: string[] = [];
      const suffix: string[] = [];
      for (const st of all) {
        for (const a of asList(st.Action)) expect(a).not.toContain("*");
        for (const r of asList(st.Resource)) {
          if (r === "*") bare.push(...asList(st.Action));
          else if (r.includes("*")) {
            expect(r.indexOf("*")).toBe(r.length - 1);
            suffix.push(r);
          }
        }
      }
      expect(bare).toEqual(f === docker ? ["ecr:GetAuthorizationToken"] : []); // the static-site build has no ECR access at all
      expect(suffix.length).toBeGreaterThan(0);
      expect(suffix.every((s) => /:log-stream:build\/\*$|\/zenith\/env_1\/\*$|\/\*$/.test(s))).toBe(true);
    }
  });

  it("the role is a boundary-carrying CodeBuild role and the logs go to a tofu-owned group", () => {
    const role = res(docker, "aws_iam_role", "build_pipeline_web");
    expect(JSON.parse(role.assume_role_policy as string).Statement[0].Principal).toEqual({ Service: "codebuild.amazonaws.com" });
    expect(role.permissions_boundary).toMatch(/ZenithBuildBoundary$/);
    const logs = res(docker, "aws_cloudwatch_log_group", "build_pipeline_web_logs");
    expect(logs).toMatchObject({ name: `/aws/codebuild/${BOUNDARY_PREFIX}-web`, retention_in_days: 30 });
    const cfg = (res(docker, "aws_codebuild_project", "build_pipeline_web").logs_config as Body[])[0];
    expect(cfg.cloudwatch_logs).toEqual([{ status: "ENABLED", group_name: "${aws_cloudwatch_log_group.build_pipeline_web_logs.name}", stream_name: "build" }]);
  });

  it("publishes arn, name and the source bucket", () => {
    expect(Object.keys(docker.locals!).sort()).toEqual(["arn", "name", "source_bucket"].map((a) => refLocalName("build_pipeline/web", a)).sort());
  });

  it("is deterministic and tags the project", () => {
    expect(JSON.stringify(driver.compile!(fx.pipeline, ctx()))).toBe(JSON.stringify(docker));
    expect(res(docker, "aws_codebuild_project", "build_pipeline_web").tags).toMatchObject({ "zenith:resource": "build_pipeline/web", "zenith:managed": "true" });
  });

  it("binds IAM reads, expiry and bootstrap location to a different environment", () => {
    const other = driver.compile!(fx.pipeline, { ...ctx(), environmentId: "env-other" });
    expect(policy(other, "build_pipeline_web").find((s) => s.Sid === "ReadSourceBundle")!.Resource).toBe("${aws_s3_bucket.build_pipeline_web_src.arn}/zenith/env-other/*");
    expect(res(other, "aws_s3_bucket_lifecycle_configuration", "build_pipeline_web_src").rule).toMatchObject([{ filter: [{ prefix: "zenith/env-other/" }] }]);
    expect(res(other, "aws_codebuild_project", "build_pipeline_web").source).toMatchObject([{ location: "${aws_s3_bucket.build_pipeline_web_src.bucket}/zenith/env-other/bootstrap.zip" }]);
  });

  it.each(["", "../env", "env/*", "env?", "env\n", "x".repeat(129)])("refuses unsafe environment scope %j at compile", (environmentId) => {
    expect(() => driver.compile!(fx.pipeline, mkCompileContext(fx.byAddress, { environmentId }))).toThrow(DriverCompileError);
  });

  it("declares contract evidence, and whether a node's successful build yields an image", () => {
    expect(Object.values(driver.capabilities.evidence).every((v) => v === "contract")).toBe(true);
    expect(buildExpectsImage(fx.pipeline)).toBe(true);
    expect(buildExpectsImage(fx.siteBuild)).toBe(false);
  });
});

describe("compile: static-site output (experimental)", () => {
  it("syncs the build output to the site's bucket and invalidates only its distribution", () => {
    const statements = policy(site, "build_pipeline_docs");
    expect(statements.map((s) => s.Sid)).toEqual(["WriteBuildLogs", "ReadSourceBundle", "LocateSourceBucket", "PublishSiteObjects", "ListSiteBucket", "InvalidateSite"]);
    expect(statements.find((s) => s.Sid === "InvalidateSite")).toMatchObject({ Action: "cloudfront:CreateInvalidation", Resource: `\${local.${refLocalName("static_site/docs", "distribution_arn")}}` });
    expect(statements.find((s) => s.Sid === "PublishSiteObjects")!.Resource).toBe(`\${local.${refLocalName("static_site/docs", "bucket_arn")}}/*`);
    const env = ((res(site, "aws_codebuild_project", "build_pipeline_docs").environment as Body[])[0].environment_variable as Body[]).map((v) => v.name);
    expect(env).toEqual(["ZENITH_DOCKERFILE", "ZENITH_SITE_BUCKET", "ZENITH_DISTRIBUTION_ID"]);
    // no ECR at all
    expect(JSON.stringify(statements)).not.toContain("ecr:");
    const spec = staticBuildspec();
    expect(spec).toContain("npm run build");
    expect(spec).toContain('aws s3 sync "$OUT" "s3://$ZENITH_SITE_BUCKET/" --delete');
    expect(spec).not.toContain("${");
  });

  it.each([
    ["an output that is not a container_registry", (n: Body) => ({ ...n, output: { registry: "log_group/web" } }), /is not a container_registry node/],
    ["an output that is not a static site", (n: Body) => ({ ...n, output: { staticSite: "container_service/web" } }), /is not a static_site node/],
    ["no output at all", (n: Body) => ({ ...n, output: {} }), /no output/],
    ["a build location outside the customer's account", (n: Body) => ({ ...n, location: "zenith" }), /only in the customer's account/],
  ])("refuses %s", (_name, mutate, message) => {
    const n = { ...fx.pipeline, spec: mutate(fx.pipeline.spec as Body) };
    expect(() => driver.compile!(n, ctx())).toThrow(message);
  });

  it("refuses a static-site build unless the execution layer opted in (ZENITH_AWS_ALLOW_EXPERIMENTAL=1); registry builds are unaffected", () => {
    const closed = mkCompileContext(fx.byAddress, { namePrefix: BOUNDARY_PREFIX, allowExperimentalAws: false });
    expect(() => driver.compile!(fx.siteBuild, closed)).toThrow(/Static-site builds are experimental; set ZENITH_AWS_ALLOW_EXPERIMENTAL=1/);
    expect(() => driver.compile!(fx.pipeline, closed)).not.toThrow();
  });
});

/* --------------------------------- read side -------------------------------- */

const PROJECT_ARN = `arn:aws:codebuild:eu-west-1:${ACCOUNT}:project/zn-acme-web`;
const cbTags = (address = "build_pipeline/web") => zenithTagList(address).map(({ Key, Value }) => ({ key: Key, value: Value }));
const project = (over: Body = {}) => ({
  name: "zn-acme-web",
  arn: PROJECT_ARN,
  serviceRole: `arn:aws:iam::${ACCOUNT}:role/zn-acme-web-build`,
  source: { type: "S3" as const, location: "zn-acme-web-src-1a2b3c4d/zenith/env_1/bootstrap.zip" },
  environment: { type: "LINUX_CONTAINER" as const, image: CODEBUILD_IMAGE, computeType: "BUILD_GENERAL1_MEDIUM" as const, privilegedMode: true },
  timeoutInMinutes: 30,
  logsConfig: { cloudWatchLogs: { status: "ENABLED" as const, groupName: "/aws/codebuild/zn-acme-web" } },
  tags: cbTags(),
  ...over,
});
const node = fx.pipeline;

describe("observe / verify / discover", () => {
  it("reads the project configuration by ARN", async () => {
    cb.on(BatchGetProjectsCommand).resolves({ projects: [project()] });
    const obs = await driver.observe!(mkDriverContext(), node, PROJECT_ARN);
    expect(obs).toMatchObject({ presence: "present", externalId: PROJECT_ARN, source: "aws.codebuild_project@1" });
    expect(Object.fromEntries(Object.entries(obs.attributes).map(([k, v]) => [k, (v as { value: unknown }).value]))).toEqual({
      sourceType: "S3",
      environmentType: "LINUX_CONTAINER",
      environmentImage: "aws/codebuild/standard:7.0",
      computeType: "BUILD_GENERAL1_MEDIUM",
      privilegedMode: true,
      timeoutMinutes: 30,
      inVpc: false,
    });
    expect(obs.native).toMatchObject({ projectName: "zn-acme-web", sourceBucket: "zn-acme-web-src-1a2b3c4d", logGroupName: "/aws/codebuild/zn-acme-web" });
    expect(Object.keys(obs.attributes).sort()).toEqual(Object.keys(driver.expectedAttributes!(node)).sort());
    expect((await driver.verify!(mkDriverContext(), node, obs)).status).toBe("passed");
  });

  it("finds the project by tags, and reports drift: an added VPC, no privileged mode, a different image", async () => {
    tagging.on(GetResourcesCommand).resolves({ ResourceTagMappingList: [{ ResourceARN: PROJECT_ARN, Tags: zenithTagList("build_pipeline/web") }] });
    cb.on(BatchGetProjectsCommand).resolves({ projects: [project({ vpcConfig: { vpcId: "vpc-1" }, environment: { type: "LINUX_CONTAINER", image: "aws/codebuild/standard:5.0", computeType: "BUILD_GENERAL1_MEDIUM", privilegedMode: false } })] });
    const obs = await driver.observe!(mkDriverContext(), node);
    expect(tagging.commandCalls(GetResourcesCommand)[0].args[0].input.ResourceTypeFilters).toEqual(["codebuild:project"]);
    const v = await driver.verify!(mkDriverContext(), node, obs);
    expect(v.status).toBe("failed");
    expect(v.checks.filter((c) => c.passed === false).map((c) => c.id).sort()).toEqual(["attr:environmentImage", "attr:inVpc", "attr:privilegedMode"]);
  });

  it("missing when BatchGetProjects returns nothing or tags find nothing; inaccessible/unknown otherwise", async () => {
    cb.on(BatchGetProjectsCommand).resolves({ projects: [], projectsNotFound: ["zn-acme-web"] });
    expect((await driver.observe!(mkDriverContext(), node, PROJECT_ARN)).presence).toBe("missing");
    tagging.on(GetResourcesCommand).resolves({ ResourceTagMappingList: [] });
    expect((await driver.observe!(mkDriverContext(), node)).presence).toBe("missing");
    cb.reset();
    cb.on(BatchGetProjectsCommand).rejects(Object.assign(new Error("denied"), { name: "AccessDeniedException" }));
    expect((await driver.observe!(mkDriverContext(), node, PROJECT_ARN)).presence).toBe("inaccessible");
    cb.reset();
    cb.on(BatchGetProjectsCommand).rejects(Object.assign(new Error("slow down"), { name: "ThrottlingException" }));
    expect((await driver.observe!(mkDriverContext(), node, PROJECT_ARN)).presence).toBe("unknown");
    expect((await driver.observe!(mkDriverContext(), node, "bad name!")).presence).toBe("unknown");
  });

  it("discovers projects with their tags", async () => {
    cb.on(ListProjectsCommand).resolves({ projects: ["zn-acme-web", "legacy"] });
    cb.on(BatchGetProjectsCommand).resolves({ projects: [project(), project({ name: "legacy", arn: `arn:aws:codebuild:eu-west-1:${ACCOUNT}:project/legacy`, tags: [], environment: { type: "LINUX_CONTAINER", image: "x", privilegedMode: false } })] });
    const found = await driver.discover!(mkDriverContext());
    expect(Object.fromEntries(found.map((f) => [f.name, f.zenithTagged]))).toEqual({ "zn-acme-web": true, legacy: false });
    expect(found[0]).toMatchObject({ kind: "build_pipeline", nativeType: "aws:codebuild_project" });
  });
});

/* ---------------------------------- builds ---------------------------------- */

const BUILD_ID = "zn-acme-web:11111111-2222-3333-4444-555555555555";
const SOURCE_DIGEST = "ab".repeat(32);
const IMAGE_DIGEST = `sha256:${"e".repeat(64)}`;

function installProject(over: Body = {}) {
  tagging.on(GetResourcesCommand).resolves({ ResourceTagMappingList: [{ ResourceARN: PROJECT_ARN, Tags: zenithTagList("build_pipeline/web") }] });
  cb.on(BatchGetProjectsCommand).resolves({ projects: [project(over)] });
}
const build = (over: Partial<Build> = {}): Build => ({
  id: BUILD_ID,
  buildStatus: "SUCCEEDED",
  buildComplete: true,
  startTime: new Date("2026-09-30T12:00:00.000Z"),
  endTime: new Date("2026-09-30T12:03:30.000Z"),
  logs: { groupName: "/aws/codebuild/zn-acme-web", streamName: "build/11111111-2222-3333-4444-555555555555", deepLink: "https://console.aws.amazon.com/cloudwatch/home" },
  exportedEnvironmentVariables: [{ name: "ZENITH_IMAGE_DIGEST", value: IMAGE_DIGEST }],
  phases: [],
  ...over,
});

describe("startBuild", () => {
  const input = { sourceS3Key: `zenith/env_1/web/${SOURCE_DIGEST}.zip`, sourceDigest: `sha256:${SOURCE_DIGEST}` };
  const ctxOp = (op = "op_build_1") => mkDriverContext({ operationId: op });

  it("refuses a launch without canonical PostgreSQL authority before touching AWS", async () => {
    installProject();
    await expect(startBuild(ctxOp(), node, input)).rejects.toMatchObject({ code: "build_launch_unconfirmed" });
    expect(cb.calls()).toHaveLength(0);
    expect(tagging.calls()).toHaveLength(0);
  });

  it.each([
    ["a legacy source/ key", { ...input, sourceS3Key: `source/${SOURCE_DIGEST}.zip` }, /environment/],
    ["another environment's key", { ...input, sourceS3Key: `zenith/foreign/web/${SOURCE_DIGEST}.zip` }, /environment/],
    ["an environment prefix collision", { ...input, sourceS3Key: `zenith/env_10/web/${SOURCE_DIGEST}.zip` }, /environment/],
    ["a key that walks up", { ...input, sourceS3Key: `zenith/env_1/../${SOURCE_DIGEST}.zip` }, /valid.*object key/],
    ["an absolute key", { ...input, sourceS3Key: `/zenith/env_1/web/${SOURCE_DIGEST}.zip` }, /environment/],
    ["a key with shell characters", { ...input, sourceS3Key: `zenith/env_1/web;id/${SOURCE_DIGEST}.zip` }, /valid.*object key/],
    ["an empty key", { ...input, sourceS3Key: "" }, /environment/],
    ["a tar.gz bundle", { ...input, sourceS3Key: `zenith/env_1/web/${SOURCE_DIGEST}.tar.gz` }, /ZIP/],
    ["a folder source", { ...input, sourceS3Key: "zenith/env_1/web/" }, /ZIP/],
    ["an arbitrary object name", { ...input, sourceS3Key: "zenith/env_1/web/bootstrap.zip" }, /ZIP/],
    ["a mismatched bundle digest", { ...input, sourceS3Key: `zenith/env_1/web/${"f".repeat(64)}.zip` }, /match sourceDigest/],
    ["a newline in the key", { ...input, sourceS3Key: `${input.sourceS3Key}\n` }, /ZIP/],
    ["a newline in the digest", { ...input, sourceDigest: `${SOURCE_DIGEST}\n` }, /sha256/],
    ["a short digest", { ...input, sourceDigest: "abc123" }, /sha256/],
    ["a non-hex digest", { ...input, sourceDigest: "g".repeat(64) }, /sha256/],
    ["a digest with a command in it", { ...input, sourceDigest: `${SOURCE_DIGEST}; id` }, /sha256/],
  ])("refuses %s before touching AWS", async (_name, bad, message) => {
    installProject();
    await expect(startBuild(ctxOp(), node, bad as typeof input)).rejects.toMatchObject({ name: "OperationRefused", message: expect.stringMatching(message) });
    expect(cb.commandCalls(StartBuildCommand)).toHaveLength(0);
    expect(cb.commandCalls(BatchGetProjectsCommand)).toHaveLength(0);
  });

  it.each(["*", "../env", "env/other", "env\n", ""])("refuses unsafe environment scope %j before AWS", async (environmentId) => {
    await expect(startBuild(mkDriverContext({ environmentId }), node, input)).rejects.toMatchObject({ name: "OperationRefused" });
    expect(cb.calls()).toHaveLength(0); expect(tagging.calls()).toHaveLength(0);
  });


});

describe("waitForBuild", () => {
  const instant = (record: number[] = []) => async (ms: number) => void record.push(ms);
  const clock = () => {
    let t = 0;
    return () => (t += 500);
  };

  it("returns the exported image digest, the log location and the duration on success", async () => {
    cb.on(BatchGetBuildsCommand).resolves({ builds: [build()] });
    const r = await waitForBuild(mkDriverContext(), BUILD_ID, { sleep: instant() });
    expect(r).toEqual({
      buildId: BUILD_ID,
      status: "SUCCEEDED",
      imageDigest: IMAGE_DIGEST,
      logs: { groupName: "/aws/codebuild/zn-acme-web", streamName: "build/11111111-2222-3333-4444-555555555555", deepLink: "https://console.aws.amazon.com/cloudwatch/home" },
      durationSec: 210,
      polls: 1,
    });
    expect(cb.commandCalls(BatchGetBuildsCommand)[0].args[0].input).toEqual({ ids: [BUILD_ID] });
  });

  it("polls with a growing interval capped at maxPollMs until the build finishes", async () => {
    cb.on(BatchGetBuildsCommand)
      .resolvesOnce({ builds: [build({ buildStatus: "IN_PROGRESS", buildComplete: false })] })
      .resolvesOnce({ builds: [build({ buildStatus: "IN_PROGRESS", buildComplete: false })] })
      .resolvesOnce({ builds: [build({ buildStatus: "IN_PROGRESS", buildComplete: false })] })
      .resolvesOnce({ builds: [build({ buildStatus: "IN_PROGRESS", buildComplete: false })] })
      .resolves({ builds: [build()] });
    const waits: number[] = [];
    const r = await waitForBuild(mkDriverContext(), BUILD_ID, { sleep: instant(waits), pollMs: 5000, maxPollMs: 10_000, now: clock(), timeoutMs: 3_600_000 });
    expect(r.status).toBe("SUCCEEDED");
    expect(r.polls).toBe(5);
    expect(waits).toEqual([5000, 7500, 10_000, 10_000]);
  });

  it.each(["FAILED", "FAULT", "TIMED_OUT", "STOPPED"] as const)("reports %s without an image digest and names the failing phase", async (status) => {
    cb.on(BatchGetBuildsCommand).resolves({
      builds: [build({ buildStatus: status, exportedEnvironmentVariables: [{ name: "ZENITH_IMAGE_DIGEST", value: IMAGE_DIGEST }], phases: [{ phaseType: "SUBMITTED", phaseStatus: "SUCCEEDED" }, { phaseType: "BUILD", phaseStatus: "FAILED" }] })],
    });
    const r = await waitForBuild(mkDriverContext(), BUILD_ID, { sleep: instant() });
    expect(r).toMatchObject({ status, failedPhase: "BUILD" });
    expect(r).not.toHaveProperty("imageDigest"); // a digest from a failed build is never handed to a deployment
    expect(r.logs.groupName).toBe("/aws/codebuild/zn-acme-web");
  });

  it("a successful build that exported no (or a malformed) digest is FAILED: a deployment needs a digest to verify", async () => {
    for (const exported of [[], [{ name: "OTHER", value: "x" }], [{ name: "ZENITH_IMAGE_DIGEST", value: "latest" }], [{ name: "ZENITH_IMAGE_DIGEST", value: "sha256:short" }], [{ name: "ZENITH_IMAGE_DIGEST", value: `sha256:${"E".repeat(64)}` }], [{ name: "ZENITH_IMAGE_DIGEST", value: `${IMAGE_DIGEST}\nx` }]]) {
      cb.reset();
      cb.on(BatchGetBuildsCommand).resolves({ builds: [build({ exportedEnvironmentVariables: exported })] });
      const r = await waitForBuild(mkDriverContext(), BUILD_ID, { sleep: instant() });
      expect(r).toMatchObject({ status: "FAILED", failureReason: "no_image_digest" });
      expect(r).not.toHaveProperty("imageDigest");
    }
  });

  it("a static-site build succeeds without a digest when told not to expect one", async () => {
    cb.on(BatchGetBuildsCommand).resolves({ builds: [build({ exportedEnvironmentVariables: [] })] });
    const r = await waitForBuild(mkDriverContext(), BUILD_ID, { sleep: instant(), expectImageDigest: false });
    expect(r.status).toBe("SUCCEEDED");
    expect(r).not.toHaveProperty("imageDigest");
  });

  it("gives up at its own deadline with WAIT_TIMEOUT and leaves the build running", async () => {
    cb.on(BatchGetBuildsCommand).resolves({ builds: [build({ buildStatus: "IN_PROGRESS", buildComplete: false })] });
    const r = await waitForBuild(mkDriverContext(), BUILD_ID, { sleep: instant(), pollMs: 1000, timeoutMs: 4000, now: clock() });
    expect(r.status).toBe("WAIT_TIMEOUT");
    expect(r.polls).toBeGreaterThan(1);
    expect(r.polls).toBeLessThan(10);
    expect(cb.commandCalls(StopBuildCommand)).toHaveLength(0);
  });

  it("rejects promptly when the operation is aborted while waiting", async () => {
    cb.on(BatchGetBuildsCommand).resolves({ builds: [build({ buildStatus: "IN_PROGRESS", buildComplete: false })] });
    const ac = new AbortController();
    const p = waitForBuild(mkDriverContext({ signal: ac.signal }), BUILD_ID, { pollMs: 60_000 });
    setTimeout(() => ac.abort(), 20);
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(cb.commandCalls(BatchGetBuildsCommand)).toHaveLength(1);
  });

  it("an already-aborted signal never calls AWS again after the first read", async () => {
    cb.on(BatchGetBuildsCommand).callsFake(() => {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    });
    const ac = new AbortController();
    ac.abort();
    await expect(waitForBuild(mkDriverContext({ signal: ac.signal }), BUILD_ID, {})).rejects.toMatchObject({ name: "AbortError" });
  });

  it.each(["", "zn-acme-web", "zn-acme-web:not-a-uuid", "../x:11111111-2222-3333-4444-555555555555", "x;y:11111111-2222-3333-4444-555555555555"])("refuses build id %j", async (id) => {
    await expect(waitForBuild(mkDriverContext(), id, { sleep: instant() })).rejects.toMatchObject({ name: "OperationRefused" });
    expect(cb.commandCalls(BatchGetBuildsCommand)).toHaveLength(0);
  });

  it("fails when the build does not exist and propagates provider errors", async () => {
    cb.on(BatchGetBuildsCommand).resolves({ builds: [] });
    await expect(waitForBuild(mkDriverContext(), BUILD_ID, { sleep: instant() })).rejects.toMatchObject({ name: "OperationRefused", message: expect.stringMatching(/not found/) });
    cb.reset();
    cb.on(BatchGetBuildsCommand).rejects(Object.assign(new Error("denied"), { name: "AccessDeniedException" }));
    await expect(waitForBuild(mkDriverContext(), BUILD_ID, { sleep: instant() })).rejects.toMatchObject({ name: "AccessDeniedException" });
  });
});

describe("stopBuild", () => {
  it("stops a build by id", async () => {
    cb.on(StopBuildCommand).resolves({ build: { id: BUILD_ID, buildStatus: "STOPPED" }, $metadata: { requestId: "req-stop" } });
    expect(await stopBuild(mkDriverContext(), BUILD_ID)).toEqual({ status: "STOPPED", requestIds: ["req-stop"] });
    expect(cb.commandCalls(StopBuildCommand)[0].args[0].input).toEqual({ id: BUILD_ID });
    await expect(stopBuild(mkDriverContext(), "nope")).rejects.toMatchObject({ name: "OperationRefused" });
  });
});
