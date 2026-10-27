/**
 * `Mix03Product` for the PROD-MIX-03 live scenario: the browser half of the product path, on the Zenith stack the workflow
 * started on this runner (ZENITH_DEFAULT_STACK_DIRECTORY and ZENITH_DEFAULT_MAILPIT_URL, exported by default-stack/env.mjs).
 *
 * It drives the product the way scripts/release/drivers/operated.ts does: the owner and a CI-created approver sign in for
 * real, enrol a TOTP authenticator, step up with it when a privileged route answers `mfa_required`, and the approver approves
 * in the browser. Every product call is a route or action the web app uses. The only non-product call is the test user
 * provisioning that operated.ts also does (the stack's Auth admin API creates two disposable users).
 *
 * proposeMixed drives the real planner: a sandbox parent environment holds the producer and consumer manifest (its simulated
 * deploy is the only parent revision the planner reads, and it creates no cloud resource), the producer and consumer are AWS
 * children on the run's connection, and each child gets its own deploy operation. issueOutputPreauthorization reads the plan's
 * digests and issues one precise use for the consumer. changeProducer and useOutputOnce refuse before sending anything: a
 * consumer's output classification and the one-use reservation run only inside the consumer's own workflow, which no browser or
 * REST route starts, and a changed producer needs a second parent revision that this driver does not yet propose.
 * Evidence names the approver as the automated test approver; no credential, token or recovery link is returned.
 *
 * Seams: `request` (same-origin fetch in the page), `approve`, `stepUp`, `session` and `sleep`. Unit tests inject all of them.
 */
import path from "node:path";
import type { Browser, Page } from "@playwright/test";
import type { EnvLike } from "../../config";
import { refuse, Refusal, sanitizedError, type Mix03Artifact, type Mix03Child, type Mix03Product, type Mix03Tenant } from "./mix-03";
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
  /** Waits between readbacks of a deployment. Default: a real timer. */
  sleep?: (ms: number) => Promise<void>;
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
const SAFE_CODE = /^[a-z_]{1,40}$/, ID = /^[A-Za-z0-9_.:-]{1,128}$/, HEX64 = /^[a-f0-9]{64}$/;
/** Deployment readback bound: 60 polls, 5 seconds apart. */
const DEPLOY_POLLS = { attempts: 60, intervalMs: 5_000 };
/** One use, fifteen minutes: enough for one consumer materialization and short enough to lapse on its own. */
const PREAUTH_LIFETIME_MS = 15 * 60_000;
const PREAUTH_REASON = "PROD-MIX-03 one-use output preauthorization";

/** The reference the run declares: the producer bucket's ARN output feeds the consumer function's bucket_arn input. */
export const MIX03_REFERENCE = {
  id: "bucket-arn",
  producer: { address: "object_store/bucket", output: "arn", type: "resource_id" },
  consumer: { address: "function/consumer", input: "bucket_arn", type: "resource_id" },
} as const;

/**
 * The producer, the consumer and the one graph they form. The parent's revision is the graph (`graph`); each child's revision is
 * its own part, and the planner's pins bind every node of the graph to exactly one of those two children.
 */
export function mix03Manifests(region: string, artifact: Mix03Artifact) {
  const producer = { version: 2, resources: [{ id: "bucket", name: "bucket", kind: "object_store" }] };
  const functions = [{
    id: "consumer", name: "consumer", kind: "function", provider: "aws", region, runtime: "nodejs22.x", handler: "index.handler",
    source: { type: "s3", bucket: artifact.bucket, key: artifact.key, version: artifact.versionId, sha256: artifact.sha256, sourceDigest: artifact.sourceDigest },
    env: [{ key: "PRODUCER_BUCKET_ARN", value: "{{zenith.input.bucket_arn}}" }],
  }];
  const consumer = { version: 2, functions };
  return { producer, consumer, graph: { version: 2, resources: producer.resources, functions } };
}

/** Readback ids and digests are checked before they are sent back to the product; a malformed one refuses with its own name. */
const idOf =(value: unknown, what: string): string => typeof value === "string" && ID.test(value) ? value : refuse(`${what} was not returned by the product`);
const hexOf = (value: unknown, what: string): string => typeof value === "string" && HEX64.test(value) ? value : refuse(`${what} is not a digest in the plan readback`);
/** The error code, the service's own reason code (details.reason) and the sanitized message. */
const reasonCode = (data: unknown): string => {
  const code = codeOf(data), error = (data as { error?: { message?: unknown; details?: { reason?: unknown } } } | undefined)?.error;
  const reason = error?.details?.reason, message = sanitizedError(error?.message);
  return [code && SAFE_CODE.test(code) ? code.replace(/_/g, " ") : "no code", typeof reason === "string" && SAFE_CODE.test(reason) ? reason : undefined].filter(Boolean).join(", ") + (message ? `: ${message}` : "");
};

/** The product's PROD-MIX-03 driver. Create it once per run; `close()` releases the browser after teardown. */
export function browserMix03Product(env: EnvLike = process.env, seams: Mix03DriverSeams = {}): Mix03Product & { close(): Promise<void> } {
  const request: ProductRequest = seams.request ?? browserRequest;
  const stepUp = seams.stepUp ?? stepUpWithAuthenticator;
  const approve = seams.approve ?? ((session: TenantSession, operationId: string) => approveOperation({ stack: session.stack }, session, operationId));
  const openSession = seams.session ?? (() => openRealSession(env));
  const sleep = seams.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const sessions = new Map<string, TenantSession>();
  /** The two child operations per mixed plan, adopted in order by startMixed: { partitionId, operationId }. */
  const adoptions = new Map<string, { partitionId: string; operationId: string }[]>();
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
  const runAction = async (session: TenantSession, id: string, input: Record<string, unknown>, scope: Record<string, unknown> = {}): Promise<{ ok: boolean; data?: unknown }> => {
    const response = await send(session, session.owner, `/api/actions/${id}`, { mode: "execute", input, scope, idempotencyKey: nonce() });
    ensure(response.status >= 200 && response.status < 300, "http-refused");
    const body = response.data as { result?: { ok?: unknown; data?: unknown } } | undefined;
    return { ok: body?.result?.ok === true, data: body?.result?.data };
  };
  /** A product action that must succeed; the action id is ours and fixed, the product's own sentence is withheld. */
  const must = async (session: TenantSession, id: string, input: Record<string, unknown>, scope: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    const result = await runAction(session, id, input, scope);
    if (!result.ok) refuse(`${id} was refused by the product`);
    return (result.data ?? {}) as Record<string, unknown>;
  };
  /** Deploys one environment from its own working copy and waits until the simulated parent deployment succeeds. */
  const deployAndWait = async (session: TenantSession, projectId: string, environmentId: string): Promise<void> => {
    await must(session, "deploy.apply", { projectId, environmentId }, { projectId, environmentId });
    for (let poll = 1; ; poll++) {
      const latest = ok(await send(session, session.owner, `/api/environments/${environmentId}/deployments?limit=1`, undefined, "GET")) as { deployments?: { status?: unknown }[] };
      const status = latest.deployments?.[0]?.status;
      if (status === "succeeded") return;
      if (status === "failed" || status === "rolled_back" || status === "cancelled") refuse("the parent environment's deployment did not succeed");
      if (poll >= DEPLOY_POLLS.attempts) refuse("the parent environment's deployment did not finish within the bound");
      await sleep(DEPLOY_POLLS.intervalMs);
    }
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
          label: "PROD-MIX-03 live", region: input.region, accountId: input.accountId, stateBucket: input.stateBucket, bootstrapNameSuffix: input.bootstrapNameSuffix,
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

    async proposeMixed(tenant, input) {
      return step("mixed proposal", async () => {
        const session = sessionOf(tenant);
        const projectId = session.projectId, scope = { projectId };
        const { producer, consumer, graph } = mix03Manifests(input.region, input.artifact);
        // The parent's revision is the whole graph. A sandbox environment deploys it through the simulated provider, so no cloud resource exists.
        await must(session, "project.updateManifest", { projectId, manifest: graph }, scope);
        const parent = idOf((await must(session, "env.create", { projectId, name: "parent", class: "sandbox", approvalRequired: false }, scope)).environmentId, "the parent environment");
        await deployAndWait(session, projectId, parent);
        const create = async (name: string) => idOf((await must(session, "env.create", {
          projectId, name, class: "sandbox", connectionId: input.connectionId, region: input.region, approvalRequired: true,
        }, scope)).environmentId, `the ${name} environment`);
        const producerEnv = await create("producer"), consumerEnv = await create("consumer");

        const planned = await send(session, session.owner, "/api/platform/v1/mixed/plans", {
          parentEnvironmentId: parent, childEnvironmentIds: [producerEnv, consumerEnv],
          pins: [{ address: "object_store/bucket", childEnvironmentId: producerEnv }, { address: "function/consumer", childEnvironmentId: consumerEnv }],
          references: [MIX03_REFERENCE],
        });
        if (planned.status < 200 || planned.status >= 300) refuse(`the product refused the mixed plan (${reasonCode(planned.data)})`);
        const proposed = planned.data as { plan?: { parentPlanId?: unknown }; operationId?: unknown };
        const planId = idOf(proposed.plan?.parentPlanId, "the mixed plan id");
        const parentOperationId = idOf(proposed.operationId, "the parent operation");

        // Each child is deployed from its own part of the graph, so its revision expands to exactly its approved subplan.
        const deployChild = async (environmentId: string, manifest: unknown): Promise<string> => {
          await must(session, "project.updateManifest", { projectId, manifest }, scope);
          return idOf((await must(session, "deploy.apply", { projectId, environmentId }, { projectId, environmentId })).operationId, "the child deploy operation");
        };
        const producerOperationId = await deployChild(producerEnv, producer);
        const consumerOperationId = await deployChild(consumerEnv, consumer);

        const readback = ok(await send(session, session.owner, `/api/platform/v1/mixed/plans/${planId}`, undefined, "GET")) as { children?: { partitionId?: unknown; childEnvironmentId?: unknown }[] };
        const partitionOf = (environmentId: string): string => idOf(readback.children?.find(child => child.childEnvironmentId === environmentId)?.partitionId, "the child partition");
        adoptions.set(planId, [
          { partitionId: partitionOf(producerEnv), operationId: producerOperationId },
          { partitionId: partitionOf(consumerEnv), operationId: consumerOperationId },
        ]);
        return { environmentIds: [producerEnv, consumerEnv], planId, parentOperationId };
      });
    },

    async approve(tenant, operationId) {
      return step("browser approval", async () => { await approve(sessionOf(tenant), operationId); });
    },

    async startMixed(tenant, planId) {
      return step("mixed start", async () => {
        const session = sessionOf(tenant);
        for (const adoption of adoptions.get(planId) ?? refuse("no child operations were recorded for this plan")) {
          const adopted = await send(session, session.owner, `/api/platform/v1/mixed/plans/${planId}/children`, adoption, "POST");
          if (adopted.status < 200 || adopted.status >= 300) return { started: false as const, reason: `the product refused a child adoption (${reasonCode(adopted.data)})` };
        }
        const response = await send(session, session.owner, `/api/platform/v1/mixed/plans/${planId}/start`, {}, "POST");
        if (response.status >= 200 && response.status < 300) return { started: true as const };
        return { started: false as const, reason: `the product refused the start (${reasonCode(response.data)})` };
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
      // The consumer's classification of a changed output (review_required) is decided inside the consumer's own run, by consumeOutputs.
      // No browser or REST route starts that run, so this driver cannot read the state back. It refuses before any request.
      return refuse("a changed producer's consumer state is decided only inside the consumer's own run, which no browser or REST route starts");
    },

    async issueOutputPreauthorization(tenant, planId) {
      return step("output preauthorization", async () => {
        const session = sessionOf(tenant);
        const plan = ok(await send(session, session.owner, `/api/platform/v1/mixed/plans/${planId}`, undefined, "GET")) as {
          parentOperationId?: unknown; desiredDigest?: unknown; references?: unknown; children?: unknown;
        };
        const references = Array.isArray(plan.references) ? plan.references as Record<string, unknown>[] : [];
        if (references.length !== 1) refuse("the plan does not have exactly one reference");
        const [reference] = references as [Record<string, unknown>];
        const children = (Array.isArray(plan.children) ? plan.children : []) as { partitionId?: unknown; childEnvironmentId?: unknown }[];
        const consumer = children.find(child => child.partitionId === reference.consumerPartitionId);
        if (typeof reference.valueType !== "string") refuse("the reference has no value type in the plan readback");
        const issued = await send(session, session.owner, "/api/platform/v1/mixed-output-preauthorizations", {
          parentOperationId: idOf(plan.parentOperationId, "the parent operation"),
          environmentId: idOf(consumer?.childEnvironmentId, "the consumer environment"),
          desiredDigest: hexOf(plan.desiredDigest, "the desired digest"),
          referenceId: idOf(reference.referenceId, "the reference id"),
          contractDigest: hexOf(reference.contractDigest, "the reference contract digest"),
          consumerSubplanDigest: hexOf(reference.consumerSubplanDigest, "the consumer subplan digest"),
          producerSubplanDigest: hexOf(reference.producerSubplanDigest, "the producer subplan digest"),
          valueType: reference.valueType,
          maxUses: 1,
          lifetimeMs: PREAUTH_LIFETIME_MS,
          reason: PREAUTH_REASON,
        });
        if (issued.status < 200 || issued.status >= 300) refuse(`the product refused the output preauthorization (${reasonCode(issued.data)})`);
      });
    },

    async useOutputOnce() {
      // The one use is reserved by consumeOutputs inside the consumer's own workflow, which needs a changed producer first (see changeProducer).
      return refuse("no browser or REST route spends a preauthorization use: the consumer's workflow reserves it, and it cannot be re-run without a changed producer");
    },

    async close() {
      for (const release of closers.splice(0)) await release();
    },
  };
}
