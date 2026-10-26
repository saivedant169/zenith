/**
 * `Mix03Product` for the PROD-MIX-03 live scenario: the browser half of the product path, on the Zenith stack the workflow
 * started on this runner (ZENITH_DEFAULT_STACK_DIRECTORY and ZENITH_DEFAULT_MAILPIT_URL, exported by default-stack/env.mjs).
 *
 * It drives the product the way scripts/release/drivers/operated.ts does: the owner and a CI-created approver sign in for
 * real, enrol a TOTP authenticator, step up with it when a privileged route answers `mfa_required`, and the approver approves
 * in the browser. Every product call is a route or action the web app uses. The only non-product call is the test user
 * provisioning that operated.ts also does (the stack's Auth admin API creates two disposable users).
 *
 * Methods without a product route this driver can complete refuse before sending anything: proposeMixed,
 * issueOutputPreauthorization, useOutputOnce and changeProducer. The port then restores trust and cleans up.
 * Evidence names the approver as the automated test approver; no credential, token or recovery link is returned.
 *
 * Seams: `request` (same-origin fetch in the page), `approve`, `stepUp` and `session`. Unit tests inject all four.
 */
import path from "node:path";
import type { Browser, Page } from "@playwright/test";
import type { EnvLike } from "../../config";
import { refuse, Refusal, type Mix03Child, type Mix03Product, type Mix03Tenant } from "./mix-03";
import { readState } from "../../default-stack/runtime.mjs";
import { browserRequest, ensure, localUrl, nonce, ok, operator, privateFile, until, action } from "../../../../tests/e2e/default/support.mjs";
import { enrollOperator, totp } from "../../../../tests/e2e/default/mfa.mjs";
import { approveOperation, authenticateBeforeWorkspace, requireTwoPersonProduction } from "../../../release/drivers/operated";

export interface RunnerStack { apiUrl: string; supabaseUrl: string; adminKey: string; mailpitUrl: string }
/** One tenant's signed-in pages and the TOTP keys enrolled for them. Held in memory only; never returned or logged. */
export interface TenantSession {
  stack: RunnerStack; owner: Page; approver: Page; workspaceId: string; ownerId: string; approverId: string;
  ownerSecret: string; approverSecret: string; projectId: string;
}
export type ProductRequest = (page: Page, endpoint: string, body?: unknown, method?: string, workspaceId?: string) => Promise<{ status: number; data: unknown }>;
export interface Mix03DriverSeams {
  request?: ProductRequest;
  approve?: (session: TenantSession, operationId: string) => Promise<void>;
  stepUp?: (page: Page, stack: RunnerStack, secret: string) => Promise<void>;
  /** A signed-in tenant and how to release it. Default: a headless browser run of the real sign-in and enrolment flow. */
  session?: () => Promise<{ tenant: TenantSession; close: () => Promise<void> }>;
}

/** The runner's stack, from the variables the workflow exported. Refuses unless the lean profile is the one running. */
export function runnerStack(env: EnvLike): RunnerStack {
  const directory = env.ZENITH_DEFAULT_STACK_DIRECTORY?.trim(), mailpit = env.ZENITH_DEFAULT_MAILPIT_URL?.trim();
  if (!directory || !mailpit) refuse("the runner stack is not exported (ZENITH_DEFAULT_STACK_DIRECTORY and ZENITH_DEFAULT_MAILPIT_URL are required)");
  if ((readState(directory) as { profile?: unknown }).profile !== "lean") refuse("the runner stack is not the lean profile");
  const input = JSON.parse(privateFile(path.join(directory, "input.json"))) as { environment?: Record<string, string> };
  const environment = input.environment ?? {};
  if (typeof environment.SUPABASE_SERVICE_ROLE_KEY !== "string") refuse("the runner stack has no Auth admin key for test user provisioning");
  return {
    apiUrl: localUrl(environment.NEXT_PUBLIC_SITE_URL ?? ""), supabaseUrl: localUrl(environment.SUPABASE_URL ?? "", true),
    adminKey: environment.SUPABASE_SERVICE_ROLE_KEY, mailpitUrl: localUrl(mailpit),
  };
}

/** Real sign-in, workspace, two-person policy, approver invitation and TOTP enrolment for both people, as operated.ts does. */
export async function openRealSession(env: EnvLike): Promise<{ tenant: TenantSession; close: () => Promise<void> }> {
  const stack = runnerStack(env);
  const { chromium } = await import("@playwright/test");
  const browser: Browser = await chromium.launch({ headless: true });
  const close = async () => { await browser.close(); };
  try {
    const users: string[] = [];
    const owner = await (await browser.newContext()).newPage(), approver = await (await browser.newContext()).newPage();
    const a = await operator(stack, stack.mailpitUrl, "mix03-owner", users);
    const b = await operator(stack, stack.mailpitUrl, "mix03-approver", users);
    await authenticateBeforeWorkspace(owner, stack, a);
    const name = `PROD-MIX-03 ${nonce().slice(0, 8)}`;
    const workspace = ok(await browserRequest(owner, "/api/workspace", { name })).workspace;
    ok(await browserRequest(owner, "/api/bootstrap"));
    const ownerSecret = await enrollOperator(owner, stack);
    await requireTwoPersonProduction(owner, workspace.id);
    const invite = ok(await browserRequest(owner, "/api/workspace/invites", { workspaceId: workspace.id, email: b.email, role: "admin" })).invite;
    await authenticateBeforeWorkspace(approver, stack, b);
    const approverSecret = await enrollOperator(approver, stack);
    const accepted = ok(await browserRequest(approver, "/api/workspace/invites/" + invite.id + "/accept", {}));
    ok(await browserRequest(approver, "/api/bootstrap"));
    ensure(accepted.member?.id === b.id && accepted.member?.role === "admin", "approver-member");
    const created = await action(owner, "project.create", { name, withEnvironment: false });
    return {
      tenant: { stack, owner, approver, workspaceId: workspace.id, ownerId: a.id, approverId: b.id, ownerSecret, approverSecret, projectId: created.projectId },
      close,
    };
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
}

/** Fills the authenticator code on the product's challenge page and waits for the server-side proof, as operated.ts does for enrolment. */
export async function stepUpWithAuthenticator(page: Page, stack: RunnerStack, secret: string): Promise<void> {
  await page.goto(stack.apiUrl + "/account/mfa/challenge?next=/overview");
  const code = page.getByLabel("Six-digit authenticator code", { exact: true });
  await code.waitFor();
  // Avoid submitting a code at the end of its period, without changing Auth's clock.
  if (Date.now() % 30000 > 27000) await page.waitForTimeout(3100);
  await code.fill(totp(secret));
  await page.getByRole("button", { name: "Verify authenticator", exact: true }).click();
  await until(() => page.evaluate(async () => {
    const response = await fetch("/api/auth/mfa/verify", { credentials: "same-origin" });
    return response.ok && (await response.json()).verified === true;
  }), (verified: unknown) => verified === true, 30_000);
}

const codeOf = (data: unknown): string | undefined => {
  const value = data as { code?: unknown; error?: { code?: unknown } } | undefined;
  const code = value?.error?.code ?? value?.code;
  return typeof code === "string" ? code : undefined;
};
const CHILD_STATUS: Record<string, string> = { pending: "pending", adopted: "pending", started: "running", succeeded: "succeeded", failed: "failed", uncertain: "uncertain", cancelled: "cancelled", blocked: "blocked" };

/** The product's PROD-MIX-03 driver. Create it once per run; `close()` releases the browser after teardown. */
export function browserMix03Product(env: EnvLike = process.env, seams: Mix03DriverSeams = {}): Mix03Product & { close(): Promise<void> } {
  const request: ProductRequest = seams.request ?? browserRequest;
  const stepUp = seams.stepUp ?? stepUpWithAuthenticator;
  const approve = seams.approve ?? ((session: TenantSession, operationId: string) => approveOperation({ stack: session.stack }, session, operationId));
  const openSession = seams.session ?? (() => openRealSession(env));
  const sessions = new Map<string, TenantSession>();
  const closers: (() => Promise<void>)[] = [];

  const sessionOf = (tenant: Mix03Tenant): TenantSession => sessions.get(tenant.workspaceId) ?? refuse("no signed-in session exists for this tenant");
  /** One request. A privileged route that answers `mfa_required` gets one TOTP step-up with that person's enrolled key, then one retry. */
  const send = async (session: TenantSession, page: Page, endpoint: string, body?: unknown, method?: string) => {
    const call = () => request(page, endpoint, body, method, session.workspaceId);
    const first = await call();
    if (!(first.status === 403 && codeOf(first.data) === "mfa_required")) return first;
    await stepUp(page, session.stack, page === session.approver ? session.approverSecret : session.ownerSecret);
    return call();
  };
  /** A product action: `{ ok, data }` from the action's own result. A refused action is `ok: false`, never a thrown error. */
  const runAction = async (session: TenantSession, id: string, input: Record<string, unknown>): Promise<{ ok: boolean; data?: unknown }> => {
    const response = await send(session, session.owner, `/api/actions/${id}`, { mode: "execute", input, scope: {}, idempotencyKey: nonce() });
    ensure(response.status >= 200 && response.status < 300, "http-refused");
    const body = response.data as { result?: { ok?: unknown; data?: unknown } } | undefined;
    return { ok: body?.result?.ok === true, data: body?.result?.data };
  };
  /** Maps any failure to a fixed, short reason. Product messages and data are withheld; only the product's own journey codes pass through. */
  const step = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
    try { return await work(); }
    catch (error) {
      if (error instanceof Refusal) throw error;
      const code = error instanceof Error && /^journey:[a-z0-9-]{1,60}$/.test(error.message) ? error.message.slice("journey:".length) : "unexpected";
      return refuse(`${name} refused by the product path (${code})`);
    }
  };

  return {
    async createTenant() {
      return step("tenant setup", async () => {
        const opened = await openSession();
        closers.push(opened.close);
        sessions.set(opened.tenant.workspaceId, opened.tenant);
        return { workspaceId: opened.tenant.workspaceId, approverId: opened.tenant.approverId };
      });
    },

    async createAwsConnection(tenant, input) {
      return step("connection", async () => {
        const session = sessionOf(tenant);
        const result = await runAction(session, "connection.createAws", {
          label: "PROD-MIX-03 live", region: input.region, accountId: input.accountId,
          observeRoleArn: input.observeRoleArn, deployRoleArn: input.deployRoleArn, mode: "aws_assume_role",
        });
        const data = (result.data ?? {}) as { connectionId?: unknown; externalId?: unknown };
        if (!result.ok || typeof data.connectionId !== "string" || typeof data.externalId !== "string") refuse("connection.createAws was refused by the product");
        return { connectionId: data.connectionId as string, externalId: data.externalId as string };
      });
    },

    async verifyAws(tenant, connectionId) {
      return step("connection verification", async () => {
        const result = await runAction(sessionOf(tenant), "connection.verifyAws", { connectionId });
        return result.ok ? { ok: true, reason: "" } : { ok: false, reason: "connection.verifyAws did not pass" };
      });
    },

    async proposeMixed() {
      // planMixed (src/lib/execution/mixed/service.ts) refuses any partition dependency, including a declared reference across two
      // partitions, unless protected connectivity is declared. This scenario declares none, and its endpoints and pins are not
      // the caller's to invent. No request is sent.
      return refuse("planMixed refuses the producer-to-consumer reference without declared protected connectivity, and the scenario declares none");
    },

    async approve(tenant, operationId) {
      return step("browser approval", async () => { await approve(sessionOf(tenant), operationId); });
    },

    async startMixed(tenant, planId) {
      return step("mixed start", async () => {
        const session = sessionOf(tenant);
        const response = await send(session, session.owner, `/api/platform/v1/mixed/plans/${planId}/start`, {}, "POST");
        if (response.status >= 200 && response.status < 300) return { started: true as const };
        const code = codeOf(response.data);
        return { started: false as const, reason: `the product refused the start (${code && /^[a-z_]{1,40}$/.test(code) ? code.replace(/_/g, " ") : "no code"})` };
      });
    },

    async children(tenant, planId) {
      return step("children readback", async () => {
        const session = sessionOf(tenant);
        const plan = ok(await send(session, session.owner, `/api/platform/v1/mixed/plans/${planId}`, undefined, "GET")) as { children?: unknown };
        const rows = (Array.isArray(plan.children) ? plan.children : []) as {
          dependsOn?: unknown[]; state?: string; childOperationId?: string | null; receipt?: { childOperationId?: string } | null;
        }[];
        const children: Mix03Child[] = [];
        for (const row of rows) {
          // The producer is the child nothing depends on; the consumer depends on it.
          const role = row.dependsOn?.length ? "consumer" : "producer";
          let awaitingOperationId: string | undefined;
          if (row.childOperationId && (row.state === "adopted" || row.state === "started")) {
            const detail = ok(await send(session, session.owner, `/api/platform/v1/operations/${row.childOperationId}`, undefined, "GET")) as { operation?: { status?: string } };
            if (detail.operation?.status === "awaiting_approval") awaitingOperationId = row.childOperationId;
          }
          children.push({
            role, status: CHILD_STATUS[row.state ?? ""] ?? "unknown",
            ...(row.childOperationId ? { childOperationId: row.childOperationId } : {}),
            ...(row.receipt?.childOperationId ? { receiptOperationId: row.receipt.childOperationId } : {}),
            ...(awaitingOperationId ? { awaitingOperationId } : {}),
          });
        }
        return children;
      });
    },

    async changeProducer() {
      // A changed producer is a new desired state of the parent graph. It needs the proposal above, which is refused.
      return refuse("a changed producer needs a new parent revision, and that needs the proposal that is refused above");
    },

    async issueOutputPreauthorization() {
      // POST /api/platform/v1/mixed-output-preauthorizations needs the reference's contract digest and value type. The plan
      // readback exposes neither; the run readback exposes only the reference id and whether it is materialized.
      return refuse("the reference contract digest and value type are not readable from the plan or the run, so no precise preauthorization can be named");
    },

    async useOutputOnce() {
      // The use is reserved inside the consumer's own workflow (consumeOutputs). No browser or REST route spends it.
      return refuse("no browser or REST route spends a preauthorization use; the consumer's workflow reserves it, so the one-use check cannot be driven");
    },

    async close() {
      for (const release of closers.splice(0)) await release();
    },
  };
}
