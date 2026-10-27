/**
 * `aws:iam_role` driver (kind `identity`): one least-privilege workload role.
 *
 * Compile:
 *   EKS IRSA uses the exact rendered ServiceAccount subject and STS audience.
 *   The cluster's spec.oidcProviderOwner names one IAM role owning its OIDC
 *   provider; its ARN is a cluster-keyed local. External/missing prerequisites
 *   emit only a note, never an ECS service trust for a Kubernetes workload.
 *   aws_iam_role          trust for the workload's service principal
 *                         (`ecs-tasks` for container services and scheduled
 *                         jobs, `lambda`, `codebuild`, `ec2`), constrained to
 *                         this account (`aws:SourceAccount`), and
 *                         `permissions_boundary` = the bootstrap
 *                         `ZenithAppBoundary` policy
 *   aws_iam_role_policy   ONE inline policy compiled from
 *                         `IdentitySpec.grants` (see `iam-grants.ts`): exact
 *                         actions on exact ARNs, no wildcard action, no
 *                         `Resource: "*"`; compilation FAILS rather than emit one
 *   data sources          `aws_caller_identity`, `aws_partition` and the two
 *                         `aws_iam_policy_document`s (trust, grants)
 *
 * Permissions boundary: production compilation derives the exact canonical
 * family ARN from saved connection account, partition and bootstrapNameSuffix.
 * Standalone rendering without connection context retains unsuffixed data-source
 * references. Policy path is always `/`; graph fields cannot override it.
 * Bootstrap policy parity is tested locally; customer policy existence is not
 * live-verified.
 *
 * Observe: GetRole, ListRolePolicies + GetRolePolicy (policy documents are
 * URL-decoded and normalized to sorted actions), ListAttachedRolePolicies.
 * Reported: the trust principals, the boundary's full policy ARN, the sorted set of
 * actions in Allow statements, whether any Allow statement uses a wildcard
 * action or resource, and the number of attached managed policies (Zenith
 * attaches none, so anything above 0 widened access outside Zenith).
 *
 * Honest limits: resource ARNs inside the policy are not compared (the desired
 * ARNs are tofu references, unknown without a plan), so a swapped resource
 * with the same actions is not reported as drift by `expectedAttributes`; the
 * action set, wildcard check, boundary and attachments are. `contract` evidence
 * only.
 */
import { AWS_ROLE_BOUNDARIES, awsBoundaryArn, environmentName, trustedAwsBoundaryArn } from "@/lib/credentials/aws/naming";
import { isZenithTagged, TAG_RESOURCE } from "@/lib/providers/aws/drivers/shared/tags";
import { isAwsPartition, principalForPartition, type AwsPartition } from "@/lib/credentials/aws/partition";
import {
  GetRoleCommand,
  GetRolePolicyCommand,
  IAMClient,
  ListAttachedRolePoliciesCommand,
  ListRolePoliciesCommand,
  ListRolesCommand,
  ListRoleTagsCommand,
  type Role,
} from "@aws-sdk/client-iam";
import type { CompileContext, DiscoveredResource, ResourceDriver, TofuFragment } from "@/lib/drivers/types";
import type { AwsSession } from "@/lib/credentials/types";
import type { IdentityGrant, IdentitySpec } from "@/lib/resources/specs";
import type { Observation, ResourceNode } from "@/lib/resources/types";
import { workloadTrust } from "@/lib/providers/gcp/drivers/identity/workload-trust";
import {
  cloudName,
  DriverCompileError,
  FragmentBuilder,
  isArnOf,
  nodeKindPrefix,
  nodeName,
  paginate,
  parseArn,
  partitionOfRegion,
  REF,
  resourceTags,
  refLocalName,
  tfLabel,
  tfLiteral,
} from "@/lib/providers/aws/drivers/shared";
import {
  compileGrantStatements,
  expectedGrantActions,
  type AccountRefs,
  type PolicyStatement,
} from "./iam-grants";
import {
  classifyAwsError,
  attrCheck,
  Attributes,
  call,
  candidate,
  EMPTY_FRAGMENT,
  failAttributes,
  findByTags,
  guardObserve,
  isManaged,
  matchesExpectedCheck,
  MAX_TAG_READS,
  scalars,
  tagMap,
  verificationOf,
  type AwsDriverContext,
  type ReadResult,
} from "./support";

export const IAM_ROLE_SOURCE = "aws.iam_role@1";
export const PERMISSIONS_BOUNDARY_NAME = AWS_ROLE_BOUNDARIES.app.policyName;
/** IAM caps the aggregate size of a role's inline policies at 10,240 characters (whitespace excluded). */
const MAX_INLINE_POLICY_CHARS = 10_000;

/** Service principal by the workload's node kind. */
export const TRUST_PRINCIPAL_BY_WORKLOAD: Readonly<Record<string, string>> = {
  container_service: "ecs-tasks.amazonaws.com",
  scheduled_job: "ecs-tasks.amazonaws.com",
  function: "lambda.amazonaws.com",
  build_pipeline: "codebuild.amazonaws.com",
  compute_instance: "ec2.amazonaws.com",
};

/** Trust principals that accept an `aws:SourceAccount` confused-deputy condition. */
const SOURCE_ACCOUNT_CAPABLE = new Set(["ecs-tasks.amazonaws.com", "lambda.amazonaws.com", "codebuild.amazonaws.com"]);

const ROLE_NAME = /^[\w+=,.@-]{1,64}$/;

export function readIdentitySpec(node: ResourceNode): IdentitySpec {
  const raw = node.spec as Partial<IdentitySpec>;
  if (typeof raw.workload !== "string" || raw.workload === "") throw new DriverCompileError("invalid_spec", node.address, "spec.workload must name the workload node this identity is for.");
  if (!Array.isArray(raw.grants)) throw new DriverCompileError("invalid_spec", node.address, "spec.grants must be a list.");
  for (const g of raw.grants) {
    if (g === null || typeof g !== "object" || typeof g.target !== "string" || !Array.isArray(g.access) || g.access.some((a) => typeof a !== "string")) {
      throw new DriverCompileError("invalid_spec", node.address, "each grant needs a target address and a list of access verbs.");
    }
  }
  return { principal: "workload", workload: raw.workload, grants: raw.grants as IdentityGrant[] };
}

/** The service principal that may assume the role, from the workload node's kind (or its address prefix). */
export function trustPrincipalFor(node: ResourceNode, ctx: Pick<CompileContext, "node"> & Partial<Pick<CompileContext, "awsBootstrap" | "region">>, workload: string): string {
  const kind = ctx.node(workload)?.kind ?? nodeKindPrefix(workload);
  const principal = TRUST_PRINCIPAL_BY_WORKLOAD[kind];
  if (!principal) throw new DriverCompileError("unsupported", node.address, `no trust principal is defined for a ${kind} workload (${workload}).`);
  return principalForPartition(contractPartition(ctx.awsBootstrap?.partition, ctx.region), principal);
}

/** Partition-aware principal rendering is contract-level; commercial regions render exactly the commercial principals. */
function contractPartition(known: string | undefined, region: string | undefined): AwsPartition {
  const partition = known ?? (region ? partitionOfRegion(region) : "aws");
  return isAwsPartition(partition) ? partition : "aws";
}

export const roleNameFor = (ctx: Pick<CompileContext, "namePrefix">, address: string): string => `${cloudName(ctx.namePrefix, nodeName(address), 64 - "-role".length)}-role`;

/** The boundary policy ARN as a tofu template (see the module comment for why it is not a variable). */
function boundaryArn(acct: AccountRefs): string {
  return awsBoundaryArn("app", acct.partition, acct.accountId);
}

/** Characters an inline policy will occupy, estimated generously (40 per unresolved ARN). */
function estimatePolicyChars(statements: readonly PolicyStatement[]): number {
  let n = 40;
  for (const s of statements) {
    n += 80 + s.sid.length;
    for (const a of s.actions) n += a.length + 4;
    for (const r of s.resources) n += (r.includes("${") ? 130 : r.length) + 4;
  }
  return n;
}

export function compileIamRole(node: ResourceNode, ctx: CompileContext): TofuFragment {
  if (!isManaged(node)) return { ...EMPTY_FRAGMENT };
  const spec = readIdentitySpec(node);
  const label = tfLabel(node.address);
  const name = roleNameFor(ctx, node.address);
  const trust = workloadTrust(node, ctx);
  const note = (detail: string): TofuFragment => ({ addresses: [], output: { [`${label}_trust_note`]: { value: tfLiteral(detail) } } });
  if (trust.state === "unresolved") return note(trust.note);
  // Without graph enumeration an implicit owner could create the same OIDC
  // provider in multiple fragments. The cluster explicitly names ONE managed
  // IAM role as owner; every role references the same cluster-keyed ARN local.
  let oidcOwner: ResourceNode | undefined;
  if (trust.state === "ready") {
    const owner = trust.cluster.spec.oidcProviderOwner;
    oidcOwner = typeof owner === "string" ? ctx.node(owner) : undefined;
    const ownerTrust = oidcOwner && workloadTrust(oidcOwner, ctx);
    if (!oidcOwner || oidcOwner.ownership !== "managed" || oidcOwner.provider !== "aws" || oidcOwner.nativeType !== "aws:iam_role" || ownerTrust?.state !== "ready" || ownerTrust.cluster.address !== trust.cluster.address) {
      return note(`${node.address}: EKS cluster spec.oidcProviderOwner must select one managed IAM role for this cluster; no cloud workload trust rendered.`);
    }
  }
  const principal = trust.state === "none" ? trustPrincipalFor(node, ctx, spec.workload) : undefined;
  const acct: AccountRefs = {
    partition: `\${data.aws_partition.${label}_partition.partition}`,
    accountId: `\${data.aws_caller_identity.${label}_account.account_id}`,
  };
  const statements = compileGrantStatements(node, ctx, spec.grants, acct);
  if (estimatePolicyChars(statements) > MAX_INLINE_POLICY_CHARS) {
    throw new DriverCompileError("unsupported", node.address, `the compiled inline policy would exceed IAM's ${MAX_INLINE_POLICY_CHARS}-character role limit (${statements.length} statements); split the workload.`);
  }

  const b = new FragmentBuilder(node.address);
  // Primary resource first: `addresses[0]` is what `ctx.ref` falls back to.
  b.resource("aws_iam_role", label, {
    name,
    description: `Zenith workload role for ${node.address.replace(/[^A-Za-z0-9/_.-]/g, "-")}`,
    assume_role_policy: `\${data.aws_iam_policy_document.${label}_trust.json}`,
    permissions_boundary: trustedAwsBoundaryArn(ctx.awsBootstrap, "app") ?? boundaryArn(acct),
    force_detach_policies: true,
    tags: resourceTags(ctx.tags, node.address),
  });
  if (statements.length > 0) {
    b.resource("aws_iam_role_policy", `${label}_grants`, {
      name: "zenith-grants",
      role: `\${aws_iam_role.${label}.id}`,
      policy: `\${data.aws_iam_policy_document.${label}_grants.json}`,
    });
  }
  b.data("aws_caller_identity", `${label}_account`, {});
  b.data("aws_partition", `${label}_partition`, {});
  let trustStatement: Record<string, unknown>;
  if (trust.state === "ready") {
    const clusterLabel = tfLabel(trust.cluster.address);
    const providerLabel = `${clusterLabel}_workload_oidc`;
    const issuer = ctx.ref(trust.cluster.address, "identity[0].oidc[0].issuer");
    const issuerHost = `\${replace(${issuer.slice(2, -1)}, "https://", "")}`;
    const providerArn = `\${local.${refLocalName(trust.cluster.address, "oidc_provider_arn")}}`;
    if (oidcOwner?.address === node.address) {
      b.resource("aws_iam_openid_connect_provider", providerLabel, {
        url: issuer,
        client_id_list: ["sts.amazonaws.com"],
        // AWS retrieves the CA thumbprint when omitted; never pin a made-up certificate.
        tags: resourceTags(ctx.tags, trust.cluster.address),
      });
      b.local(refLocalName(trust.cluster.address, "oidc_provider_arn"), `\${aws_iam_openid_connect_provider.${providerLabel}.arn}`);
    }
    trustStatement = {
      sid: "AssumeByServiceAccount", effect: "Allow", actions: ["sts:AssumeRoleWithWebIdentity"],
      principals: [{ type: "Federated", identifiers: [providerArn] }],
      condition: [
        { test: "StringEquals", variable: `${issuerHost}:sub`, values: [trust.subject] },
        { test: "StringEquals", variable: `${issuerHost}:aud`, values: ["sts.amazonaws.com"] },
      ],
    };
  } else {
    trustStatement = {
      sid: "AssumeByWorkload", effect: "Allow", actions: ["sts:AssumeRole"],
      principals: [{ type: "Service", identifiers: [principal] }],
      ...(principal && SOURCE_ACCOUNT_CAPABLE.has(principal) ? { condition: [{ test: "StringEquals", variable: "aws:SourceAccount", values: [acct.accountId] }] } : {}),
    };
  }
  b.data("aws_iam_policy_document", `${label}_trust`, {
    statement: [trustStatement],
  });
  if (statements.length > 0) {
    b.data("aws_iam_policy_document", `${label}_grants`, {
      statement: statements.map((s) => ({ sid: s.sid, effect: "Allow", actions: s.actions, resources: s.resources })),
    });
  }

  b.expose(REF.arn, `aws_iam_role.${label}.arn`);
  b.expose(REF.id, `aws_iam_role.${label}.id`);
  b.expose("name", `aws_iam_role.${label}.name`);
  b.output(`${label}_arn`, `\${aws_iam_role.${label}.arn}`);
  b.output(`${label}_name`, `\${aws_iam_role.${label}.name}`);
  return b.build();
}

/* --------------------------------- reading --------------------------------- */

const EXPECTED_NAMES = ["permissionsBoundaryArn", "trustPrincipals", "inlinePolicyActions", "wildcardAccess", "attachedPolicyCount"] as const;
const INFORMATIONAL_NAMES = ["inlinePolicyCount"] as const;
export const IAM_ATTRIBUTE_NAMES: readonly string[] = [...EXPECTED_NAMES, ...INFORMATIONAL_NAMES];

export function expectedIamAttributes(node: ResourceNode, ctx?: Pick<CompileContext, "awsBootstrap">): Record<string, unknown> {
  if (!isManaged(node)) return {};
  const out: Record<string, unknown> = { permissionsBoundaryArn: trustedAwsBoundaryArn(ctx?.awsBootstrap, "app"), wildcardAccess: false, attachedPolicyCount: 0 };
  try {
    const spec = readIdentitySpec(node);
    out.inlinePolicyActions = expectedGrantActions(node.address, spec.grants);
    const workloadKind = nodeKindPrefix(spec.workload);
    const principal = TRUST_PRINCIPAL_BY_WORKLOAD[workloadKind];
    // Explicit Kubernetes links do not select the native service principal.
    // The issuer ARN and namespace are graph facts unavailable to this method.
    if (principal && node.spec.cluster === undefined && node.spec.serviceAccount === undefined) out.trustPrincipals = [principalForPartition(contractPartition(ctx?.awsBootstrap?.partition, node.region), principal)];
  } catch (err) {
    // An invalid spec has no defined action set; drift then compares only the fixed attributes instead of failing for every node.
    if (!(err instanceof DriverCompileError)) throw err;
  }
  return out;
}

export interface NormalizedStatement {
  effect: string;
  actions: string[];
  resources: string[];
  hasCondition: boolean;
  /** NotAction / NotResource make a statement broader than it reads; treated as wildcard access */
  negated: boolean;
}

const toList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : typeof v === "string" ? [v] : []);

/** URL-decode (IAM returns documents percent-encoded), parse and normalize a policy document; `undefined` when unparseable. */
export function normalizePolicyDocument(raw: string | undefined): NormalizedStatement[] | undefined {
  if (raw === undefined) return undefined;
  let text = raw;
  try {
    text = decodeURIComponent(raw);
  } catch {
    // not percent-encoded
  }
  try {
    const doc = JSON.parse(text) as { Statement?: unknown };
    const list = Array.isArray(doc.Statement) ? doc.Statement : doc.Statement ? [doc.Statement] : [];
    return list.map((s) => {
      const st = s as Record<string, unknown>;
      return {
        effect: typeof st.Effect === "string" ? st.Effect : "",
        actions: toList(st.Action).sort(),
        resources: toList(st.Resource).sort(),
        hasCondition: st.Condition !== undefined,
        negated: st.NotAction !== undefined || st.NotResource !== undefined,
      };
    });
  } catch {
    return undefined;
  }
}

export function summarizePolicies(docs: readonly NormalizedStatement[][]): { actions: string[]; wildcard: boolean } {
  const actions = new Set<string>();
  let wildcard = false;
  for (const doc of docs) {
    for (const s of doc) {
      if (s.effect !== "Allow") continue;
      for (const a of s.actions) {
        actions.add(a);
        if (/[*?]/.test(a)) wildcard = true;
      }
      if (s.resources.some((r) => r === "*") || s.negated) wildcard = true;
    }
  }
  return { actions: [...actions].sort(), wildcard };
}

/** Service principals in a trust policy document, sorted. */
export function trustPrincipalsOf(raw: string | undefined): string[] | undefined {
  const statements = normalizedTrust(raw);
  if (statements === undefined) return undefined;
  return [...new Set(statements)].sort();
}

function normalizedTrust(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  let text = raw;
  try {
    text = decodeURIComponent(raw);
  } catch {
    // not percent-encoded
  }
  try {
    const doc = JSON.parse(text) as { Statement?: unknown };
    const list = Array.isArray(doc.Statement) ? doc.Statement : doc.Statement ? [doc.Statement] : [];
    const out: string[] = [];
    for (const s of list) {
      const st = s as { Effect?: string; Principal?: unknown };
      if (st.Effect !== "Allow" || st.Principal === undefined) continue;
      if (st.Principal === "*") {
        out.push("*");
        continue;
      }
      const p = st.Principal as { Service?: unknown; AWS?: unknown; Federated?: unknown };
      for (const svc of toList(p.Service)) out.push(svc);
      for (const other of [...toList(p.AWS), ...toList(p.Federated)]) out.push(other);
    }
    return out;
  } catch {
    return undefined;
  }
}

/** ARN or bare name to the role name IAM calls take. */
export function roleNameOf(externalId: string | undefined): string | undefined {
  if (externalId === undefined || externalId === "") return undefined;
  if (externalId.startsWith("arn:")) {
    if (!isArnOf(externalId, "iam", "role")) return undefined;
    const last = (parseArn(externalId)?.resource ?? "").split("/").pop();
    return last && ROLE_NAME.test(last) ? last : undefined;
  }
  return ROLE_NAME.test(externalId) ? externalId : undefined;
}

/**
 * The IAM tagging index (us-east-1) lags role creation, so a role created minutes ago can be absent from it. The compiled
 * name is deterministic: accept it only when the role there carries this node's exact Zenith tags.
 */
async function compiledRoleName(ctx: AwsDriverContext, node: ResourceNode): Promise<{ name: string } | undefined> {
  const RoleName = roleNameFor({ namePrefix: environmentName(ctx.environmentId) }, node.address);
  try {
    const { Role: role } = await call(ctx, (o) => ctx.session.client(IAMClient).send(new GetRoleCommand({ RoleName }), o));
    const tags = tagMap(role?.Tags);
    return role && isZenithTagged(tags, ctx) && tags[TAG_RESOURCE] === node.address ? { name: RoleName } : undefined;
  } catch (error) {
    if ((error as { name?: unknown })?.name === "NoSuchEntityException" || (error as { name?: unknown })?.name === "NoSuchEntity") return undefined;
    throw error;
  }
}

async function resolveRoleName(ctx: AwsDriverContext, node: ResourceNode, externalId: string | undefined): Promise<{ name: string } | "missing" | { ambiguous: string }> {
  const name = roleNameOf(externalId);
  if (externalId !== undefined && externalId !== "" && name === undefined) return { ambiguous: "externalId is not an IAM role ARN or name" };
  if (name !== undefined) return { name };
  // IAM is global; its tagging index lives in us-east-1.
  const { matches } = await findByTags(ctx, node, "iam:role", { region: "us-east-1" });
  const names = matches.flatMap((m) => {
    const n = roleNameOf(m.arn);
    return n ? [n] : [];
  });
  if (names.length === 0) return (await compiledRoleName(ctx, node)) ?? "missing";
  if (names.length > 1) return { ambiguous: `${names.length} roles carry the Zenith tags for ${node.address}; refusing to choose one` };
  return { name: names[0] };
}

const MAX_INLINE_POLICIES = 10;

async function observeRole(ctx: AwsDriverContext, node: ResourceNode, externalId?: string): Promise<Observation> {
  return guardObserve(
    ctx,
    node,
    IAM_ROLE_SOURCE,
    IAM_ATTRIBUTE_NAMES,
    externalId,
    async (): Promise<ReadResult> => {
      const found = await resolveRoleName(ctx, node, externalId);
      if (found === "missing") return { kind: "missing" };
      if ("ambiguous" in found) return { kind: "ambiguous", detail: found.ambiguous };
      const RoleName = found.name;
      const iam = ctx.session.client(IAMClient);

      const { Role: role } = await call(ctx, (o) => iam.send(new GetRoleCommand({ RoleName }), o));
      if (!role) return { kind: "missing", detail: "GetRole returned no role" };

      const a = new Attributes(ctx);
      const boundary = role.PermissionsBoundary?.PermissionsBoundaryArn;
      a.set("permissionsBoundaryArn", boundary ?? "none");
      const trust = trustPrincipalsOf(role.AssumeRolePolicyDocument);
      if (trust) a.set("trustPrincipals", trust);
      else a.unknown("trustPrincipals", "error", "the trust policy could not be parsed");

      const policyDocs: NormalizedStatement[][] = [];
      let inlineNames: string[] = [];
      try {
        const list = await call(ctx, (o) => iam.send(new ListRolePoliciesCommand({ RoleName }), o));
        inlineNames = (list.PolicyNames ?? []).slice(0, MAX_INLINE_POLICIES);
        let unparseable = false;
        for (const PolicyName of inlineNames) {
          const got = await call(ctx, (o) => iam.send(new GetRolePolicyCommand({ RoleName, PolicyName }), o));
          const norm = normalizePolicyDocument(got.PolicyDocument);
          if (norm) policyDocs.push(norm);
          else unparseable = true;
        }
        if (unparseable || (list.PolicyNames?.length ?? 0) > MAX_INLINE_POLICIES || list.IsTruncated) {
          for (const n of ["inlinePolicyActions", "wildcardAccess"]) a.unknown(n, "error", "an inline policy could not be fully read");
        } else {
          const summary = summarizePolicies(policyDocs);
          a.set("inlinePolicyActions", summary.actions);
          a.set("wildcardAccess", summary.wildcard);
        }
        a.set("inlinePolicyCount", list.PolicyNames?.length ?? 0);
      } catch (err) {
        const f = classifyAwsError(err, ctx.signal);
        if (f.kind === "aborted") throw err;
        failAttributes(a.out, ["inlinePolicyActions", "wildcardAccess", "inlinePolicyCount"], f);
      }

      try {
        const attached = await call(ctx, (o) => iam.send(new ListAttachedRolePoliciesCommand({ RoleName }), o));
        a.set("attachedPolicyCount", attached.AttachedPolicies?.length ?? 0);
      } catch (err) {
        const f = classifyAwsError(err, ctx.signal);
        if (f.kind === "aborted") throw err;
        failAttributes(a.out, ["attachedPolicyCount"], f);
      }

      return {
        kind: "present",
        externalId: role.Arn ?? externalId ?? "",
        attributes: a.finish(IAM_ATTRIBUTE_NAMES),
        native: {
          roleName: role.RoleName ?? RoleName,
          path: role.Path,
          tags: tagMap(role.Tags),
          permissionsBoundaryArn: boundary,
          inlinePolicyNames: inlineNames,
          // Normalized, sorted statements; bounded and dropped first if the native bag is too large.
          inlinePolicies: policyDocs.map((d) => d.map((s) => ({ effect: s.effect, actions: s.actions, resources: s.resources }))),
        },
      };
    },
    ["tags", "roleName", "permissionsBoundaryArn"]
  );
}

/* -------------------------------- discover --------------------------------- */

const SKIPPED_ROLE = /^\/(aws-service-role|service-role|aws-reserved)\//;

async function discoverRoles(ctx: AwsDriverContext): Promise<DiscoveredResource[]> {
  const iam = ctx.session.client(IAMClient);
  const { items } = await paginate(
    async (marker) => {
      const out = await call(ctx, (o) => iam.send(new ListRolesCommand({ MaxItems: 100, ...(marker ? { Marker: marker } : {}) }), o));
      return { items: out.Roles ?? [], next: out.IsTruncated ? out.Marker : undefined };
    },
    { maxPages: 10, signal: ctx.signal }
  );
  const roles = items.filter((r: Role) => r.RoleName && r.Arn && !SKIPPED_ROLE.test(r.Path ?? "/") && !r.RoleName.startsWith("AWSReservedSSO_"));
  const found: DiscoveredResource[] = [];
  let reads = 0;
  for (const r of roles) {
    let tags: Record<string, string> | undefined;
    if (reads < MAX_TAG_READS) {
      reads++;
      try {
        tags = tagMap((await call(ctx, (o) => iam.send(new ListRoleTagsCommand({ RoleName: r.RoleName }), o))).Tags);
      } catch (err) {
        const f = classifyAwsError(err, ctx.signal);
        if (f.kind === "aborted") throw err;
      }
    }
    found.push(
      candidate(ctx, {
        kind: "identity",
        nativeType: "aws:iam_role",
        externalId: r.Arn as string,
        name: r.RoleName as string,
        // IAM is global; the region is the session's.
        ...(tags ? { tags } : {}),
        attributes: scalars({ path: r.Path, tagsRead: tags !== undefined, hasBoundary: r.PermissionsBoundary?.PermissionsBoundaryArn !== undefined }),
      })
    );
  }
  return found.sort((a, b) => (a.externalId < b.externalId ? -1 : a.externalId > b.externalId ? 1 : 0));
}

export const iamRoleDriver: ResourceDriver<AwsSession> = {
  id: IAM_ROLE_SOURCE,
  provider: "aws",
  kind: "identity",
  nativeType: "aws:iam_role",
  capabilities: {
    compile: true,
    observe: true,
    runtime: false,
    verify: true,
    discover: true,
    operations: [],
    evidence: { compile: "contract", observe: "contract", verify: "contract", discover: "contract" },
  },
  compile: compileIamRole,
  observe: observeRole,
  expectedAttributes: expectedIamAttributes,
  async verify(ctx, node, observation) {
    const expectedBoundary = trustedAwsBoundaryArn(ctx.awsBootstrap, "app");
    const checks = [
      expectedBoundary
        ? attrCheck(observation, "boundary_attached", "the saved connection's exact app permissions boundary is attached", "permissionsBoundaryArn", (v) => v === expectedBoundary)
        : { id: "boundary_attached", description: "the saved connection's exact app permissions boundary is attached", passed: "unknown" as const, detail: "Trusted AWS connection context is unavailable." },
      attrCheck(observation, "no_wildcard_access", "no Allow statement uses a wildcard action or resource", "wildcardAccess", (v) => v === false),
      attrCheck(observation, "no_managed_policies", "no managed policy is attached outside Zenith's grants", "attachedPolicyCount", (v) => v === 0),
      matchesExpectedCheck(expectedIamAttributes(node, ctx), observation),
    ];
    return verificationOf(ctx, node, observation, checks);
  },
  discover: discoverRoles,
};
