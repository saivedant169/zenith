/**
 * PROD-MAN-06 HTTP surface against a real PGlite control store: the operator routes (plan assignment, invoices,
 * suspension), the signed webhook route, the tick route and the route classification. The session lookup is mocked (that is
 * Supabase), as are verified MFA claims and live identity; authorization, step-up, same-origin, validation, optimistic versioning, audit and the effect on live admission are
 * real. The payment provider is never contacted: invoices are generated without a provider (draft) or through the
 * contract-level fake.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { openPlatformDb, repos, type PlatformDbHandle } from "@/lib/controlplane/db";
import { withLease } from "@/lib/controlplane/leases";
import { FALLBACK_DEFER_MS, MAINTENANCE_JOBS, jobLeaseScope, runCriticalJob } from "@/lib/platform/critical-jobs";
import { assertBillingAdmitted, invalidateBillingState } from "@/lib/billing/admission";
import { generateInvoice } from "@/lib/billing/invoice";
import { assignPlan, getAccount, getInvoiceByPeriod } from "@/lib/billing/store";
import { DEFAULT_PLAN_ID } from "@/lib/billing/plans";
import { periodBounds, periodOf, previousPeriod } from "@/lib/billing/period";
import { INVOICE_SETTLE_MS } from "@/lib/billing/service";
import { platformAccess } from "@/app/api/platform/v1/_lib/bearer-paths";
import { FakeInvoiceProvider, hex, invoiceEvent, seedResource, webhookSecret } from "./_support";

const OPERATOR = "0b9d4e1c-1111-4222-8333-444455556666";
const STRANGER = "9a8b7c6d-1111-4222-8333-444455556666";
const ORIGIN = "http://zenith.test";

const mocks = vi.hoisted(() => ({ session: vi.fn(), claims: vi.fn(), authUser: vi.fn(), dbCalls: vi.fn(), platformBoot: vi.fn(async () => true), db: undefined as unknown as PlatformDbHandle }));
vi.mock("@supabase/ssr", () => ({ createServerClient: () => ({ auth: { getClaims: mocks.claims, getUser: mocks.authUser } }) }));
vi.mock("@/lib/supabase/env", () => ({ SUPABASE_URL: "http://auth.test", SUPABASE_PUBLIC_KEY: "", isSupabaseConfigured: () => true }));
vi.mock("@/lib/supabase/route", () => ({ sessionUserFromRequest: mocks.session }));
vi.mock("@/lib/ops/operator", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/ops/operator")>()), opsStore: async () => mocks.db }));
vi.mock("@/lib/controlplane/db", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/controlplane/db")>()), platformDb: async () => { mocks.dbCalls(); return mocks.db; } }));
// Default application boot is a controlled port here; cron authentication and SQL execution stay real.
vi.mock("@/lib/server/cron", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/server/cron")>()), ensurePlatformCron: mocks.platformBoot }));

const assignment = await import("@/app/api/admin/billing/assignment/route");
const invoices = await import("@/app/api/admin/billing/invoices/route");
const suspension = await import("@/app/api/admin/billing/suspension/route");
const webhook = await import("@/app/api/platform/v1/billing/webhook/route");
const tick = await import("@/app/api/internal/tick/billing/route");

const json = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(`${ORIGIN}${path}`, { method, headers: { origin: ORIGIN, "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const asOperator = () => mocks.session.mockResolvedValue({ id: OPERATOR, email: "op@example.com" });
const ws = (): string => `ws_route_${hex(6)}`;

let handle: PlatformDbHandle;
beforeAll(async () => { handle = mocks.db = await openPlatformDb({ kind: "pglite" }); }, 60_000);
afterAll(async () => { await handle.close(); });
beforeEach(() => {
  vi.stubEnv("ZENITH_OPS_ADMIN_IDS", OPERATOR);
  vi.stubEnv("ZENITH_PLATFORM_ORIGIN", ORIGIN);
  vi.stubEnv("ZENITH_BILLING", "managed");
  vi.stubEnv("ZENITH_BILLING_STRIPE_SECRET_KEY", "");
  mocks.session.mockReset();
  mocks.claims.mockReset();
  mocks.authUser.mockReset();
  mocks.claims.mockResolvedValue({ data: { claims: { sub: OPERATOR, aal: "aal2", exp: Date.now() / 1000 + 600 } }, error: null });
  mocks.authUser.mockResolvedValue({ data: { user: { id: OPERATOR, email_confirmed_at: new Date().toISOString(), factors: [{ factor_type: "totp", status: "verified" }] } }, error: null });
  mocks.dbCalls.mockClear();
  mocks.platformBoot.mockClear();
  invalidateBillingState();
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("operator routes: authorization and the disabled mode", () => {
  it.each(["aal1", "unavailable", "removed-factor"])("refuses billing mutations without verified MFA: %s", async state => {
    asOperator();
    if (state === "aal1") mocks.claims.mockResolvedValue({ data: { claims: { sub: OPERATOR, aal: "aal1", exp: Date.now() / 1000 + 600 } }, error: null });
    if (state === "unavailable") mocks.claims.mockRejectedValue(new Error("controlled identity provider outage"));
    if (state === "removed-factor") mocks.authUser.mockResolvedValue({ data: { user: { id: OPERATOR, email_confirmed_at: new Date().toISOString(), factors: [] } }, error: null });
    const id = ws();
    const responses = [
      await assignment.PUT(json("PUT", "/api/admin/billing/assignment", { workspaceId: id, planId: "explore" })),
      await invoices.POST(json("POST", "/api/admin/billing/invoices", { workspaceId: id, period: "2026-03" })),
      await suspension.POST(json("POST", "/api/admin/billing/suspension", { workspaceId: id, action: "suspend", reason: "contract" })),
    ];
    expect(responses.map(response => response.status)).toEqual(Array(3).fill(state === "unavailable" ? 503 : 403));
    expect(mocks.claims).toHaveBeenCalledTimes(3);
    expect(await getAccount(handle, id)).toBeNull();
  });

  it("refuses an anonymous caller (401) and a signed-in non-operator (403) on every route and method", async () => {
    mocks.session.mockResolvedValue(null);
    expect((await assignment.GET(json("GET", "/api/admin/billing/assignment"))).status).toBe(401);
    expect((await assignment.PUT(json("PUT", "/api/admin/billing/assignment", { workspaceId: "ws_x", planId: "explore" }))).status).toBe(401);
    expect((await invoices.POST(json("POST", "/api/admin/billing/invoices", { workspaceId: "ws_x", period: "2026-03" }))).status).toBe(401);
    expect((await suspension.POST(json("POST", "/api/admin/billing/suspension", { workspaceId: "ws_x", action: "suspend", reason: "x" }))).status).toBe(401);
    mocks.session.mockResolvedValue({ id: STRANGER, email: "x@example.com" });
    expect((await assignment.GET(json("GET", "/api/admin/billing/assignment"))).status).toBe(403);
    expect((await assignment.PUT(json("PUT", "/api/admin/billing/assignment", { workspaceId: "ws_x", planId: "explore" }))).status).toBe(403);
    expect((await invoices.GET(json("GET", "/api/admin/billing/invoices?workspaceId=ws_x"))).status).toBe(403);
    expect((await suspension.POST(json("POST", "/api/admin/billing/suspension", { workspaceId: "ws_x", action: "reinstate", reason: "x" }))).status).toBe(403);
  });

  it("refuses a cross-origin mutation even from an operator", async () => {
    asOperator();
    const res = await suspension.POST(json("POST", "/api/admin/billing/suspension", { workspaceId: "ws_x", action: "suspend", reason: "csrf" }, { origin: "https://evil.example" }));
    expect(res.status).toBe(403);
    expect((await assignment.PUT(json("PUT", "/api/admin/billing/assignment", { workspaceId: "ws_x", planId: "explore" }, { "sec-fetch-site": "cross-site" }))).status).toBe(403);
  });

  it("answers 404 on a host where billing is not managed, and writes nothing", async () => {
    asOperator();
    for (const mode of ["", "disabled", "typo"]) {
      vi.stubEnv("ZENITH_BILLING", mode);
      const id = ws();
      expect((await assignment.PUT(json("PUT", "/api/admin/billing/assignment", { workspaceId: id, planId: "explore" }))).status).toBe(404);
      expect((await assignment.GET(json("GET", "/api/admin/billing/assignment"))).status).toBe(404);
      expect((await invoices.POST(json("POST", "/api/admin/billing/invoices", { workspaceId: id, period: "2026-03" }))).status).toBe(404);
      expect((await suspension.POST(json("POST", "/api/admin/billing/suspension", { workspaceId: id, action: "suspend", reason: "x" }))).status).toBe(404);
      expect(await getAccount(handle, id)).toBeNull();
    }
  });
});

describe("plan assignment, suspension and invoice routes", () => {
  it("assigns a plan, shows the catalog, versions the account and refuses an unknown plan or a stale writer", async () => {
    asOperator();
    const id = ws();
    const put = await assignment.PUT(json("PUT", "/api/admin/billing/assignment", { workspaceId: id, planId: "builder", reason: "pilot" }));
    expect(put.status).toBe(200);
    const body = (await put.json()) as { account: { planId: string; version: number; assignedBy: string }; notice: string };
    expect(body.account).toMatchObject({ planId: "builder", version: 1, assignedBy: OPERATOR });
    expect(body.notice).toMatch(/not live/i);
    const catalog = (await (await assignment.GET(json("GET", "/api/admin/billing/assignment"))).json()) as { plans: { id: string; provisional: boolean; display: { monthlyPrice: string } }[]; accounts: { workspaceId: string }[]; defaultPlanId: string };
    expect(catalog.plans.map((p) => p.id)).toEqual(["explore", "builder", "team", "enterprise"]);
    expect(catalog.plans.every((p) => !p.provisional)).toBe(true);
    expect(catalog.plans.map((p) => p.display.monthlyPrice)).toEqual(["Free", "$29/month minimum", "$199/month minimum", "Custom pricing"]);
    expect(catalog.defaultPlanId).toBe("explore");
    expect(catalog.accounts.map((a) => a.workspaceId)).toContain(id);
    const one = (await (await assignment.GET(json("GET", `/api/admin/billing/assignment?workspaceId=${id}`))).json()) as { account: { planId: string }; events: { kind: string; reason?: string }[] };
    expect(one.account.planId).toBe("builder");
    expect(one.events[0]).toMatchObject({ kind: "plan_assigned", reason: "pilot" });
    expect((await assignment.PUT(json("PUT", "/api/admin/billing/assignment", { workspaceId: id, planId: "enterprise" }))).status).toBe(200);
    for (const legacy of ["free_provisional", "team_provisional", "scale_provisional", "pro"]) {
      expect((await assignment.PUT(json("PUT", "/api/admin/billing/assignment", { workspaceId: id, planId: legacy }))).status, legacy).toBe(400);
    }
    expect((await assignment.PUT(json("PUT", "/api/admin/billing/assignment", { workspaceId: id, planId: "explore", extra: 1 }))).status).toBe(400);
    expect((await assignment.PUT(json("PUT", "/api/admin/billing/assignment", { workspaceId: id, planId: "explore", expectedVersion: 9 }))).status).toBe(409);
    expect((await assignment.GET(json("GET", "/api/admin/billing/assignment?workspaceId=bad%20id"))).status).toBe(400);
  });

  it("suspends and reinstates new work with a required reason, and the change is live for admission at once", async () => {
    asOperator();
    const id = ws();
    expect((await suspension.POST(json("POST", "/api/admin/billing/suspension", { workspaceId: id, action: "suspend", reason: "x" }))).status).toBe(404); // no account yet
    await assignment.PUT(json("PUT", "/api/admin/billing/assignment", { workspaceId: id, planId: "builder" }));
    expect((await suspension.POST(json("POST", "/api/admin/billing/suspension", { workspaceId: id, action: "suspend" }))).status).toBe(400); // reason required
    expect((await suspension.POST(json("POST", "/api/admin/billing/suspension", { workspaceId: id, action: "suspend", reason: "   " }))).status).toBe(400);
    expect((await suspension.POST(json("POST", "/api/admin/billing/suspension", { workspaceId: id, action: "delete", reason: "x" }))).status).toBe(400);
    const opts = { env: { ZENITH_BILLING: "managed" }, store: async () => handle, ttlMs: 60_000 };
    await expect(assertBillingAdmitted({ workspaceId: id, kind: "deploy" }, opts)).resolves.toBeUndefined();
    const res = await suspension.POST(json("POST", "/api/admin/billing/suspension", { workspaceId: id, action: "suspend", reason: "abuse review" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { account: { status: string; suspensionReason: string }; whatSuspensionMeans: string };
    expect(body.account).toMatchObject({ status: "suspended", suspensionReason: "operator" });
    expect(body.whatSuspensionMeans).toMatch(/never deletes/i);
    // a cached "active" read was invalidated by the route in this process
    await expect(assertBillingAdmitted({ workspaceId: id, kind: "deploy" }, opts)).rejects.toMatchObject({ code: "billing_suspended", status: 402 });
    await expect(assertBillingAdmitted({ workspaceId: id, kind: "export" }, opts)).resolves.toBeUndefined();
    const back = await suspension.POST(json("POST", "/api/admin/billing/suspension", { workspaceId: id, action: "reinstate", reason: "review closed" }));
    expect(((await back.json()) as { account: { status: string } }).account.status).toBe("active");
    await expect(assertBillingAdmitted({ workspaceId: id, kind: "deploy" }, opts)).resolves.toBeUndefined();
  });

  it("generates an invoice only for an ended period, once, and says when no provider is configured", async () => {
    asOperator();
    vi.stubEnv("ZENITH_BILLING_STRIPE_SECRET_KEY", "");
    const id = ws();
    expect((await invoices.POST(json("POST", "/api/admin/billing/invoices", { workspaceId: id, period: "2026-03" }))).status).toBe(404); // no account
    await assignment.PUT(json("PUT", "/api/admin/billing/assignment", { workspaceId: id, planId: "builder" }));
    await seedResource(handle, id, { createdAt: "2026-03-01T00:00:00Z", status: "deleted", updatedAt: "2026-03-02T00:00:00Z" });
    const future = `${new Date().getUTCFullYear() + 1}-01`;
    expect((await invoices.POST(json("POST", "/api/admin/billing/invoices", { workspaceId: id, period: future }))).status).toBe(409);
    expect((await invoices.POST(json("POST", "/api/admin/billing/invoices", { workspaceId: id, period: "2026-13" }))).status).toBe(400);
    const first = await invoices.POST(json("POST", "/api/admin/billing/invoices", { workspaceId: id, period: "2026-03" }));
    expect(first.status).toBe(200);
    const created = (await first.json()) as { invoice: { id: string; status: string; planProvisional: boolean; subtotalCents: number }; created: boolean; note: string; notice: string };
    expect(created).toMatchObject({ created: true, note: "provider_not_configured", invoice: { status: "draft", planProvisional: false, subtotalCents: 2900 } });
    expect(created.notice).toMatch(/not live/i);
    const again = (await (await invoices.POST(json("POST", "/api/admin/billing/invoices", { workspaceId: id, period: "2026-03" }))).json()) as { invoice: { id: string }; created: boolean };
    expect(again).toMatchObject({ created: false, invoice: { id: created.invoice.id } });
    const list = (await (await invoices.GET(json("GET", `/api/admin/billing/invoices?workspaceId=${id}`))).json()) as { invoices: { id: string }[] };
    expect(list.invoices.map((i) => i.id)).toEqual([created.invoice.id]);
  });
});

describe("invoice route for a contract plan", () => {
  it("answers with an explicit contract_billed outcome and creates no invoice", async () => {
    asOperator();
    const id = ws();
    await assignment.PUT(json("PUT", "/api/admin/billing/assignment", { workspaceId: id, planId: "enterprise" }));
    const res = await invoices.POST(json("POST", "/api/admin/billing/invoices", { workspaceId: id, period: "2026-03" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "contract_billed", planId: "enterprise", invoice: null });
    const list = (await (await invoices.GET(json("GET", `/api/admin/billing/invoices?workspaceId=${id}`))).json()) as { invoices: unknown[] };
    expect(list.invoices).toEqual([]);
  });
});

describe("signed webhook route", () => {
  const secret = webhookSecret();
  const post = (raw: string, signature: string | null) => webhook.POST(new Request(`${ORIGIN}/api/platform/v1/billing/webhook`, { method: "POST", headers: { "content-type": "application/json", ...(signature ? { "stripe-signature": signature } : {}) }, body: raw }));

  async function openInvoice() {
    const id = ws();
    await handle.query("insert into platform.billing_accounts (workspace_id, plan_id, assigned_by) values ($1, 'builder', 'op')", [id]);
    const r = await generateInvoice(handle, { provider: new FakeInvoiceProvider(), now: new Date(), netDays: 14 }, id, "2026-03");
    if (r.status !== "ok" || r.invoice.status !== "open") throw new Error("setup");
    return r.invoice;
  }

  it("is a 404 that does nothing when billing is not managed", async () => {
    vi.stubEnv("ZENITH_BILLING", "");
    vi.stubEnv("ZENITH_BILLING_STRIPE_WEBHOOK_SECRET", secret);
    const res = await post("{}", "t=1,v1=00");
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("billing_disabled");
  });

  it("is authenticated by its signature alone: a bad, missing or stale signature changes nothing", async () => {
    vi.stubEnv("ZENITH_BILLING_STRIPE_WEBHOOK_SECRET", secret);
    const invoice = await openInvoice();
    const good = invoiceEvent("invoice.paid", invoice, secret, Date.now());
    expect((await post(good.raw, null)).status).toBe(400);
    expect((await post(`${good.raw} `, good.header)).status).toBe(400);
    expect((await post(good.raw, invoiceEvent("invoice.paid", invoice, webhookSecret(), Date.now()).header)).status).toBe(400);
    expect((await post(good.raw, invoiceEvent("invoice.paid", invoice, secret, Date.now() - 3_600_000).header)).status).toBe(400);
    expect((await getInvoiceByPeriod(handle, invoice.workspaceId, "2026-03"))?.status).toBe("open");
    vi.stubEnv("ZENITH_BILLING_STRIPE_WEBHOOK_SECRET", "");
    expect((await post(good.raw, good.header)).status).toBe(503);
  });

  it("applies a signed payment once and answers a redelivery as a duplicate", async () => {
    vi.stubEnv("ZENITH_BILLING_STRIPE_WEBHOOK_SECRET", secret);
    const invoice = await openInvoice();
    const e = invoiceEvent("invoice.payment_succeeded", invoice, secret, Date.now());
    const first = await post(e.raw, e.header);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ received: true, duplicate: false, outcome: "applied" });
    expect((await getInvoiceByPeriod(handle, invoice.workspaceId, "2026-03"))?.status).toBe("paid");
    const again = await post(e.raw, e.header);
    expect(await again.json()).toEqual({ received: true, duplicate: true });
  });

  it("refuses an oversized body before reading it all", async () => {
    vi.stubEnv("ZENITH_BILLING_STRIPE_WEBHOOK_SECRET", secret);
    const res = await post("x".repeat(300 * 1024), "t=1,v1=00");
    expect(res.status).toBe(413);
  });
});

describe("billing tick route", () => {
  const SECRET = `cron_${hex(12)}`;
  const call = (authorization?: string, method: "GET" | "POST" = "POST") => tick[method](new NextRequest(`${ORIGIN}/api/internal/tick/billing`, { method, headers: authorization ? { authorization } : {} }));
  const expireDurableDeferral = () => handle.query("update platform.scheduled_job_runs set last_success_at = clock_timestamp() - ($1::bigint * interval '1 millisecond') where job = 'billing'", [FALLBACK_DEFER_MS + 1000]);

  it("needs the scheduler's bearer before anything else", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    expect((await call()).status).toBe(401);
    expect((await call(undefined, "GET")).status).toBe(401);
    expect((await call(`Bearer ${hex(12)}`)).status).toBe(401);
    vi.stubEnv("CRON_SECRET", "");
    expect((await call(`Bearer ${SECRET}`)).status).toBe(503);
    expect(mocks.platformBoot).not.toHaveBeenCalled();
    expect(mocks.dbCalls).not.toHaveBeenCalled();
  });

  it("does nothing, touching no store, when billing is not managed", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    vi.stubEnv("ZENITH_BILLING", "");
    const res = await call(`Bearer ${SECRET}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pass: "billing", ok: true, enabled: false });
    expect(res.headers.get("x-request-id")).toBeTruthy();
    expect(mocks.platformBoot).not.toHaveBeenCalled();
    expect(mocks.dbCalls).not.toHaveBeenCalled();
  });

  it("refuses managed billing when the authenticated platform boot is unavailable", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    mocks.platformBoot.mockResolvedValueOnce(false);
    expect((await call(`Bearer ${SECRET}`)).status).toBe(503);
    expect(mocks.dbCalls).not.toHaveBeenCalled();
  });

  it("yields to a successful durable billing pass without touching billing records again", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    await runCriticalJob(handle, "billing", "temporal", () => MAINTENANCE_JOBS.billing(handle));
    const before = (await repos.scheduledJobs.getScheduledJob(handle, "billing"))!;
    const response = await call(`Bearer ${SECRET}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ pass: "billing", ok: true, enabled: true, deferred: "durable_current" });
    expect(await repos.scheduledJobs.getScheduledJob(handle, "billing")).toMatchObject({ runsTotal: before.runsTotal, skippedTotal: before.skippedTotal + 1, lastSuccessSource: "temporal" });
  });

  it("excludes both HTTP verbs while the real billing lease is held", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    await expireDurableDeferral();
    const before = (await repos.scheduledJobs.getScheduledJob(handle, "billing"))!;
    await withLease(handle, { scope: jobLeaseScope("billing"), holder: `test:${hex(6)}`, ttlMs: 60_000 }, async () => {
      for (const method of ["GET", "POST"] as const) {
        const response = await call(`Bearer ${SECRET}`, method);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ pass: "billing", ok: true, enabled: true, deferred: "busy" });
      }
      expect((await repos.scheduledJobs.getScheduledJob(handle, "billing"))?.runsTotal).toBe(before.runsTotal);
    });
  });

  it("resumes after durable freshness expires and repeated authenticated fallback invoices only once", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    await expireDurableDeferral();
    const id = ws();
    await assignPlan(handle, { workspaceId: id, planId: DEFAULT_PLAN_ID, actor: "test:operator", reason: "fallback contract" });
    // The tick invoices last month only once it has been over for INVOICE_SETTLE_MS, so the first hours of a month expect none.
    const settled = Date.now() >= periodBounds(previousPeriod(periodOf(new Date()))).end.getTime() + INVOICE_SETTLE_MS;
    const first = await call(`Bearer ${SECRET}`, "GET");
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ pass: "billing", ok: true, enabled: true, invoicing: "not_configured", invoiceErrors: 0 });
    const invoices = await handle.query("select id, period from platform.billing_invoices where workspace_id=$1 order by period", [id]);
    expect(invoices).toHaveLength(settled ? 1 : 0);
    const afterFirst = (await repos.scheduledJobs.getScheduledJob(handle, "billing"))!;
    expect(afterFirst.lastSuccessSource).toBe("fallback");
    const repeated = await call(`Bearer ${SECRET}`);
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toMatchObject({ enabled: true, invoicesCreated: 0, invoicesOpened: 0, usageRowsWritten: 0, invoiceErrors: 0 });
    expect(await handle.query("select id, period from platform.billing_invoices where workspace_id=$1 order by period", [id])).toEqual(invoices);
    expect(await repos.scheduledJobs.getScheduledJob(handle, "billing")).toMatchObject({ lastSuccessSource: "fallback", runsTotal: afterFirst.runsTotal + 1 });
    expect(await repos.leases.current(handle, jobLeaseScope("billing"))).toBeNull();
  });
});

describe("route classification", () => {
  it("classifies the platform billing routes: a person's browser for reads and export, the signature for the webhook", () => {
    expect(platformAccess("/api/platform/v1/billing", "GET")).toBe("browser-only");
    expect(platformAccess("/api/platform/v1/billing/export", "GET")).toBe("browser-only");
    expect(platformAccess("/api/platform/v1/billing/webhook", "POST")).toBe("webhook-signed");
    expect(platformAccess("/api/platform/v1/billing/webhook", "GET")).toBeUndefined();
    expect(platformAccess("/api/platform/v1/billing", "POST")).toBeUndefined();
    expect(platformAccess("/api/platform/v1/billing/export", "POST")).toBeUndefined();
    expect(platformAccess("/api/platform/v1/billing/export/x", "GET")).toBeUndefined();
  });
});
