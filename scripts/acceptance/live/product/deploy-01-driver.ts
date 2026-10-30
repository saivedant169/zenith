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
import { refuse, Refusal, sanitizedError } from "./mix-03";
export { sanitizedError };
import { openRealSession, stepUpWithAuthenticator, type ProductRequest, type RunnerStack, type TenantSession } from "./mix-03-driver";
import { browserRequest, nonce } from "../../../../tests/e2e/default/support.mjs";
import { approveOperation } from "../../../release/drivers/operated";

export interface Deploy01Tenant { workspaceId: string; projectId: string }
export interface Deploy01Product {
  createTenant(): Promise<Deploy01Tenant>;
  createAwsConnection(tenant: Deploy01Tenant, input: { accountId: string; region: string; observeRoleArn: string; deployRoleArn: string; stateBucket: string; bootstrapNameSuffix: string; secretWriterRoleArn?: string }): Promise<{ connectionId: string; externalId: string }>;
  verifyAws(tenant: Deploy01Tenant, connectionId: string): Promise<{ ok: boolean; why?: string }>;
  createEnvironment(tenant: Deploy01Tenant, input: { connectionId: string; region: string; name: string }): Promise<{ environmentId: string }>;
  setManifest(tenant: Deploy01Tenant, manifest: Record<string, unknown>): Promise<void>;
  /** OPS-06: system.setSecret on one service env key. The value goes only into the request body (field secretValue). */
  setSecret?(tenant: Deploy01Tenant, input: { serviceId: string; key: string; secretValue: string }): Promise<void>;
  /** deploy.apply (or deploy.rollback) through every approval, until the operation is terminal. */
  deploy(tenant: Deploy01Tenant, environmentId: string, kind: "apply" | "rollback"): Promise<{ operationId: string; status: string; detail?: string }>;
  /** TEARDOWN-01: the refusal the teardown review's plan shows now, if any (env.reviewTeardown in plan mode, as the web app asks). */
  teardownBlocked?(tenant: Deploy01Tenant, environmentId: string): Promise<string | undefined>;
  /** TEARDOWN-01: env.reviewTeardown, then every approval round of the destroy proposal it opens, until the destroy is terminal. */
  teardown?(tenant: Deploy01Tenant, environmentId: string): Promise<{ operationId: string; status: string; detail?: string }>;
  /** OPS-04: deploy.apply and its proposal approvals only, so the operation waits approved for the worker. */
  proposeDeploy?(tenant: Deploy01Tenant, environmentId: string): Promise<{ operationId: string; deploymentId: string }>;
  /** OPS-04: approve the proposal (which starts the workflow), then every round it asks for until it is terminal (the second half of deploy). */
  finishDeploy?(tenant: Deploy01Tenant, environmentId: string, operationId: string, deploymentId: string): Promise<{ operationId: string; status: string; detail?: string }>;
  /** OPS-03: approve the proposal (which starts the workflow), then wait until it asks for its plan review; the workflow stays in flight. */
  reviewDeploy?(tenant: Deploy01Tenant, environmentId: string, operationId: string, deploymentId: string): Promise<{ round: number }>;
  /** OPS-03: approve the plan review it waits on, then every later round, until the operation is terminal. */
  completeDeploy?(tenant: Deploy01Tenant, operationId: string): Promise<{ operationId: string; status: string; detail?: string }>;
  /**
   * OPS-02: `count` concurrent GETs of `/api/platform/v1/operations?limit=1` as the tenant's owner, `concurrency` at a time,
   * from the signed-in browser page. Status codes are counted; durations are milliseconds per request.
   */
  burst?(tenant: Deploy01Tenant, count: number, concurrency: number): Promise<{ statuses: Record<string, number>; durationsMs: number[] }>;
  /** OPS-04: the operation's status, approval round and recovery epoch as the API reports them. */
  operationStatus?(tenant: Deploy01Tenant, operationId: string): Promise<{ status: string; round: number }>;
  /** OPS-04: pending recovery items (GET /api/platform/v1/recovery?state=pending) and one decision. */
  recoveryItems?(tenant: Deploy01Tenant): Promise<{ epoch: number | null; items: { id: string; kind: string; ref: string; allowed: string[]; bindingDigest: string }[] }>;
  decideRecovery?(tenant: Deploy01Tenant, itemId: string, input: { decision: string; bindingDigest: string; reason: string }): Promise<{ status: number; state?: string; why?: string }>;
  /** OPS-04: one approval attempt; a product refusal is returned (its fixed message), never thrown. */
  tryApprove?(tenant: Deploy01Tenant, operationId: string): Promise<{ ok: boolean; refusal?: string }>;
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
  /** The failed infrastructure checks of an operation as `address:checkId` (default: the product store, when configured). */
  failedChecks?: (workspaceId: string, operationId: string) => Promise<string[]>;
  /** The teardown review's Temporal workflow state, for a review that never proposed (default: the stack's own Temporal). */
  reviewWorkflow?: (reviewOperationId: string) => Promise<string>;
}

/** Status, pending attempt and last failure of the review workflow; fixed words and sanitized messages only. */
export async function reviewWorkflowState(reviewOperationId: string): Promise<string> {
  try {
    const { workflowClient } = await import("@/lib/workflows/client");
    const handle = (await workflowClient()).workflow.getHandle(`teardown-review-${reviewOperationId}`);
    const described = await handle.describe();
    const pending = described.raw.pendingActivities?.[0];
    let failure = pending?.lastFailure?.message ?? undefined;
    if (!failure && described.status.name !== "RUNNING" && described.status.name !== "COMPLETED") {
      for (const event of (await handle.fetchHistory()).events ?? []) {
        const f = event.activityTaskFailedEventAttributes?.failure ?? event.activityTaskTimedOutEventAttributes?.failure ?? event.workflowExecutionFailedEventAttributes?.failure;
        if (f?.message) failure = f.cause?.message ? `${f.message}: ${f.cause.message}` : f.message;
      }
    }
    const why = sanitizedError(failure ?? undefined);
    return `workflow ${described.status.name.toLowerCase()}${pending ? `, activity attempt ${pending.attempt ?? 0}` : ""}${why ? `: ${why}` : ""}`;
  } catch (error) {
    const name = error instanceof Error && /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : "Error";
    return name === "WorkflowNotFoundError" ? "workflow not found" : `workflow unreadable (${name})`;
  }
}

const TERMINAL = ["succeeded", "failed", "uncertain", "denied", "expired", "cancelled", "rejected"];
const CHECK_REF = /^[a-z_]{1,40}\/[A-Za-z0-9_.-]{1,80}:[a-z0-9_]{1,60}$/;
/** Failed check references from the operation's verification evidence: node addresses and fixed check ids only. */
export function failedCheckRefs(summary: unknown): string[] {
  const nodes = (summary as { nodes?: unknown })?.nodes;
  const refs: string[] = [];
  for (const node of Array.isArray(nodes) ? nodes : []) {
    const { address, failed } = (node ?? {}) as { address?: unknown; failed?: unknown };
    for (const id of Array.isArray(failed) ? failed : []) {
      const ref = `${String(address)}:${String(id)}`;
      if (CHECK_REF.test(ref)) refs.push(ref);
    }
  }
  return refs.slice(0, 8);
}
async function storeFailedChecks(env: EnvLike, workspaceId: string, operationId: string): Promise<string[]> {
  const url = env.ZENITH_LIVE_PRODUCT_DATABASE_URL?.trim();
  if (!url) return [];
  const { openPlatformDb } = await import("@/lib/controlplane/db");
  const db = await openPlatformDb({ kind: "postgres", url, max: 1, migrate: false });
  try {
    const rows = await db.query<{ summary: unknown }>("select summary from platform.evidence where workspace_id = $1 and operation_id = $2 and kind = 'verification' order by created_at desc limit 1", [workspaceId, operationId]);
    return failedCheckRefs(rows[0]?.summary);
  } finally { await db.close(); }
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
  const failedChecks = seams.failedChecks ?? ((ws: string, op: string) => storeFailedChecks(env, ws, op));
  // Diagnostics never hold the refusal: an unreachable Temporal answers "unreadable" within 30 seconds.
  const reviewWorkflow = seams.reviewWorkflow ?? ((id: string) => Promise.race([reviewWorkflowState(id),
    new Promise<string>(resolve => setTimeout(() => resolve("workflow unreadable (timeout)"), 30_000).unref())]));
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
    if (response.status < 200 || response.status >= 300) {
      const code = codeOf(response.data);
      refuse(`${id} was refused by the product (HTTP ${response.status}${code && /^[a-z_]{1,40}$/.test(code) ? `, ${code}` : ""})`);
    }
    const body = response.data as { result?: { ok?: unknown; data?: unknown; error?: unknown } } | undefined;
    // The product's own refusal reason, sanitized, for a refusal message ("" when it gave none).
    const why = sanitizedError(body?.result?.error);
    return { ok: body?.result?.ok === true, data: (body?.result?.data ?? {}) as Record<string, unknown>, why: why ? ` (${why})` : "" };
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
  const proposeOnly = async (session: TenantSession, tenant: Deploy01Tenant, environmentId: string, kind: "apply" | "rollback") => {
    const scope = { projectId: tenant.projectId, environmentId };
    const started = await runAction(session, session.owner, kind === "apply" ? "deploy.apply" : "deploy.rollback", { environmentId }, scope);
    const operationId = started.data.operationId, deploymentId = started.data.deploymentId;
    if (!started.ok || typeof operationId !== "string" || typeof deploymentId !== "string") refuse(`deploy.${kind} did not propose a workflow operation`);
    return { operationId: operationId as string, deploymentId: deploymentId as string };
  };
  const propose = async (session: TenantSession, tenant: Deploy01Tenant, environmentId: string, kind: "apply" | "rollback") => {
    const proposed = await proposeOnly(session, tenant, environmentId, kind);
    await approveProposal(session, tenant, environmentId, proposed.operationId, proposed.deploymentId);
    return { operationId: proposed.operationId };
  };
  // The owner's browser approval, then the second admin's deploy.approve, which starts the workflow.
  const approveProposal = async (session: TenantSession, tenant: Deploy01Tenant, environmentId: string, operationId: string, deploymentId: string) => {
    const scope = { projectId: tenant.projectId, environmentId };
    await approve(session, operationId);
    // A 409 right after the proposal approval is the operation still changing state; retry it for up to a minute.
    let approved: Awaited<ReturnType<typeof runAction>> | undefined;
    for (let attempt = 1; !approved; attempt++) {
      try { approved = await runAction(session, session.approver, "deploy.approve", { deploymentId }, scope); }
      catch (error) {
        if (!(error instanceof Refusal && /\(HTTP 409\b/.test(error.message)) || attempt >= 6) throw error;
        await sleep(10_000);
      }
    }
    if (!approved.ok) refuse(`deploy.approve was refused by the product${approved.why}`);
  };
  const finish = async (session: TenantSession, operationId: string, approvedRound = 0) => {
    // Approve every round the operation asks for after the one already approved (the plan review), then wait.
    // Each round is approved once: a round seen again (the approval still settling) is never approved twice.
    for (let rounds = 0; rounds < 3; rounds++) {
      const view = await waitFor(session, operationId, op => TERMINAL.includes(op.status) || (op.status === "awaiting_approval" && op.round > approvedRound), rounds === 0 ? 15 * 60_000 : deployTimeoutMs, rounds === 0 ? "the plan review" : "the deployment");
      if (TERMINAL.includes(view.status)) break;
      await approve(session, operationId);
      approvedRound = view.round;
    }
    const terminal = await waitFor(session, operationId, op => TERMINAL.includes(op.status), deployTimeoutMs, "the deployment");
    let detail = terminal.status === "succeeded" ? undefined : sanitizedError(terminal.error);
    if (detail?.startsWith("Infrastructure verification failed")) {
      const refs = await failedChecks(session.workspaceId, operationId).catch(() => []);
      if (refs.length) detail += ` [failed checks: ${refs.join(", ")}]`;
    }
    return { operationId, status: terminal.status, ...(detail ? { detail } : {}) };
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
          ...(input.secretWriterRoleArn ? { secretWriterRoleArn: input.secretWriterRoleArn } : {}),
        });
        if (!result.ok || typeof result.data.connectionId !== "string" || typeof result.data.externalId !== "string") refuse(`connection.createAws was refused by the product${result.why}`);
        return { connectionId: result.data.connectionId as string, externalId: result.data.externalId as string };
      });
    },
    async verifyAws(tenant, connectionId) {
      return step("connection verification", async () => {
        const session = sessionOf(tenant);
        const result = await runAction(session, session.owner, "connection.verifyAws", { connectionId });
        return { ok: result.ok, ...(result.ok ? {} : { why: result.why }) };
      });
    },
    async createEnvironment(tenant, input) {
      return step("environment", async () => {
        const session = sessionOf(tenant);
        const result = await runAction(session, session.owner, "env.create", {
          projectId: tenant.projectId, name: input.name, class: "production", connectionId: input.connectionId, region: input.region, approvalRequired: true,
        }, { projectId: tenant.projectId });
        if (!result.ok || typeof result.data.environmentId !== "string") refuse(`env.create was refused by the product${result.why}`);
        return { environmentId: result.data.environmentId as string };
      });
    },
    async setManifest(tenant, manifest) {
      return step("manifest", async () => {
        const session = sessionOf(tenant);
        const result = await runAction(session, session.owner, "project.updateManifest", { projectId: tenant.projectId, manifest }, { projectId: tenant.projectId });
        if (!result.ok) refuse(`project.updateManifest was refused by the product${result.why}`);
      });
    },
    async setSecret(tenant, input) {
      return step("secret", async () => {
        const session = sessionOf(tenant);
        const result = await runAction(session, session.owner, "system.setSecret", { projectId: tenant.projectId, ...input }, { projectId: tenant.projectId });
        if (!result.ok) refuse(`system.setSecret was refused by the product${result.why}`);
      });
    },
    async proposeDeploy(tenant, environmentId) {
      return step("deploy proposal", async () => proposeOnly(sessionOf(tenant), tenant, environmentId, "apply"));
    },
    async finishDeploy(tenant, environmentId, operationId, deploymentId) {
      return step("deploy", async () => {
        const session = sessionOf(tenant), { round } = await operation(session, operationId);
        await approveProposal(session, tenant, environmentId, operationId, deploymentId);
        return finish(session, operationId, round);
      });
    },
    async reviewDeploy(tenant, environmentId, operationId, deploymentId) {
      return step("plan review", async () => {
        const session = sessionOf(tenant), { round } = await operation(session, operationId);
        await approveProposal(session, tenant, environmentId, operationId, deploymentId);
        const view = await waitFor(session, operationId, op => TERMINAL.includes(op.status) || (op.status === "awaiting_approval" && op.round > round), 15 * 60_000, "the plan review");
        if (TERMINAL.includes(view.status)) refuse(`the deploy ended ${/^[a-z_]{1,20}$/.test(view.status) ? view.status : "unknown"} before its plan review`);
        return { round: view.round };
      });
    },
    async completeDeploy(tenant, operationId) {
      return step("deploy", async () => {
        const session = sessionOf(tenant), view = await operation(session, operationId);
        if (view.status !== "awaiting_approval") refuse(`the deploy is ${/^[a-z_]{1,20}$/.test(view.status) ? view.status : "unknown"}, not waiting for its review`);
        await approve(session, operationId);
        return finish(session, operationId, view.round);
      });
    },
    async burst(tenant, count, concurrency) {
      return step("request burst", async () => {
        const session = sessionOf(tenant);
        if (!Number.isInteger(count) || count < 1 || count > 2000 || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 100) refuse("the burst size is out of range");
        return session.owner.evaluate(async ({ count, concurrency, workspaceId }) => {
          const statuses: Record<string, number> = {}, durationsMs: number[] = [];
          let next = 0;
          const one = async () => {
            for (; next < count; ) {
              next++;
              const start = performance.now();
              const status = await fetch("/api/platform/v1/operations?limit=1", { credentials: "same-origin", redirect: "error", cache: "no-store", headers: { "x-zenith-workspace": workspaceId } })
                .then(async r => { await r.arrayBuffer(); return r.status; }, () => 0);
              durationsMs.push(performance.now() - start);
              statuses[String(status)] = (statuses[String(status)] ?? 0) + 1;
            }
          };
          await Promise.all(Array.from({ length: concurrency }, one));
          return { statuses, durationsMs };
        }, { count, concurrency, workspaceId: session.workspaceId });
      });
    },
    async operationStatus(tenant, operationId) {
      return step("operation readback", async () => { const op = await operation(sessionOf(tenant), operationId); return { status: op.status, round: op.round }; });
    },
    async recoveryItems(tenant) {
      return step("recovery items", async () => {
        const session = sessionOf(tenant);
        const response = await send(session, session.owner, "/api/platform/v1/recovery?state=pending", undefined, "GET");
        if (response.status !== 200) refuse(`the recovery list was refused by the product (HTTP ${response.status})`);
        const body = response.data as { status?: { epoch?: unknown }; items?: unknown[] } | undefined;
        const items = (Array.isArray(body?.items) ? body!.items : []).map(raw => {
          const i = raw as { id?: unknown; kind?: unknown; ref?: unknown; allowed?: unknown; bindingDigest?: unknown };
          return { id: String(i.id ?? ""), kind: String(i.kind ?? ""), ref: String(i.ref ?? ""), allowed: Array.isArray(i.allowed) ? i.allowed.map(String) : [], bindingDigest: String(i.bindingDigest ?? "") };
        });
        return { epoch: typeof body?.status?.epoch === "number" ? body.status.epoch : null, items };
      });
    },
    async decideRecovery(tenant, itemId, input) {
      return step("recovery decision", async () => {
        const session = sessionOf(tenant);
        if (!/^[A-Za-z0-9_-]{1,200}$/.test(itemId)) refuse("the recovery item id has an unexpected shape");
        const response = await send(session, session.owner, `/api/platform/v1/recovery/items/${itemId}/decide`, input, "POST");
        const state = (response.data as { item?: { state?: unknown } } | undefined)?.item?.state;
        // A refusal names its fixed code and the product's sanitized sentence.
        const code = codeOf(response.data), message = sanitizedError((response.data as { error?: { message?: unknown } } | undefined)?.error?.message);
        const why = [code && /^[a-z_]{1,40}$/.test(code) ? code : undefined, message].filter(Boolean).join(": ");
        return { status: response.status, ...(typeof state === "string" ? { state } : {}), ...(why ? { why } : {}) };
      });
    },
    async tryApprove(tenant, operationId) {
      const session = sessionOf(tenant);
      try { await approve(session, operationId); return { ok: true }; }
      catch (error) { return { ok: false, refusal: error instanceof Error ? sanitizedError(error.message) ?? "refused" : "refused" }; }
    },
    async deploy(tenant, environmentId, kind) {
      return step(kind === "apply" ? "deploy" : "rollback", async () => {
        const session = sessionOf(tenant);
        return finish(session, (await propose(session, tenant, environmentId, kind)).operationId);
      });
    },
    async teardownBlocked(tenant, environmentId) {
      return step("teardown readiness", async () => {
        const session = sessionOf(tenant);
        const response = await send(session, session.owner, "/api/actions/env.reviewTeardown",
          { mode: "plan", input: { environmentId, idempotencyKey: nonce() }, scope: { projectId: tenant.projectId, environmentId } });
        if (response.status < 200 || response.status >= 300) refuse(`env.reviewTeardown plan was refused by the product (HTTP ${response.status})`);
        const plan = (response.data as { plan?: unknown } | undefined)?.plan;
        // Only a plan object without a refusal means the review may start; anything else is not a readable answer.
        if (!plan || typeof plan !== "object") refuse("env.reviewTeardown plan returned no plan");
        const blocked = (plan as { blocked?: unknown }).blocked;
        if (blocked !== undefined && typeof blocked !== "string") refuse("env.reviewTeardown plan returned an unreadable refusal");
        return sanitizedError(blocked) ?? (blocked === undefined ? undefined : "refused");
      });
    },
    async teardown(tenant, environmentId) {
      return step("teardown", async () => {
        const session = sessionOf(tenant);
        const scope = { projectId: tenant.projectId, environmentId };
        const requested = await runAction(session, session.owner, "env.reviewTeardown", { environmentId, idempotencyKey: nonce() }, scope);
        const reviewId = requested.data.reviewOperationId;
        if (!requested.ok || typeof reviewId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(reviewId)) refuse("env.reviewTeardown did not record a review operation");
        const path = `/api/platform/v1/environments/${encodeURIComponent(environmentId)}/teardown-review?reviewId=${encodeURIComponent(reviewId as string)}`;
        let operationId: string | undefined, last = "none";
        // The product bounds the review activity at 35 minutes (destroy-review workflow scheduleToClose).
        for (const deadline = Date.now() + 36 * 60_000; !operationId;) {
          const review = ((await send(session, session.owner, path, undefined, "GET")).data as { review?: { operationId?: unknown; status?: unknown } | null } | undefined)?.review;
          if (typeof review?.status === "string" && /^[a-z_]{1,20}$/.test(review.status)) last = review.status;
          if (typeof review?.operationId === "string") operationId = review.operationId;
          else if (typeof review?.status === "string" && TERMINAL.includes(review.status)) {
            // The review route returns only the status; the review operation carries the product's reason.
            const why = sanitizedError((await operation(session, reviewId as string).catch(() => undefined))?.error);
            refuse(`the teardown review ended ${review.status} without a destroy proposal${why ? ` (product: ${why})` : ""} [${await reviewWorkflow(reviewId as string)}]`);
          }
          else if (Date.now() >= deadline) {
            const op = await operation(session, reviewId as string).catch(() => undefined), why = sanitizedError(op?.error);
            refuse(`the teardown review did not open a destroy proposal within 36 minutes (review ${last}, operation ${op && /^[a-z_]{1,20}$/.test(op.status) ? op.status : "unreadable"}${why ? `; product: ${why}` : ""}) [${await reviewWorkflow(reviewId as string)}]`);
          }
          else await sleep(10_000);
        }
        // Approve every round the destroy operation asks for (proposal, then the plan review before apply), as the web app does.
        for (let round = 0; round < 3; round++) {
          const view = await waitFor(session, operationId, op => op.status === "awaiting_approval" || TERMINAL.includes(op.status), 15 * 60_000, "the destroy approval");
          if (TERMINAL.includes(view.status)) break;
          await approve(session, operationId);
        }
        const terminal = await waitFor(session, operationId, op => TERMINAL.includes(op.status), deployTimeoutMs, "the teardown");
        return { operationId, status: terminal.status, ...(terminal.status === "succeeded" ? {} : { detail: sanitizedError(terminal.error) }) };
      });
    },
    async close() {
      for (const release of closers.splice(0)) await release();
    },
  };
}
