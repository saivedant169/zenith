/**
 * `Deploy01Product`: the browser half of the DEPLOY-01 live scenario (one AWS environment, one public container image on
 * ECS Fargate behind an ALB, then update and rollback). It signs in the owner and a CI-created approver for real, as the
 * PROD-MIX-03 driver does, and uses only routes and actions the web app uses. Approvals follow the release driver's
 * deploy journey (scripts/release/drivers/operated.ts `deployKind`): proposal approval, deploy.approve, plan-review approval.
 *
 * Seams: `request`, `approve`, `stepUp`, `session`, `sleep`. Unit tests inject them.
 */
import type { Page } from "@playwright/test";
import type { EnvLike } from "../../config";
import { refuse, Refusal } from "./mix-03";
import { openRealSession, stepUpWithAuthenticator, type ProductRequest, type RunnerStack, type TenantSession } from "./mix-03-driver";
import { browserRequest, nonce } from "../../../../tests/e2e/default/support.mjs";
import { approveOperation } from "../../../release/drivers/operated";

export interface Deploy01Tenant { workspaceId: string; projectId: string }
export interface Deploy01Product {
  createTenant(): Promise<Deploy01Tenant>;
  createAwsConnection(tenant: Deploy01Tenant, input: { accountId: string; region: string; observeRoleArn: string; deployRoleArn: string; stateBucket: string; bootstrapNameSuffix: string }): Promise<{ connectionId: string; externalId: string }>;
  verifyAws(tenant: Deploy01Tenant, connectionId: string): Promise<{ ok: boolean }>;
  createEnvironment(tenant: Deploy01Tenant, input: { connectionId: string; region: string; name: string }): Promise<{ environmentId: string }>;
  setManifest(tenant: Deploy01Tenant, manifest: Record<string, unknown>): Promise<void>;
  /** deploy.apply (or deploy.rollback) through every approval, until the operation is terminal. */
  deploy(tenant: Deploy01Tenant, environmentId: string, kind: "apply" | "rollback"): Promise<{ operationId: string; status: string; detail?: string }>;
  close?(): Promise<void>;
}
export interface Deploy01DriverSeams {
  request?: ProductRequest;
  approve?: (session: TenantSession, operationId: string) => Promise<void>;
  stepUp?: (page: Page, stack: RunnerStack, secret: string) => Promise<void>;
  session?: () => Promise<{ tenant: TenantSession; close: () => Promise<void> }>;
  sleep?: (ms: number) => Promise<void>;
  /** Terminal wait for one deploy, default 40 minutes (VPC, NAT, ALB and ECS on a fresh environment). */
  deployTimeoutMs?: number;
}

const TERMINAL = ["succeeded", "failed", "uncertain", "denied", "expired", "cancelled"];
/** The product's error sentence with ARNs, key=value pairs, URLs, paths and long tokens elided (as scripts/release/drivers/operated.ts). */
export function sanitizedError(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  // The product's own fixed cause code ("; cause <class>/<code>") is kept verbatim; only its exact safe shape passes.
  const cause = /; cause ([A-Za-z0-9_.:-]{1,64}(?:\/[A-Za-z0-9_.:-]{1,64})?)\)/.exec(raw)?.[1];
  return elide(cause ? raw.replace(`; cause ${cause}`, "") : raw) + (cause ? ` [cause ${cause}]` : "");
}
function elide(raw: string): string {
  return raw.replace(/\barn:\S+/g, "…arn").replace(/\b\w+=\S+/g, "…=…").replace(/[a-z]+:\/\/\S+/gi, "…url").replace(/(?:\/[^\s/]+){2,}/g, "…path")
    .replace(/[A-Za-z0-9_+/=-]{24,}/g, "…").replace(/[\u0000-\u001f]/g, " ").slice(0, 240);
}
const codeOf = (data: unknown): string | undefined => {
  const value = data as { code?: unknown; error?: { code?: unknown } } | undefined;
  const code = value?.error?.code ?? value?.code;
  return typeof code === "string" ? code : undefined;
};

export function browserDeploy01Product(env: EnvLike = process.env, seams: Deploy01DriverSeams = {}): Deploy01Product & { close(): Promise<void> } {
  const request: ProductRequest = seams.request ?? browserRequest;
  const stepUp = seams.stepUp ?? stepUpWithAuthenticator;
  const approve = seams.approve ?? ((session: TenantSession, operationId: string) => approveOperation({ stack: session.stack }, session, operationId));
  const openSession = seams.session ?? (() => openRealSession(env));
  const sleep = seams.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const deployTimeoutMs = seams.deployTimeoutMs ?? 40 * 60_000;
  const sessions = new Map<string, TenantSession>();
  const closers: (() => Promise<void>)[] = [];

  const sessionOf = (tenant: Deploy01Tenant): TenantSession => sessions.get(tenant.workspaceId) ?? refuse("no signed-in session exists for this tenant");
  const send = async (session: TenantSession, page: Page, endpoint: string, body?: unknown, method?: string) => {
    const call = () => request(page, endpoint, body, method, session.workspaceId);
    const first = await call();
    if (!(first.status === 403 && codeOf(first.data) === "mfa_required")) return first;
    await stepUp(page, session.stack, page === session.approver ? session.approverSecret : session.ownerSecret);
    return call();
  };
  const runAction = async (session: TenantSession, page: Page, id: string, input: Record<string, unknown>, scope: Record<string, unknown> = {}) => {
    const response = await send(session, page, `/api/actions/${id}`, { mode: "execute", input, scope, idempotencyKey: nonce() });
    if (response.status < 200 || response.status >= 300) refuse(`${id} was refused by the product (HTTP ${response.status})`);
    const body = response.data as { result?: { ok?: unknown; data?: unknown } } | undefined;
    return { ok: body?.result?.ok === true, data: (body?.result?.data ?? {}) as Record<string, unknown> };
  };
  const operation = async (session: TenantSession, id: string) => {
    const response = await send(session, session.owner, `/api/platform/v1/operations/${id}`, undefined, "GET");
    const op = (response.data as { operation?: { status?: unknown; approvalRound?: unknown; error?: unknown } } | undefined)?.operation;
    return { status: typeof op?.status === "string" ? op.status : "unknown", round: typeof op?.approvalRound === "number" ? op.approvalRound : 0, error: op?.error };
  };
  const waitFor = async (session: TenantSession, id: string, done: (op: { status: string; round: number; error?: unknown }) => boolean, timeoutMs: number, what: string) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const op = await operation(session, id);
      if (done(op)) return op;
      if (Date.now() >= deadline) refuse(`${what} did not happen within the bound (operation ${op.status})`);
      await sleep(10_000);
    }
  };
  const step = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
    try { return await work(); }
    catch (error) {
      if (error instanceof Refusal) throw error;
      // Only the product's journey codes, or the error's class name (never its message), pass through.
      const name = error instanceof Error && /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : "Error";
      const code = error instanceof Error && /^journey:[a-z0-9-]{1,60}$/.test(error.message) ? error.message.slice("journey:".length) : `unexpected ${name}`;
      return refuse(`${name} refused by the product path (${code})`);
    }
  };

  return {
    async createTenant() {
      return step("tenant setup", async () => {
        const opened = await openSession();
        closers.push(opened.close);
        sessions.set(opened.tenant.workspaceId, opened.tenant);
        return { workspaceId: opened.tenant.workspaceId, projectId: opened.tenant.projectId };
      });
    },
    async createAwsConnection(tenant, input) {
      return step("connection", async () => {
        const session = sessionOf(tenant);
        const result = await runAction(session, session.owner, "connection.createAws", {
          label: "DEPLOY-01 live", region: input.region, accountId: input.accountId, observeRoleArn: input.observeRoleArn,
          deployRoleArn: input.deployRoleArn, stateBucket: input.stateBucket, bootstrapNameSuffix: input.bootstrapNameSuffix, mode: "aws_assume_role",
        });
        if (!result.ok || typeof result.data.connectionId !== "string" || typeof result.data.externalId !== "string") refuse("connection.createAws was refused by the product");
        return { connectionId: result.data.connectionId as string, externalId: result.data.externalId as string };
      });
    },
    async verifyAws(tenant, connectionId) {
      return step("connection verification", async () => {
        const session = sessionOf(tenant);
        return { ok: (await runAction(session, session.owner, "connection.verifyAws", { connectionId })).ok };
      });
    },
    async createEnvironment(tenant, input) {
      return step("environment", async () => {
        const session = sessionOf(tenant);
        const result = await runAction(session, session.owner, "env.create", {
          projectId: tenant.projectId, name: input.name, class: "production", connectionId: input.connectionId, region: input.region, approvalRequired: true,
        }, { projectId: tenant.projectId });
        if (!result.ok || typeof result.data.environmentId !== "string") refuse("env.create was refused by the product");
        return { environmentId: result.data.environmentId as string };
      });
    },
    async setManifest(tenant, manifest) {
      return step("manifest", async () => {
        const session = sessionOf(tenant);
        const result = await runAction(session, session.owner, "project.updateManifest", { projectId: tenant.projectId, manifest }, { projectId: tenant.projectId });
        if (!result.ok) refuse("project.updateManifest was refused by the product");
      });
    },
    async deploy(tenant, environmentId, kind) {
      return step(kind === "apply" ? "deploy" : "rollback", async () => {
        const session = sessionOf(tenant);
        const scope = { projectId: tenant.projectId, environmentId };
        const started = await runAction(session, session.owner, kind === "apply" ? "deploy.apply" : "deploy.rollback", { environmentId }, scope);
        const operationId = started.data.operationId, deploymentId = started.data.deploymentId;
        if (!started.ok || typeof operationId !== "string" || typeof deploymentId !== "string") refuse(`deploy.${kind} did not propose a workflow operation`);
        await approve(session, operationId as string);
        const approved = await runAction(session, session.approver, "deploy.approve", { deploymentId }, scope);
        if (!approved.ok) refuse("deploy.approve was refused by the product");
        const reviewed = await waitFor(session, operationId as string, op => TERMINAL.includes(op.status) || (op.status === "awaiting_approval" && op.round > 0), 15 * 60_000, "the plan review");
        if (!TERMINAL.includes(reviewed.status)) await approve(session, operationId as string);
        const terminal = await waitFor(session, operationId as string, op => TERMINAL.includes(op.status), deployTimeoutMs, "the deployment");
        const detail = terminal.status === "succeeded" ? undefined : sanitizedError(terminal.error);
        return { operationId: operationId as string, status: terminal.status, ...(detail ? { detail } : {}) };
      });
    },
    async close() {
      for (const release of closers.splice(0)) await release();
    },
  };
}
