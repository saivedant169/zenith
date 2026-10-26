/**
 * `aws:codebuild_project` — source builds in the customer's account (ADR-0016).
 *
 * Building a repository executes code nobody at Zenith has read. The build
 * therefore runs in AWS CodeBuild inside the CUSTOMER's account: an ephemeral
 * container with a role that can read its own source bundle, write its own
 * logs and push to exactly one ECR repository, and nothing else. The control
 * plane never builds in its own process and never gives CodeBuild Zenith
 * credentials.
 *
 * What compile creates (kind `build_pipeline`):
 *   - a private S3 bucket for the source bundle (the deploy workflow uploads
 *     `zenith/<environment>/<service>/<digest>.zip`; objects expire after 14 days). One per project
 *     rather than a shared "artifact bucket": nothing in the contracts names
 *     such a bucket and a per-project one keeps the role's S3 access to one
 *     prefix of one bucket the project owns;
 *   - a log group `/aws/codebuild/<project>` (30 days);
 *   - a service role (trust: codebuild.amazonaws.com; `ZenithWorkloadBoundary`)
 *     limited to: GetObject on `zenith/<environment>/*` of its bucket, stream writes to its
 *     log group, and — registry output — ECR push to exactly its repository or
 *     — static-site output — object writes to exactly the site's bucket plus a
 *     CloudFront invalidation on exactly its distribution. The only wildcard
 *     resources are `ecr:GetAuthorizationToken` on `*` (no resource-level
 *     permission exists for it) and key/stream SUFFIX patterns;
 *   - the project: source type S3 (the bundle is chosen per build with
 *     `sourceLocationOverride`), LINUX_CONTAINER on `aws/codebuild/standard:7.0`,
 *     `privileged_mode = true`, 30-minute timeout, NO VPC, no artifacts.
 *
 * SECURITY NOTE on `privileged_mode`: Docker builds need the Docker daemon,
 * which CodeBuild only enables in privileged mode. A privileged build
 * container can reach the host's Docker socket-equivalent capabilities, so
 * hostile build code must be assumed able to escape its container INTO the
 * CodeBuild host (not into the customer's account beyond the role above, and
 * not to Zenith). The mitigations are the ones ADR-0016 names: it runs in the
 * customer's account, ephemeral, with a scoped role, no VPC (no route to the
 * customer's private network) and no Zenith control-plane credentials.
 *
 * Builds: `startBuild` / `waitForBuild` / `stopBuild` (codebuild-builds.ts).
 * The buildspec builds with the repository's Dockerfile, tags the image
 * `src-<source digest>`, pushes it and EXPORTS the pushed image digest as the
 * build variable `ZENITH_IMAGE_DIGEST`; `waitForBuild` reads it from the
 * build's exported variables (an API field), never by scraping logs.
 *
 * Static-site output (`output.staticSite`): EXPERIMENTAL conventional Node
 * build (`npm ci` or `npm install`, `npm run build`, sync `dist|build|out|public`
 * — refused unless the execution layer sets `ctx.allowExperimentalAws`, from
 * the operator's `ZENITH_AWS_ALLOW_EXPERIMENTAL=1` —
 * to the site's bucket, invalidate CloudFront). A repository that needs
 * another toolchain should build through a Dockerfile instead.
 *
 * Evidence: `contract`. The current curated image `aws/codebuild/standard:8.0`
 * (Ubuntu 24.04) also exists; 7.0 is pinned because it is the one this
 * buildspec was written against.
 */
import { BatchGetProjectsCommand, CodeBuildClient, ListProjectsCommand, type Project } from "@aws-sdk/client-codebuild";
import type { AwsSession } from "@/lib/credentials/types";
import { BUILD_ROLE_SUFFIX, NAME_PREFIX } from "@/lib/credentials/aws/naming";
import type { CompileContext, DiscoveredResource, ResourceDriver } from "@/lib/drivers/types";
import type { Observation, ResourceNode } from "@/lib/resources/types";
import type { BuildPipelineSpec } from "@/lib/resources/specs";
import {
  attributesOf,
  boundNative,
  chunk,
  cloudName,
  failedObservation,
  hasZenithManagedTag,
  nodeName,
  paginate,
  parseArn,
  standardVerification,
  tfLabel,
} from "@/lib/providers/aws/drivers/shared";
import { contextDirOf } from "@/lib/execution/build-isolation";
import { egressGuardCommands, egressHosts } from "./codebuild-isolation";
import { emitPrivateBucket } from "./support/bucket";
import { compileNode, specOf } from "./support/driver-util";
import { ComputeCompileError, Frag, TfCat, TfRef, arnOf, assumeRoleJson, attr, boundaryArn, cat, environmentData, policyJson, refOf, tagsFor, type PolicyStatement } from "./support/tf";
import { failureOf, findByTags, lowerTagMap, type AwsCtx } from "./support/sdk";
import { DRIVER_IDS } from "./types";

const ID = DRIVER_IDS.codebuildProject;

export const CODEBUILD_IMAGE = "aws/codebuild/standard:7.0";
export const CODEBUILD_COMPUTE = "BUILD_GENERAL1_MEDIUM";
export const BUILD_TIMEOUT_MINUTES = 30;
/** Key prefix of source bundles in the project's bucket; the role can read only this prefix. */
export const SOURCE_PREFIX = "zenith/";
export const SOURCE_EXPIRY_DAYS = 14;

/** A single environment path segment; never allow IAM glob characters. */
export function sourcePrefixFor(environmentId: string): string | undefined {
  return typeof environmentId === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.exec(environmentId)?.[0] === environmentId ? `${SOURCE_PREFIX}${environmentId}/` : undefined;
}

const DOCKERFILE = /^(?!\/)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/;

/* --------------------------------- buildspec ------------------------------ */

/**
 * The Docker buildspec. The egress guard (PROD-LIFE-09) is part of the text: it is installed in
 * `pre_build` before the Dockerfile runs and aborts the build if it cannot take effect.
 */
export function dockerBuildspec(allowedHosts: readonly string[] = egressHosts(undefined), contextDir = "."): string {
  return [
    "version: 0.2",
    "env:",
    "  exported-variables:",
    "    - ZENITH_IMAGE_DIGEST",
    "phases:",
    "  pre_build:",
    "    on-failure: ABORT",
    "    commands:",
    '      - test -n "$ZENITH_SOURCE_DIGEST"',
    '      - test -f "$ZENITH_DOCKERFILE"',
    '      - REGISTRY_HOST=$(echo "$ZENITH_REPO_URL" | cut -d/ -f1)',
    '      - aws ecr get-login-password --region "$AWS_DEFAULT_REGION" | docker login --username AWS --password-stdin "$REGISTRY_HOST"',
    ...egressGuardCommands(allowedHosts),
    "  build:",
    "    on-failure: ABORT",
    "    commands:",
    `      - docker build -f "$ZENITH_DOCKERFILE" -t "$ZENITH_REPO_URL:src-$ZENITH_SOURCE_DIGEST" ${contextDir === "." ? "." : `'${contextDir}'`}`,
    "  post_build:",
    "    on-failure: ABORT",
    "    commands:",
    '      - docker push "$ZENITH_REPO_URL:src-$ZENITH_SOURCE_DIGEST"',
    '      - REPO_NAME=$(echo "$ZENITH_REPO_URL" | cut -d/ -f2-)',
    "      - export ZENITH_IMAGE_DIGEST=$(aws ecr describe-images --repository-name \"$REPO_NAME\" --image-ids imageTag=\"src-$ZENITH_SOURCE_DIGEST\" --query 'imageDetails[0].imageDigest' --output text)",
    '      - echo "ZENITH_IMAGE_DIGEST=$ZENITH_IMAGE_DIGEST"',
    "",
  ].join("\n");
}

export function staticBuildspec(): string {
  return [
    "version: 0.2",
    "phases:",
    "  install:",
    "    runtime-versions:",
    "      nodejs: 22",
    "  pre_build:",
    "    on-failure: ABORT",
    "    commands:",
    '      - test -n "$ZENITH_SITE_BUCKET"',
    "      - if [ -f package-lock.json ]; then npm ci; else npm install; fi",
    "  build:",
    "    on-failure: ABORT",
    "    commands:",
    "      - npm run build",
    "  post_build:",
    "    on-failure: ABORT",
    "    commands:",
    '      - OUT=""; for d in dist build out public; do if [ -z "$OUT" ] && [ -d "$d" ]; then OUT="$d"; fi; done',
    '      - test -n "$OUT"',
    '      - aws s3 sync "$OUT" "s3://$ZENITH_SITE_BUCKET/" --delete',
    '      - aws cloudfront create-invalidation --distribution-id "$ZENITH_DISTRIBUTION_ID" --paths "/*"',
    "",
  ].join("\n");
}

/** Does a successful build of this node produce an image digest? (registry output) */
export function buildExpectsImage(node: ResourceNode): boolean {
  return "registry" in ((node.spec as Partial<BuildPipelineSpec>).output ?? {});
}

/* --------------------------------- compile -------------------------------- */

const compile = (node: ResourceNode, ctx: CompileContext) =>
  compileNode(node, () => {
    const spec = specOf<BuildPipelineSpec>(node);
    if (spec.location !== "customer_account") throw new ComputeCompileError("unsupported", "builds run only in the customer's account (ADR-0016).");
    const dockerfile = spec.source?.dockerfile ?? "Dockerfile";
    if (!DOCKERFILE.test(dockerfile)) throw new ComputeCompileError("invalid_spec", "source.dockerfile must be a relative path inside the repository (letters, digits, . _ - /).");
    const label = tfLabel(node.address);
    const sourcePrefix = sourcePrefixFor(ctx.environmentId);
    if (!sourcePrefix) throw new ComputeCompileError("invalid_spec", "source environment must be a safe identifier without path or wildcard characters.");
    const name = nodeName(node.address);
    const projectName = cloudName(ctx.namePrefix, name, 255);
    // WorkloadLogs allows /aws/*/zenith-*; refuse an unusable project rather
    // than broadening the boundary for arbitrary application log groups.
    if (!projectName.startsWith(NAME_PREFIX)) throw new ComputeCompileError("invalid_spec", "build project names must start with zenith- to satisfy the workload boundary.");
    let allowedHosts: string[];
    try {
      allowedHosts = egressHosts(spec.isolation?.allowedHosts);
    } catch (e) {
      throw new ComputeCompileError("invalid_spec", e instanceof Error ? e.message : "invalid isolation.allowedHosts");
    }
    const b = new Frag(node.address);
    const env = environmentData(b, label, ctx.region);

    const output = spec.output as { registry?: string; staticSite?: string };
    const registry = output.registry !== undefined ? ctx.node(output.registry) : undefined;
    const site = output.staticSite !== undefined ? ctx.node(output.staticSite) : undefined;
    if (output.registry !== undefined && registry?.kind !== "container_registry") throw new ComputeCompileError("missing_neighbour", `output registry ${output.registry} is not a container_registry node.`);
    if (output.staticSite !== undefined && site?.kind !== "static_site") throw new ComputeCompileError("missing_neighbour", `output static site ${output.staticSite} is not a static_site node.`);
    if (output.staticSite !== undefined && ctx.allowExperimentalAws !== true) throw new ComputeCompileError("unsupported", "Static-site builds are experimental; set ZENITH_AWS_ALLOW_EXPERIMENTAL=1 on the Zenith host to allow them.");
    if (!registry && !site) throw new ComputeCompileError("invalid_spec", "the pipeline has no output (a registry or a static site).");

    const src = emitPrivateBucket(b, node, ctx, { label: `${label}_src`, nameBase: `${name}-src`, expireAfterDays: SOURCE_EXPIRY_DAYS, expirePrefix: sourcePrefix });
    const logs = b.resource("aws_cloudwatch_log_group", `${label}_logs`, { name: `/aws/codebuild/${projectName}`, retention_in_days: 30, tags: tagsFor(ctx, node) });

    // Preserve the principal discriminator even when cloudName hashes a long
    // or rewritten name. Short, already valid role names remain unchanged.
    const roleName = `${cloudName(ctx.namePrefix, name, 64 - BUILD_ROLE_SUFFIX.length)}${BUILD_ROLE_SUFFIX}`;
    const role = b.resource("aws_iam_role", label, {
      name: roleName,
      assume_role_policy: assumeRoleJson("codebuild.amazonaws.com", ctx),
      permissions_boundary: boundaryArn(env, "build", ctx),
      tags: tagsFor(ctx, node, roleName),
    });
    const statements: PolicyStatement[] = [
      { Sid: "WriteBuildLogs", Effect: "Allow", Action: ["logs:CreateLogStream", "logs:PutLogEvents"], Resource: [arnOf(env, "logs", ["log-group:", attr(logs, "name"), ":log-stream:build/*"])], wildcard: "log_stream" },
      { Sid: "ReadSourceBundle", Effect: "Allow", Action: ["s3:GetObject", "s3:GetObjectVersion"], Resource: [cat(src.arn, `/${sourcePrefix}*`)], wildcard: "object_keys" },
      { Sid: "LocateSourceBucket", Effect: "Allow", Action: ["s3:GetBucketLocation"], Resource: [src.arn] },
    ];
    const envVars: { name: string; value: string | TfRef | TfCat }[] = [{ name: "ZENITH_DOCKERFILE", value: dockerfile }];
    if (registry) {
      const repoArn = refOf(ctx, registry.address, "arn");
      statements.push(
        { Sid: "RegistryToken", Effect: "Allow", Action: ["ecr:GetAuthorizationToken"], Resource: ["*"], wildcard: "registry_token" },
        {
          Sid: "PushOwnRepository",
          Effect: "Allow",
          Action: ["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:CompleteLayerUpload", "ecr:DescribeImages", "ecr:GetDownloadUrlForLayer", "ecr:InitiateLayerUpload", "ecr:PutImage", "ecr:UploadLayerPart"],
          Resource: [repoArn],
        }
      );
      envVars.push({ name: "ZENITH_REPO_URL", value: refOf(ctx, registry.address, "repository_url") });
    }
    if (site) {
      statements.push(
        { Sid: "PublishSiteObjects", Effect: "Allow", Action: ["s3:DeleteObject", "s3:PutObject"], Resource: [cat(refOf(ctx, site.address, "bucket_arn"), "/*")], wildcard: "object_keys" },
        { Sid: "ListSiteBucket", Effect: "Allow", Action: ["s3:ListBucket"], Resource: [refOf(ctx, site.address, "bucket_arn")] },
        { Sid: "InvalidateSite", Effect: "Allow", Action: ["cloudfront:CreateInvalidation"], Resource: [refOf(ctx, site.address, "distribution_arn")] }
      );
      envVars.push({ name: "ZENITH_SITE_BUCKET", value: refOf(ctx, site.address, "bucket") }, { name: "ZENITH_DISTRIBUTION_ID", value: refOf(ctx, site.address, "distribution_id") });
    }
    const policy = b.resource("aws_iam_role_policy", label, { name: "build", role: attr(role, "name"), policy: policyJson(statements, `${node.address} build role`) });

    const project = b.resource("aws_codebuild_project", label, {
      name: projectName,
      description: `Builds ${node.address} from a source bundle in the customer's account`,
      service_role: attr(role, "arn"),
      build_timeout: BUILD_TIMEOUT_MINUTES,
      queued_timeout: 30,
      source: [{ type: "S3", location: cat(src.name, `/${sourcePrefix}bootstrap.zip`), buildspec: registry ? dockerBuildspec(allowedHosts, contextDirOf(spec, "aws")) : staticBuildspec() }],
      artifacts: [{ type: "NO_ARTIFACTS" }],
      environment: [
        {
          compute_type: CODEBUILD_COMPUTE,
          image: CODEBUILD_IMAGE,
          type: "LINUX_CONTAINER",
          image_pull_credentials_type: "CODEBUILD",
          // required for `docker build`; see the security note in the module comment
          privileged_mode: true,
          environment_variable: envVars.map((v) => ({ name: v.name, value: v.value, type: "PLAINTEXT" })),
        },
      ],
      logs_config: [{ cloudwatch_logs: [{ status: "ENABLED", group_name: attr(logs, "name"), stream_name: "build" }], s3_logs: [{ status: "DISABLED" }] }],
      tags: tagsFor(ctx, node, projectName),
      depends_on: [policy.expr],
    });
    b.expose("arn", attr(project, "arn"));
    b.expose("name", attr(project, "name"));
    b.expose("source_bucket", src.name);
    return b.build(project);
  });

/* --------------------------------- expected ------------------------------- */

function expected(_node: ResourceNode): Record<string, unknown> {
  return {
    sourceType: "S3",
    environmentType: "LINUX_CONTAINER",
    environmentImage: CODEBUILD_IMAGE,
    computeType: CODEBUILD_COMPUTE,
    privilegedMode: true,
    timeoutMinutes: BUILD_TIMEOUT_MINUTES,
    inVpc: false,
  };
}

/* --------------------------------- observe -------------------------------- */

export function projectNameOf(externalId: string): string | undefined {
  const arn = parseArn(externalId);
  const name = arn ? (arn.service === "codebuild" && arn.resource.startsWith("project/") ? arn.resource.slice("project/".length) : undefined) : externalId;
  return name !== undefined && /^[A-Za-z0-9][A-Za-z0-9_-]{1,254}$/.test(name) ? name : undefined;
}

/** Project named by `externalId` or found by tags, with its tags. Throws on API failures. */
export async function loadProject(ctx: AwsCtx, node: ResourceNode, externalId?: string): Promise<{ project?: Project; externalId?: string; failure?: { kind: "missing" | "error"; code: string; summary: string } }> {
  let id = externalId;
  if (!id) {
    const found = await findByTags(ctx, node, "codebuild:project");
    if (found.length > 1) return { failure: { kind: "error", code: "Ambiguous", summary: `${found.length} CodeBuild projects carry the tags of ${node.address}.` } };
    if (found.length === 0) return { failure: { kind: "missing", code: "NotFoundByTags", summary: "No CodeBuild project carries this node's Zenith tags (the tag index is eventually consistent)." } };
    id = found[0].arn;
  }
  const name = projectNameOf(id);
  if (!name) return { externalId: id, failure: { kind: "error", code: "InvalidExternalId", summary: "externalId is not a CodeBuild project ARN or name." } };
  const cb = ctx.session.client(CodeBuildClient);
  const res = await cb.send(new BatchGetProjectsCommand({ names: [name] }), { abortSignal: ctx.signal });
  const project = res.projects?.[0];
  if (!project) return { externalId: id, failure: { kind: "missing", code: "ProjectNotFound", summary: "BatchGetProjects reports no such project." } };
  return { project, externalId: project.arn ?? id };
}

export function sourceBucketOf(project: Project): string | undefined {
  const loc = project.source?.location;
  const bucket = typeof loc === "string" ? loc.split("/")[0] : undefined;
  return bucket && /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) ? bucket : undefined;
}

const observe: NonNullable<ResourceDriver<AwsSession>["observe"]> = async (ctx, node, externalId): Promise<Observation> => {
  const names = Object.keys(expected(node));
  let loaded: Awaited<ReturnType<typeof loadProject>>;
  try {
    loaded = await loadProject(ctx, node, externalId);
  } catch (e) {
    return failedObservation(ctx, node, ID, names, failureOf(ctx, e), externalId);
  }
  if (!loaded.project) return failedObservation(ctx, node, ID, names, { ...loaded.failure!, kind: loaded.failure!.kind }, loaded.externalId);
  const p = loaded.project;
  const attributes = attributesOf(ctx, names, {
    ...(p.source?.type ? { sourceType: p.source.type } : {}),
    ...(p.environment?.type ? { environmentType: p.environment.type } : {}),
    ...(p.environment?.image ? { environmentImage: p.environment.image } : {}),
    ...(p.environment?.computeType ? { computeType: p.environment.computeType } : {}),
    ...(p.environment ? { privilegedMode: p.environment.privilegedMode === true } : {}),
    ...(p.timeoutInMinutes !== undefined ? { timeoutMinutes: p.timeoutInMinutes } : {}),
    inVpc: Boolean(p.vpcConfig?.vpcId),
  });
  return {
    address: node.address,
    externalId: loaded.externalId,
    presence: "present",
    attributes,
    native: boundNative(
      {
        projectName: p.name,
        serviceRole: p.serviceRole,
        ...(sourceBucketOf(p) ? { sourceBucket: sourceBucketOf(p) } : {}),
        ...(p.logsConfig?.cloudWatchLogs?.groupName ? { logGroupName: p.logsConfig.cloudWatchLogs.groupName } : {}),
        tags: lowerTagMap(p.tags),
      },
      { priority: ["projectName", "serviceRole", "tags"] }
    ),
    observedAt: ctx.now().toISOString(),
    source: ID,
    simulated: false,
  };
};

/* --------------------------------- discover ------------------------------- */

const discover: NonNullable<ResourceDriver<AwsSession>["discover"]> = async (ctx): Promise<DiscoveredResource[]> => {
  const cb = ctx.session.client(CodeBuildClient);
  const listed = await paginate<string>(
    async (token) => {
      const res = await cb.send(new ListProjectsCommand({ ...(token ? { nextToken: token } : {}) }), { abortSignal: ctx.signal });
      return { items: res.projects ?? [], next: res.nextToken };
    },
    { maxPages: 3, signal: ctx.signal }
  );
  const out: DiscoveredResource[] = [];
  for (const names of chunk(listed.items.sort().slice(0, 100), 100)) {
    const res = await cb.send(new BatchGetProjectsCommand({ names }), { abortSignal: ctx.signal });
    for (const p of res.projects ?? []) {
      if (!p.arn || !p.name) continue;
      out.push({
        provider: "aws",
        kind: "build_pipeline",
        nativeType: "aws:codebuild_project",
        externalId: p.arn,
        name: p.name,
        region: ctx.region,
        zenithTagged: hasZenithManagedTag(lowerTagMap(p.tags)),
        attributes: {
          sourceType: p.source?.type ?? "unknown",
          environmentImage: p.environment?.image ?? "unknown",
          privilegedMode: p.environment?.privilegedMode === true,
        },
      });
    }
  }
  return out;
};

export const codebuildProjectDriver: ResourceDriver<AwsSession> = {
  id: ID,
  provider: "aws",
  kind: "build_pipeline",
  nativeType: "aws:codebuild_project",
  capabilities: {
    compile: true,
    observe: true,
    runtime: false,
    verify: true,
    discover: true,
    operations: [],
    evidence: { compile: "contract", observe: "contract", verify: "contract", discover: "contract" },
  },
  compile,
  observe,
  expectedAttributes: expected,
  verify: async (ctx, node, observation) => standardVerification(ctx, node, observation, expected(node), "The CodeBuild project"),
  discover,
};
