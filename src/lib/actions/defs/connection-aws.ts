/**
 * Keyless AWS connections: identifiers only, strict inputs, workspace-scoped
 * platform lookups. Creating trust is a customer bootstrap step; creation
 * performs no STS call and leaves both records unverified. Verification uses
 * the observe role only and does not prove deploy-role access or worker health.
 */
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { defineAction, type ActionContext, type ActionPlan } from "@/lib/actions/core";
import { requireConnection } from "./_shared";
import { db, save } from "@/lib/db/store";
import { id, type CloudConnection } from "@/lib/domain/types";
import type { AwsConnectionConfig } from "@/lib/credentials/types";
import { isAccountId, isExternalId, parseRoleArn } from "@/lib/credentials/aws/arn";
import { loadCredentialsConfig } from "@/lib/credentials/config";
import { workloadSubject } from "@/lib/credentials/oidc/issuer";
import { bridgeDeps } from "@/lib/bridge/deps";
import { findSecret } from "@/lib/capabilities/secret-guard";
import { isAwsStateKmsArn, isBootstrapNameSuffix, isSupportedAwsConnectionRegion } from "@/lib/credentials/aws/naming";
import { AwsLimitError, assertAwsBootstrapLimits } from "@/lib/credentials/aws/limits";

export const AWS_CONNECTION_PERMISSIONS = [
  "Observe role: read-only describe/list/get inventory; cannot read secret values.",
  "Deploy role: manage supported resources tagged zenith:managed=true or named zenith-*; IAM roles only with the workload permission boundary attached.",
  "Deploy role cannot modify its own roles, the observe roles, CodeBuild role or permission boundary; cannot create users/access keys or read secret values.",
  "State bucket: read/write state and build artifacts; cannot delete/reconfigure the bucket or delete object versions. DNS writes only in explicitly allowed hosted zones.",
  "Known IAM limits: ECS task-definition registration uses Resource:*; session policies only narrow bootstrap permissions. Workloads may read their own injected secrets under their boundary.",
];
const role = z.string().max(2048).refine((v) => !!parseRoleArn(v), "Use an IAM role ARN.");
const Input = z.object({
  label: z.string().trim().min(1).max(120).refine((v) => !findSecret(v), "Use a label without secret material.").optional(),
  region: z.string().refine(isSupportedAwsConnectionRegion, "Choose a supported AWS region."),
  accountId: z.string().refine(isAccountId, "Use a 12-digit AWS account id."),
  bootstrapNameSuffix: z.string().max(20).refine(isBootstrapNameSuffix, "Use an empty suffix or a dash followed by 1 to 19 lowercase letters, digits or dashes.").prefault(""),
  observeRoleArn: role, deployRoleArn: role,
  mode: z.enum(["oidc_web_identity", "aws_assume_role"]).prefault("oidc_web_identity"),
  stateBucket: z.string().min(3).max(63).regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/, "Use an S3 bucket name.").refine((v) => !v.includes("..") && !/^\d+\.\d+\.\d+\.\d+$/.test(v) && !v.startsWith("xn--") && !v.endsWith("-s3alias") && !v.endsWith("--ol-s3") && !v.endsWith(".mrap") && !v.endsWith("--x-s3") && !v.endsWith("--table-s3"), "Use a valid S3 bucket name.").optional(),
  stateKmsKeyArn: z.string().regex(/^arn:(aws|aws-cn|aws-us-gov):kms:[a-z0-9-]+:\d{12}:key\/[A-Za-z0-9-]+$/, "Use a KMS key ARN.").optional(),
  permissionsBoundaryArn: z.string().max(2048).regex(/^arn:(aws|aws-cn|aws-us-gov):iam::\d{12}:policy\/[A-Za-z0-9+=,.@_/-]+$/, "Use an IAM policy ARN.").optional(),
  codeBuildRoleArn: role.optional(),
  /** The bootstrap's SecretWriterRoleArn output: service secrets reach AWS Secrets Manager only through this distinct role. */
  secretWriterRoleArn: role.optional(),
  sessionDurationSec: z.number().int().min(900).max(3600).optional(),
}).strict().superRefine((input, ctx) => {
  if (input.secretWriterRoleArn && [input.observeRoleArn, input.deployRoleArn].includes(input.secretWriterRoleArn)) ctx.addIssue({ code: "custom", path: ["secretWriterRoleArn"], message: "Use the bootstrap's distinct secret writer role, not the observe or deploy role." });
  for (const key of ["observeRoleArn", "deployRoleArn", "codeBuildRoleArn", "secretWriterRoleArn"] as const) {
    if (input[key] && parseRoleArn(input[key])?.accountId !== input.accountId) ctx.addIssue({ code: "custom", path: [key], message: "Role account must match accountId." });
    if (input[key] && parseRoleArn(input[key])?.partition !== "aws") ctx.addIssue({ code: "custom", path: [key], message: "Choose a role in the supported commercial AWS partition." });
  }
  for (const key of ["permissionsBoundaryArn", "stateKmsKeyArn"] as const) {
    if (input[key] && input[key].split(":")[4] !== input.accountId) ctx.addIssue({ code: "custom", path: [key], message: "ARN account must match accountId." });
  }
  // Every IAM and S3 name derived from the suffix must fit; refuse at registration, not at the first deploy.
  try { assertAwsBootstrapLimits({ bootstrapNameSuffix: input.bootstrapNameSuffix, accountId: input.accountId, region: input.region }); }
  catch (error) { if (error instanceof AwsLimitError) ctx.addIssue({ code: "custom", path: ["bootstrapNameSuffix"], message: error.message }); else throw error; }
  if (input.stateKmsKeyArn !== undefined && !isAwsStateKmsArn(input.stateKmsKeyArn, input.accountId, input.region)) ctx.addIssue({ code: "custom", path: ["stateKmsKeyArn"], message: "State encryption key must match the account, commercial partition and connection region." });
});
type Input = z.input<typeof Input>;
const TEMPLATE = "deploy/aws/zenith-connection.cfn.yaml";

function bootstrapValues(ctx: ActionContext, connectionId: string) {
  const issuer = loadCredentialsConfig().oidcIssuer;
  return { subject: workloadSubject(ctx.workspaceId, connectionId), issuerHost: issuer?.replace(/^https?:\/\//, ""), template: TEMPLATE, tofuModule: "deploy/aws/tofu-module" };
}

function creationPlan(ctx: ActionContext, input: Input): ActionPlan {
  const mode = input.mode ?? "oidc_web_identity";
  let values: ReturnType<typeof bootstrapValues> | undefined;
  let blocked: string | undefined;
  try {
    values = bootstrapValues(ctx, "preview");
    values.subject = values.subject.replace(/conn:preview$/, "conn:<connection-id>");
    if (mode === "oidc_web_identity" && loadCredentialsConfig().oidcIssuer?.startsWith("http:")) blocked = "AWS must reach the issuer over public HTTPS. Set ZENITH_OIDC_ISSUER to a public HTTPS URL.";
  }
  catch { blocked = "Credential configuration is invalid. Correct ZENITH_OIDC_ISSUER and signing-key settings, then retry."; }
  if (mode === "oidc_web_identity" && !values?.issuerHost) blocked ??= "Set ZENITH_OIDC_ISSUER to the public HTTPS issuer URL, then create this connection.";
  return {
    summary: `Create a keyless AWS connection for account ${input.accountId} in ${input.region}.`,
    details: [
      ...AWS_CONNECTION_PERMISSIONS,
      `Run ${TEMPLATE} or deploy/aws/tofu-module in your AWS account; Zenith does not create this bootstrap stack.`,
      `Bootstrap NameSuffix: ${input.bootstrapNameSuffix || "empty"}. Use the same value in the bootstrap stack and this connection.`,
      `OIDC subject: ${values?.subject ?? `zenith:ws:${ctx.workspaceId}:conn:<connection-id>`}. The exact connection id and subject are shown right after creation.`,
      `Issuer host (no scheme): ${values?.issuerHost ?? "unset (ZENITH_OIDC_ISSUER)"}. AWS must reach it over public HTTPS.`,
      ...(input.mode === "aws_assume_role" ? ["Zenith generates a random ExternalId (not a secret) at creation and returns it for the template. Supply ZenithPrincipalArn for the control plane's AWS principal; never supply an access key."] : []),
      "No live verification runs at creation. The records stay connecting / pending_verification until connection.verifyAws passes an observe-role identity check; deploy-role permissions remain unverified.",
    ], costDeltaUsd: 0, risk: "medium", warnings: [], requiresApproval: false, blocked,
  };
}

defineAction<Input>({
  id: "connection.createAws", title: "Connect AWS keylessly", category: "connection", risk: "medium", requiredRole: "admin", mutates: true, input: Input,
  plan: creationPlan,
  async execute(ctx, input) {
    const plan = creationPlan(ctx, input);
    if (plan.blocked) return { ok: false, summary: "AWS connection cannot be created yet.", error: plan.blocked };
    const connectionId = id();
    const externalId = input.mode === "aws_assume_role" ? `zenith-${randomBytes(16).toString("hex")}` : undefined;
    if (externalId && !isExternalId(externalId)) throw new Error("ExternalId generation failed.");
    const { label, ...identifiers } = input;
    const config: AwsConnectionConfig = { ...identifiers, mode: input.mode ?? "oidc_web_identity", provider: "aws", ...(externalId ? { externalId } : {}) };
    try {
      const { repos } = await import("@/lib/controlplane/db");
      const sql = await bridgeDeps().connectionSql();
      await repos.connections.create(sql, { id: connectionId, legacyConnectionId: connectionId, workspaceId: ctx.workspaceId, createdBy: ctx.actor.id, config });
    } catch {
      return { ok: false, summary: "AWS connection was not created.", error: "The platform connection store refused the write. Check its configuration and schema, then retry." };
    }
    const conn: CloudConnection = { id: connectionId, workspaceId: ctx.workspaceId, provider: "aws", label: label || `AWS ${input.accountId} ${input.region}`, region: input.region, status: "connecting", grantedPermissions: [...AWS_CONNECTION_PERMISSIONS], platformConnectionId: connectionId, createdAt: new Date().toISOString() };
    db().connections.push(conn);
    save();
    return { ok: true, summary: "AWS connection saved; bootstrap trust and run connection.verifyAws before deploying.", data: { connectionId, platformConnectionId: connectionId, status: conn.status, ...bootstrapValues(ctx, connectionId), ...(externalId ? { externalId, requiredTemplateParameter: "ZenithPrincipalArn" } : {}) } };
  },
});

const Ref = z.object({ connectionId: z.string().min(1) }).strict();
defineAction<z.infer<typeof Ref>>({
  id: "connection.verifyAws", title: "Verify AWS connection", category: "connection", risk: "low", requiredRole: "editor", mutates: true, input: Ref,
  plan(ctx, input) {
    const conn = requireConnection(ctx, input.connectionId);
    return { summary: `Verify ${conn.label} using its observe role.`, details: ["Assumes the observe role with short-lived credentials and calls STS GetCallerIdentity. No infrastructure is changed; this does not verify deploy-role permissions."], costDeltaUsd: 0, risk: "low", warnings: [], requiresApproval: false, blocked: conn.provider !== "aws" || !conn.platformConnectionId ? "Use connection.createAws to create a platform-linked AWS connection first." : undefined };
  },
  async execute(ctx, input) {
    const conn = requireConnection(ctx, input.connectionId);
    if (conn.provider !== "aws" || !conn.platformConnectionId) return { ok: false, summary: "Verification refused.", error: "Use connection.createAws to create a platform-linked AWS connection first." };
    try {
      const { repos } = await import("@/lib/controlplane/db");
      const deps = bridgeDeps();
      const sql = await deps.connectionSql();
      const resolve = (id: string) => repos.connections.get(sql, ctx.workspaceId, id);
      const platform = await resolve(conn.platformConnectionId);
      if (!platform || platform.status === "revoked" || platform.config.provider !== "aws") return { ok: false, summary: "Verification refused.", error: "A usable platform AWS connection was not found. Create a new connection." };
      const broker = await deps.credentialBroker(resolve);
      const result = await broker.verifyConnection(conn.platformConnectionId, { workspaceId: ctx.workspaceId });
      const recorded = await repos.connections.recordVerification(sql, { workspaceId: ctx.workspaceId, id: conn.platformConnectionId, ok: result.ok, detail: result.detail });
      if (!recorded) return { ok: false, summary: "Verification was not saved.", error: "The platform connection was revoked during verification; create a new connection." };
      conn.status = result.ok ? "healthy" : "disconnected";
      conn.lastCheckedAt = new Date().toISOString();
      save();
      return { ok: result.ok, summary: result.ok ? "Observe-role identity verified; deploy-role permissions remain unverified." : "AWS verification failed.", error: result.ok ? undefined : result.detail, data: { connectionId: conn.id, status: conn.status, platformStatus: recorded.status, detail: result.detail } };
    } catch {
      return { ok: false, summary: "AWS verification could not be completed.", error: "Restore the platform store and credential broker, then run connection.verifyAws again." };
    }
  },
});
