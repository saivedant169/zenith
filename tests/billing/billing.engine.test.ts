/**
 * PROD-MAN-06 against a REAL engine: PGlite always, PostgreSQL when ZENITH_TEST_PLATFORM_PG_URL is set (the same lanes the
 * control-store suites use). Covers migration 51's tables and triggers, metering from durable records, plan assignment,
 * invoice generation behind the provider adapter (a contract-level fake; the real Stripe adapter is covered in
 * billing-unit.test.ts), webhook ingestion with signature verification and idempotent reconciliation, dunning and safe
 * suspension, dispatch admission, tenant export, the scheduled pass and the `billing: disabled` bypass.
 *
 * Every secret and provider id is generated at run time. Stripe is never contacted.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlatformDbHandle } from "@/lib/controlplane/db";
import { BackpressureError } from "@/lib/ops/errors";
import { assertDispatchAdmitted } from "@/lib/ops/admission";
import { opsLimitsFromEnv } from "@/lib/ops/config";
import { buildRuntime, setOpsRuntimeForTests } from "@/lib/ops/runtime";
import { assertBillingAdmitted, invalidateBillingState } from "@/lib/billing/admission";
import { buildTenantExport } from "@/lib/billing/export";
import { generateInvoice } from "@/lib/billing/invoice";
import { collectUsage } from "@/lib/billing/metering";
import { periodOf } from "@/lib/billing/period";
import { billingView, runBillingTick } from "@/lib/billing/service";
import { reconcileStanding, reinstateWorkspace, runDunning, suspendWorkspace } from "@/lib/billing/standing";
import {
  aggregateUsage, applyStanding, assignPlan, getAccount, getInvoiceByPeriod, listAccountEvents, listInvoices, setStripeCustomer, upsertUsage, type Invoice,
} from "@/lib/billing/store";
import { handleStripeWebhook } from "@/lib/billing/webhook";
import { LANES, expectCode, newWorkspace, openLane } from "../controlplane/_support/harness";
import {
  DAY, FakeInvoiceProvider, NOW, PERIOD, forbiddenSql, hex, invoiceEvent, retainedCounts, seedBuild, seedCostEstimate, seedOperation, seedPortabilityExport, seedResource, webhookSecret,
} from "./_support";

const STUB_BILLING = { ZENITH_BILLING: "managed" } as const;

describe.each(LANES)("separable metering and billing [$name]", (lane) => {
  let ctx: Awaited<ReturnType<typeof openLane>>;
  beforeAll(async () => { ctx = await openLane(lane); }, 60_000);
  afterAll(async () => { await ctx.close(); });
  const db = (): PlatformDbHandle => ctx.db;
  beforeEach(() => invalidateBillingState());
  afterEach(() => { vi.unstubAllEnvs(); setOpsRuntimeForTests(undefined); });

  /** March 2026 usage for one workspace, from real durable rows. */
  async function seedMarch(ws: string): Promise<void> {
    await seedResource(db(), ws, { createdAt: "2026-03-31T00:00:00Z" });
    await seedResource(db(), ws, { status: "deleted", createdAt: "2026-03-10T00:00:00Z", updatedAt: "2026-03-10T10:00:00Z" });
    await seedResource(db(), ws, { createdAt: "2026-02-15T00:00:00Z" });
    await seedResource(db(), ws, { status: "deleted", createdAt: "2026-02-01T00:00:00Z", updatedAt: "2026-02-20T00:00:00Z" });
    await seedResource(db(), ws, { ownership: "referenced", createdAt: "2026-03-01T00:00:00Z" });
    await seedResource(db(), ws, { status: "planned", createdAt: "2026-03-01T00:00:00Z" });
    await seedBuild(db(), ws, "2026-03-05T10:00:00Z", "2026-03-05T10:12:30Z");
    await seedBuild(db(), ws, "2026-04-01T01:00:00Z", "2026-04-01T01:30:00Z");
    await seedPortabilityExport(db(), ws, 2_500_000_000, "2026-03-02T00:00:00Z");
    await seedPortabilityExport(db(), ws, 9_000_000_000, "2026-04-01T12:00:00Z");
    await seedOperation(db(), ws, { status: "succeeded", finishedAt: "2026-03-15T00:00:00Z" });
    await seedOperation(db(), ws, { status: "failed", finishedAt: "2026-03-16T00:00:00Z" });
    await seedOperation(db(), ws, { status: "succeeded", finishedAt: "2026-04-01T05:00:00Z" });
    await seedCostEstimate(db(), ws, "env_a", 40, "2026-02-01T00:00:00Z");
    await seedCostEstimate(db(), ws, "env_a", 80, "2026-03-20T00:00:00Z");
    await seedCostEstimate(db(), ws, "env_b", 20, "2026-04-01T00:00:00Z");
  }

  async function openInvoice(planId = "builder"): Promise<{ ws: string; invoice: Invoice; provider: FakeInvoiceProvider }> {
    const ws = newWorkspace();
    await assignPlan(db(), { workspaceId: ws, planId, actor: "op_1" });
    await seedMarch(ws);
    const provider = new FakeInvoiceProvider();
    const r = await generateInvoice(db(), { provider, now: NOW, netDays: 14 }, ws, PERIOD);
    if (r.status !== "ok" || r.invoice.status !== "open") throw new Error("test setup: invoice did not open");
    return { ws, invoice: r.invoice, provider };
  }

  /* --------------------------------- metering --------------------------------- */

  describe("usage metering from durable records", () => {
    it("derives every meter from the rows that already exist, and only for the period", async () => {
      const ws = newWorkspace();
      await seedMarch(ws);
      const r = await collectUsage(db(), ws, PERIOD, NOW);
      expect(r).toMatchObject({ closed: false, truncated: [] });
      const totals = Object.fromEntries((await aggregateUsage(db(), ws, PERIOD)).map((t) => [t.meter, t]));
      // 24h (created 31 Mar) + 10h (deleted after 10h) + 744h (all of March); referenced, planned and pre-March-deleted are not metered
      expect(totals.managed_resource_hours.quantity).toBeCloseTo(778, 4);
      expect(totals.managed_resource_hours.sources).toBe(3);
      expect(totals.build_minutes.quantity).toBeCloseTo(12.5, 4);
      expect(totals.storage_gb_month.quantity).toBeCloseTo(2.5, 6);
      expect(totals.operations_executed.quantity).toBe(2);
      expect(totals.egress_gb_estimated).toMatchObject({ estimated: true });
      expect(totals.egress_gb_estimated.quantity).toBe(80);
      expect(totals.managed_resource_hours.estimated).toBe(false);
    });

    it("is idempotent and level-triggered: repeating converges on the same rows", async () => {
      const ws = newWorkspace();
      await seedMarch(ws);
      const first = await collectUsage(db(), ws, PERIOD, NOW);
      expect(first.written).toBeGreaterThan(0);
      const before = await db().query<{ n: string }>("select count(*) as n from platform.billing_usage_events where workspace_id = $1", [ws]);
      const second = await collectUsage(db(), ws, PERIOD, NOW);
      expect(second).toMatchObject({ written: 0, unchanged: first.written });
      const after = await db().query<{ n: string }>("select count(*) as n from platform.billing_usage_events where workspace_id = $1", [ws]);
      expect(after[0].n).toBe(before[0].n);
    });

    it("keeps the period in progress current as time passes", async () => {
      const ws = newWorkspace();
      await seedResource(db(), ws, { createdAt: "2026-04-01T00:00:00Z" });
      await collectUsage(db(), ws, "2026-04", new Date("2026-04-01T10:00:00Z"));
      expect((await aggregateUsage(db(), ws, "2026-04"))[0].quantity).toBeCloseTo(10, 4);
      await collectUsage(db(), ws, "2026-04", new Date("2026-04-01T20:00:00Z"));
      expect((await aggregateUsage(db(), ws, "2026-04"))[0].quantity).toBeCloseTo(20, 4);
    });

    it("never reads another workspace's records", async () => {
      const a = newWorkspace();
      const b = newWorkspace();
      await seedMarch(a);
      await collectUsage(db(), b, PERIOD, NOW);
      expect(await aggregateUsage(db(), b, PERIOD)).toEqual([]);
    });

    it("rejects bad input at the store", async () => {
      const ws = newWorkspace();
      await expectCode(upsertUsage(db(), { workspaceId: ws, meter: "nope" as never, sourceId: "s", period: PERIOD, quantity: 1, unit: "u", estimated: false }), "invalid_input");
      await expectCode(upsertUsage(db(), { workspaceId: ws, meter: "build_minutes", sourceId: "s", period: PERIOD, quantity: -1, unit: "u", estimated: false }), "invalid_input");
      await expectCode(upsertUsage(db(), { workspaceId: ws, meter: "build_minutes", sourceId: "s", period: "2026-3", quantity: 1, unit: "u", estimated: false }), "invalid_input");
    });
  });

  /* ------------------------------ plan assignment ------------------------------ */

  describe("plan assignment", () => {
    it("assigns a known plan, audits the change and versions it", async () => {
      const ws = newWorkspace();
      const a = await assignPlan(db(), { workspaceId: ws, planId: "explore", actor: "op_1", reason: "initial" });
      expect(a).toMatchObject({ planId: "explore", status: "active", version: 1 });
      const b = await assignPlan(db(), { workspaceId: ws, planId: "builder", actor: "op_2", expectedVersion: 1 });
      expect(b).toMatchObject({ planId: "builder", version: 2, assignedBy: "op_2" });
      const events = await listAccountEvents(db(), ws);
      expect(events.map((e) => e.kind)).toEqual(["plan_assigned", "plan_assigned"]);
      expect(events[0].detail).toEqual({ from: "explore", to: "builder" });
      expect(events[1].reason).toBe("initial");
    });

    it("refuses an unknown plan, every legacy plan id, and a stale writer", async () => {
      const ws = newWorkspace();
      await assignPlan(db(), { workspaceId: ws, planId: "explore", actor: "op" });
      await expectCode(assignPlan(db(), { workspaceId: ws, planId: "pro", actor: "op" }), "invalid_input");
      for (const legacy of ["free_provisional", "team_provisional", "scale_provisional"]) {
        await expectCode(assignPlan(db(), { workspaceId: ws, planId: legacy, actor: "op" }), "invalid_input");
      }
      await assignPlan(db(), { workspaceId: ws, planId: "enterprise", actor: "op" });
      await assignPlan(db(), { workspaceId: ws, planId: "explore", actor: "op" });
      await expectCode(assignPlan(db(), { workspaceId: ws, planId: "builder", actor: "op", expectedVersion: 7 }), "conflict");
      expect((await getAccount(db(), ws))?.planId).toBe("explore");
    });

    it("never lifts a suspension by changing the plan", async () => {
      const ws = newWorkspace();
      await assignPlan(db(), { workspaceId: ws, planId: "explore", actor: "op" });
      await suspendWorkspace(db(), { workspaceId: ws, actor: "op", reason: "abuse review", now: NOW });
      await assignPlan(db(), { workspaceId: ws, planId: "team", actor: "op" });
      expect(await getAccount(db(), ws)).toMatchObject({ planId: "team", status: "suspended", suspensionReason: "operator" });
    });

    it("keeps a single provider customer per account", async () => {
      const ws = newWorkspace();
      await assignPlan(db(), { workspaceId: ws, planId: "builder", actor: "op" });
      const cus = `cus_${hex(6)}`;
      await setStripeCustomer(db(), ws, cus);
      await setStripeCustomer(db(), ws, cus);
      await expectCode(setStripeCustomer(db(), ws, `cus_${hex(6)}`), "conflict");
    });
  });

  /* ---------------------------------- invoicing --------------------------------- */

  describe("invoice generation behind the provider adapter", () => {
    it("invoices an ended period once, from collected usage, with the lines it was priced with", async () => {
      const { ws, invoice, provider } = await openInvoice();
      expect(invoice).toMatchObject({ period: PERIOD, planId: "builder", planProvisional: false, currency: "usd", subtotalCents: 2900, status: "open" });
      expect(invoice.stripeInvoiceId).toMatch(/^in_/);
      expect(invoice.lines.find((l) => l.key === "minimum")?.amountCents).toBe(2900);
      expect(invoice.lines.find((l) => l.key === "zcu_hours")).toMatchObject({ amountCents: 0, unit: "ZCU-hour" });
      expect(invoice.lines.find((l) => l.key === "egress_gb_estimated")).toMatchObject({ amountCents: 0, quantity: 80 });
      expect(new Date(invoice.dueAt!).getTime()).toBe(NOW.getTime() + 14 * DAY);
      expect((await getAccount(db(), ws))?.stripeCustomerId).toMatch(/^cus_/);
      expect(provider.calls.map((c) => c.op)).toEqual(["customer", "invoice"]);
    });

    it("is idempotent: a repeat returns the same invoice and makes no provider call", async () => {
      const { ws, invoice, provider } = await openInvoice();
      const again = await generateInvoice(db(), { provider, now: new Date(NOW.getTime() + DAY), netDays: 14 }, ws, PERIOD);
      expect(again).toMatchObject({ status: "ok", created: false, providerCalled: false });
      if (again.status === "ok") expect(again.invoice).toMatchObject({ id: invoice.id, digest: invoice.digest, stripeInvoiceId: invoice.stripeInvoiceId, version: invoice.version });
      expect(provider.distinctInvoices).toBe(1);
      expect(provider.calls).toHaveLength(2);
      expect(await listInvoices(db(), ws)).toHaveLength(1);
    });

    it("refuses a period that has not ended, a workspace without an account, and an unassigned plan", async () => {
      const ws = newWorkspace();
      expect(await generateInvoice(db(), { now: NOW, netDays: 14 }, ws, PERIOD)).toEqual({ status: "not_ready", reason: "no_account" });
      await assignPlan(db(), { workspaceId: ws, planId: "builder", actor: "op" });
      expect(await generateInvoice(db(), { now: NOW, netDays: 14 }, ws, periodOf(NOW))).toEqual({ status: "not_ready", reason: "period_open" });
    });

    it("never sends a zero total to the provider", async () => {
      const ws = newWorkspace();
      await assignPlan(db(), { workspaceId: ws, planId: "explore", actor: "op" });
      await seedMarch(ws);
      const provider = new FakeInvoiceProvider();
      const r = await generateInvoice(db(), { provider, now: NOW, netDays: 14 }, ws, PERIOD);
      expect(r).toMatchObject({ status: "ok", providerCalled: false });
      if (r.status === "ok") expect(r.invoice).toMatchObject({ status: "no_charge", subtotalCents: 0 });
      expect(provider.calls).toHaveLength(0);
    });

    it("never invoices an Enterprise (contract) account: an explicit contract_billed outcome, no row, no provider call", async () => {
      const ws = newWorkspace();
      await assignPlan(db(), { workspaceId: ws, planId: "enterprise", actor: "op" });
      await seedMarch(ws);
      const provider = new FakeInvoiceProvider();
      expect(await generateInvoice(db(), { provider, now: NOW, netDays: 14 }, ws, PERIOD)).toEqual({ status: "contract_billed", planId: "enterprise" });
      expect(await getInvoiceByPeriod(db(), ws, PERIOD)).toBeNull();
      expect(provider.calls).toHaveLength(0);
      // The tick covers every account in the database (shared with other suites on the PostgreSQL lane), so the exact
      // expectation is the number of accounts on the contract plan, which includes this one.
      const [contract] = await db().query<{ n: number }>("select count(*)::int as n from platform.billing_accounts where plan_id = 'enterprise'");
      expect(contract!.n).toBeGreaterThanOrEqual(1);
      const tick = await runBillingTick(db(), { env: STUB_BILLING, provider, now: NOW });
      expect(tick).toMatchObject({ enabled: true, contractBilledAccounts: contract!.n });
      expect(await listInvoices(db(), ws)).toHaveLength(0);
    });

    it("prices a stored legacy plan id as the plan it maps to, and records the resolved plan id", async () => {
      const ws = newWorkspace();
      await db().query("insert into platform.billing_accounts (workspace_id, plan_id, assigned_by) values ($1, 'scale_provisional', 'legacy')", [ws]);
      await seedMarch(ws);
      const r = await generateInvoice(db(), { provider: new FakeInvoiceProvider(), now: NOW, netDays: 14 }, ws, PERIOD);
      expect(r).toMatchObject({ status: "ok" });
      if (r.status === "ok") expect(r.invoice).toMatchObject({ planId: "team", planProvisional: false, subtotalCents: 19900 });
    });

    it("leaves a draft with its exact lines when the provider is down, and a retry reuses the same idempotency keys", async () => {
      const ws = newWorkspace();
      await assignPlan(db(), { workspaceId: ws, planId: "builder", actor: "op" });
      await seedMarch(ws);
      const provider = new FakeInvoiceProvider();
      provider.failNext = 1;
      const failed = await generateInvoice(db(), { provider, now: NOW, netDays: 14 }, ws, PERIOD);
      expect(failed).toMatchObject({ status: "ok", note: "provider_error" });
      const draft = (await getInvoiceByPeriod(db(), ws, PERIOD))!;
      expect(draft).toMatchObject({ status: "draft", subtotalCents: 2900 });
      expect(draft.lastError).toMatch(/provider_unavailable/);
      const ok = await generateInvoice(db(), { provider, now: new Date(NOW.getTime() + 3_600_000), netDays: 14 }, ws, PERIOD);
      expect(ok).toMatchObject({ status: "ok", created: false, providerCalled: true });
      const open = (await getInvoiceByPeriod(db(), ws, PERIOD))!;
      expect(open).toMatchObject({ id: draft.id, digest: draft.digest, status: "open" });
      expect(open.lastError).toBeUndefined();
      expect(provider.distinctInvoices).toBe(1);
    });

    it("keeps a draft when no provider is configured", async () => {
      const ws = newWorkspace();
      await assignPlan(db(), { workspaceId: ws, planId: "builder", actor: "op" });
      const r = await generateInvoice(db(), { now: NOW, netDays: 14 }, ws, PERIOD);
      expect(r).toMatchObject({ status: "ok", providerCalled: false, note: "provider_not_configured" });
    });

    it("closes the period's usage once invoiced", async () => {
      const { ws } = await openInvoice();
      expect(await collectUsage(db(), ws, PERIOD, NOW)).toMatchObject({ closed: true, written: 0 });
      await seedResource(db(), ws, { createdAt: "2026-03-20T00:00:00Z" });
      expect(await collectUsage(db(), ws, PERIOD, NOW)).toMatchObject({ closed: true });
      expect(await upsertUsage(db(), { workspaceId: ws, meter: "build_minutes", sourceId: "late", period: PERIOD, quantity: 5, unit: "minute", estimated: false })).toBe("closed");
      await expect(db().query(
        "insert into platform.billing_usage_events (id, workspace_id, meter, source_id, period, quantity, unit) values ($1, $2, 'build_minutes', 'raw', $3, 1, 'minute')", [`use_${hex(6)}`, ws, PERIOD]
      )).rejects.toThrow(/closed/);
    });

    it("makes invoice content immutable and refuses deletion", async () => {
      const { ws, invoice } = await openInvoice();
      await expect(db().query("update platform.billing_invoices set subtotal_cents = 1, version = version + 1 where workspace_id = $1 and id = $2", [ws, invoice.id])).rejects.toThrow(/immutable/);
      await expect(db().query("update platform.billing_invoices set status = 'void', version = version + 1 where workspace_id = $1 and id = $2", [ws, invoice.id])).resolves.toBeDefined();
      await expect(db().query("delete from platform.billing_invoices where workspace_id = $1", [ws])).rejects.toThrow(/retained/);
    });
  });

  /* ---------------------------------- webhooks ---------------------------------- */

  describe("payment webhook ingestion and reconciliation", () => {
    const envFor = (secret: string, extra: Record<string, string> = {}) => ({ ...STUB_BILLING, ZENITH_BILLING_STRIPE_WEBHOOK_SECRET: secret, ZENITH_BILLING_GRACE_DAYS: "14", ...extra });
    const deliver = (secret: string, raw: string, header: string | null, atMs = NOW.getTime(), env = envFor(secret)) =>
      handleStripeWebhook(raw, header, { env, sql: async () => db(), now: () => new Date(atMs) });
    const webhookCount = async (): Promise<number> => Number((await db().query<{ n: string }>("select count(*) as n from platform.billing_webhook_events"))[0].n);

    it("is a 404 that does no other work when billing is disabled", async () => {
      const r = await handleStripeWebhook("{}", "t=1,v1=00", { env: {}, sql: async () => { throw new Error("no store"); } });
      expect(r).toMatchObject({ status: 404, body: { error: { code: "billing_disabled" } } });
    });

    it("authenticates by signature before parsing or touching the store", async () => {
      const { invoice } = await openInvoice();
      const secret = webhookSecret();
      const good = invoiceEvent("invoice.paid", invoice, secret, NOW.getTime());
      const before = await webhookCount();
      const forbidden = { env: envFor(secret), sql: async () => { throw new Error("must not be reached"); }, now: () => NOW };
      expect(await handleStripeWebhook(good.raw, null, forbidden)).toMatchObject({ status: 400, body: { error: { code: "invalid_signature" } } });
      expect(await handleStripeWebhook(good.raw + " ", good.header, forbidden)).toMatchObject({ status: 400 });
      expect(await handleStripeWebhook(good.raw, invoiceEvent("invoice.paid", invoice, webhookSecret(), NOW.getTime()).header, forbidden)).toMatchObject({ status: 400 });
      expect(await handleStripeWebhook(good.raw, good.header, { ...forbidden, now: () => new Date(NOW.getTime() + 10 * 60_000) })).toMatchObject({ status: 400 });
      expect(await handleStripeWebhook(good.raw, good.header, { ...forbidden, env: { ...STUB_BILLING } })).toMatchObject({ status: 503, body: { error: { code: "webhook_not_configured" } } });
      expect(await webhookCount()).toBe(before);
      expect((await getInvoiceByPeriod(db(), invoice.workspaceId, PERIOD))?.status).toBe("open");
    });

    it("rejects a signed body that is not an event", async () => {
      const secret = webhookSecret();
      const { signStripePayload } = await import("@/lib/billing/stripe");
      for (const body of ["not json", "[]", JSON.stringify({ id: "x y", type: "t", created: 1, data: { object: {} } }), JSON.stringify({ id: "evt_1", type: "t", created: 1 })]) {
        const header = signStripePayload(secret, body, Math.floor(NOW.getTime() / 1000));
        expect(await deliver(secret, body, header)).toMatchObject({ status: 400, body: { error: { code: "invalid_event" } } });
      }
    });

    it("applies a payment, records it and keeps the account active", async () => {
      const { ws, invoice } = await openInvoice();
      const secret = webhookSecret();
      const e = invoiceEvent("invoice.payment_succeeded", invoice, secret, NOW.getTime());
      expect(await deliver(secret, e.raw, e.header)).toEqual({ status: 200, body: { received: true, duplicate: false, outcome: "applied" } });
      const paid = (await getInvoiceByPeriod(db(), ws, PERIOD))!;
      expect(paid).toMatchObject({ status: "paid", amountPaidCents: 2900 });
      expect(paid.paidAt).toBeTruthy();
      expect((await getAccount(db(), ws))?.status).toBe("active");
    });

    it("treats a redelivered event id as a no-op, even many times at once", async () => {
      const { ws, invoice } = await openInvoice();
      const secret = webhookSecret();
      const e = invoiceEvent("invoice.paid", invoice, secret, NOW.getTime());
      const results = await Promise.all(Array.from({ length: 5 }, () => deliver(secret, e.raw, e.header)));
      expect(results.filter((r) => r.status === 200 && !r.body.duplicate)).toHaveLength(1);
      expect(results.filter((r) => r.status === 200 && r.body.duplicate)).toHaveLength(4);
      const row = await db().query<{ n: string }>("select count(*) as n from platform.billing_webhook_events where stripe_event_id = $1", [e.id]);
      expect(Number(row[0].n)).toBe(1);
      const after = (await getInvoiceByPeriod(db(), ws, PERIOD))!;
      expect((await deliver(secret, e.raw, e.header)).body).toMatchObject({ duplicate: true });
      expect((await getInvoiceByPeriod(db(), ws, PERIOD))?.version).toBe(after.version);
    });

    it("ignores a second, different event for an invoice that is already paid", async () => {
      const { ws, invoice } = await openInvoice();
      const secret = webhookSecret();
      const first = invoiceEvent("invoice.paid", invoice, secret, NOW.getTime());
      await deliver(secret, first.raw, first.header);
      const version = (await getInvoiceByPeriod(db(), ws, PERIOD))!.version;
      const second = invoiceEvent("invoice.payment_succeeded", invoice, secret, NOW.getTime());
      expect((await deliver(secret, second.raw, second.header)).body).toMatchObject({ outcome: "ignored" });
      const late = invoiceEvent("invoice.payment_failed", invoice, secret, NOW.getTime());
      expect((await deliver(secret, late.raw, late.header)).body).toMatchObject({ outcome: "ignored" });
      expect(await getInvoiceByPeriod(db(), ws, PERIOD)).toMatchObject({ status: "paid", version });
      expect((await getAccount(db(), ws))?.status).toBe("active");
    });

    it("moves the account past due on a failed payment, counts attempts once each and ignores a stale failure", async () => {
      const { ws, invoice } = await openInvoice();
      const secret = webhookSecret();
      const t0 = Math.floor(NOW.getTime() / 1000);
      const first = invoiceEvent("invoice.payment_failed", invoice, secret, NOW.getTime(), { createdSec: t0 });
      expect((await deliver(secret, first.raw, first.header)).body).toMatchObject({ outcome: "applied" });
      expect(await getInvoiceByPeriod(db(), ws, PERIOD)).toMatchObject({ status: "failed", attempts: 1 });
      expect(await getAccount(db(), ws)).toMatchObject({ status: "past_due" });
      const stale = invoiceEvent("invoice.payment_failed", invoice, secret, NOW.getTime(), { createdSec: t0 - 60 });
      expect((await deliver(secret, stale.raw, stale.header)).body).toMatchObject({ outcome: "ignored" });
      const retry = invoiceEvent("invoice.payment_failed", invoice, secret, NOW.getTime(), { createdSec: t0 + 60 });
      expect((await deliver(secret, retry.raw, retry.header)).body).toMatchObject({ outcome: "applied" });
      expect((await getInvoiceByPeriod(db(), ws, PERIOD))?.attempts).toBe(2);
    });

    it("lets a payment win over an earlier failure however the events arrive, and lifts past due", async () => {
      const { ws, invoice } = await openInvoice();
      const secret = webhookSecret();
      const failed = invoiceEvent("invoice.payment_failed", invoice, secret, NOW.getTime());
      await deliver(secret, failed.raw, failed.header);
      expect((await getAccount(db(), ws))?.status).toBe("past_due");
      const paid = invoiceEvent("invoice.paid", invoice, secret, NOW.getTime(), { createdSec: Math.floor(NOW.getTime() / 1000) - 3600 });
      expect((await deliver(secret, paid.raw, paid.header)).body).toMatchObject({ outcome: "applied" });
      expect(await getInvoiceByPeriod(db(), ws, PERIOD)).toMatchObject({ status: "paid" });
      expect(await getAccount(db(), ws)).toMatchObject({ status: "active" });
      const kinds = (await listAccountEvents(db(), ws)).map((e) => e.kind);
      expect(kinds).toContain("past_due");
      expect(kinds).toContain("payment_received");
    });

    it("refuses to mark an invoice paid when the paid amount does not match", async () => {
      const { ws, invoice } = await openInvoice();
      const secret = webhookSecret();
      for (const amountPaid of [invoice.subtotalCents - 1, invoice.subtotalCents + 1, 0]) {
        const e = invoiceEvent("invoice.paid", invoice, secret, NOW.getTime(), { amountPaid });
        expect((await deliver(secret, e.raw, e.header)).body).toMatchObject({ outcome: "amount_mismatch" });
      }
      expect((await getInvoiceByPeriod(db(), ws, PERIOD))?.status).toBe("open");
    });

    it("rejects an event whose metadata names another workspace, no workspace, or another currency", async () => {
      const { ws, invoice } = await openInvoice();
      const other = await openInvoice();
      const secret = webhookSecret();
      const cases = [
        invoiceEvent("invoice.paid", invoice, secret, NOW.getTime(), { metadataWorkspace: other.ws }),
        invoiceEvent("invoice.paid", invoice, secret, NOW.getTime(), { metadataWorkspace: null }),
        invoiceEvent("invoice.paid", invoice, secret, NOW.getTime(), { currency: "eur" }),
      ];
      for (const e of cases) expect((await deliver(secret, e.raw, e.header)).body).toMatchObject({ outcome: "rejected" });
      expect((await getInvoiceByPeriod(db(), ws, PERIOD))?.status).toBe("open");
      expect((await getInvoiceByPeriod(db(), other.ws, PERIOD))?.status).toBe("open");
    });

    it("records but does not act on an unknown invoice or an unrelated event type", async () => {
      const { invoice } = await openInvoice();
      const secret = webhookSecret();
      const stranger = invoiceEvent("invoice.paid", { ...invoice, stripeInvoiceId: `in_${hex(6)}`, id: `inv_${hex(4)}` }, secret, NOW.getTime());
      expect((await deliver(secret, stranger.raw, stranger.header)).body).toMatchObject({ outcome: "unmatched" });
      const unrelated = invoiceEvent("customer.created", invoice, secret, NOW.getTime());
      expect((await deliver(secret, unrelated.raw, unrelated.header)).body).toMatchObject({ outcome: "ignored" });
      const finalized = invoiceEvent("invoice.finalized", invoice, secret, NOW.getTime());
      expect((await deliver(secret, finalized.raw, finalized.header)).body).toMatchObject({ outcome: "ignored" });
    });

    it("adopts a provider invoice whose id our draft never recorded (crash between the provider call and the update)", async () => {
      const ws = newWorkspace();
      await assignPlan(db(), { workspaceId: ws, planId: "builder", actor: "op" });
      await seedMarch(ws);
      const r = await generateInvoice(db(), { now: NOW, netDays: 14 }, ws, PERIOD);
      expect(r).toMatchObject({ note: "provider_not_configured" });
      const draft = (await getInvoiceByPeriod(db(), ws, PERIOD))!;
      expect(draft.status).toBe("draft");
      const secret = webhookSecret();
      const e = invoiceEvent("invoice.paid", { ...draft, stripeInvoiceId: `in_${hex(6)}`, stripeCustomerId: `cus_${hex(6)}` }, secret, NOW.getTime());
      expect((await deliver(secret, e.raw, e.header)).body).toMatchObject({ outcome: "applied" });
      expect(await getInvoiceByPeriod(db(), ws, PERIOD)).toMatchObject({ status: "paid", stripeInvoiceId: expect.stringMatching(/^in_/) });
    });

    it("stores the digest and outcome of an event, never its payload", async () => {
      const { invoice } = await openInvoice();
      const secret = webhookSecret();
      const e = invoiceEvent("invoice.paid", invoice, secret, NOW.getTime());
      await deliver(secret, e.raw, e.header);
      const rows = await db().query<Record<string, unknown>>("select * from platform.billing_webhook_events where stripe_event_id = $1", [e.id]);
      expect(Object.keys(rows[0]).sort()).toEqual(["event_type", "outcome", "payload_sha256", "received_at", "stripe_created", "stripe_event_id", "workspace_id"]);
      expect(rows[0]).toMatchObject({ outcome: "applied", workspace_id: invoice.workspaceId });
      expect(String(rows[0].payload_sha256)).toMatch(/^[0-9a-f]{64}$/);
      await expect(db().query("update platform.billing_webhook_events set outcome = 'ignored' where stripe_event_id = $1", [e.id])).rejects.toThrow(/final/);
      await expect(db().query("delete from platform.billing_webhook_events where stripe_event_id = $1", [e.id])).rejects.toThrow(/retained/);
    });
  });

  /* ------------------------- dunning and safe suspension ------------------------- */

  describe("dunning and safe suspension", () => {
    const GRACE = { graceDays: 14 };
    const SECRET_ENV = (secret: string) => ({ ...STUB_BILLING, ZENITH_BILLING_STRIPE_WEBHOOK_SECRET: secret, ZENITH_BILLING_GRACE_DAYS: "14" });

    it("walks active -> past due -> suspended from durable invoices, on the schedule, and lifts on payment", async () => {
      const { ws, invoice } = await openInvoice();
      const due = new Date(invoice.dueAt!).getTime();
      const events = async () => (await listAccountEvents(db(), ws)).map((e) => e.kind).reverse();

      await runDunning(db(), GRACE, new Date(due - DAY));
      expect((await getAccount(db(), ws))?.status).toBe("active");
      await runDunning(db(), GRACE, new Date(due + 1000));
      expect(await getAccount(db(), ws)).toMatchObject({ status: "past_due", pastDueSince: new Date(due).toISOString() });
      await runDunning(db(), GRACE, new Date(due + 13 * DAY));
      expect((await getAccount(db(), ws))?.status).toBe("past_due");
      const suspendedAt = new Date(due + 14 * DAY);
      const r = await runDunning(db(), GRACE, suspendedAt);
      expect(r.suspended).toBeGreaterThanOrEqual(1);
      expect(await getAccount(db(), ws)).toMatchObject({ status: "suspended", suspensionReason: "nonpayment", suspendedAt: suspendedAt.toISOString() });
      expect(await events()).toEqual(["plan_assigned", "past_due", "suspended"]);

      // level-triggered: another pass changes nothing and records nothing
      const again = await reconcileStanding(db(), ws, GRACE, new Date(due + 20 * DAY));
      expect(again).toMatchObject({ status: "suspended", changed: false });
      expect(await events()).toEqual(["plan_assigned", "past_due", "suspended"]);

      const secret = webhookSecret();
      const e = invoiceEvent("invoice.paid", invoice, secret, due + 21 * DAY);
      const out = await handleStripeWebhook(e.raw, e.header, { env: SECRET_ENV(secret), sql: async () => db(), now: () => new Date(due + 21 * DAY) });
      expect(out).toMatchObject({ status: 200, body: { outcome: "applied" } });
      expect(await getAccount(db(), ws)).toMatchObject({ status: "active" });
      expect((await getAccount(db(), ws))?.suspensionReason).toBeUndefined();
      expect((await events()).slice(-1)).toEqual(["reinstated"]);
    });

    it("honours a zero-day grace and suspends exactly at the due date", async () => {
      const { ws, invoice } = await openInvoice();
      const due = new Date(invoice.dueAt!).getTime();
      await reconcileStanding(db(), ws, { graceDays: 0 }, new Date(due - 1));
      expect((await getAccount(db(), ws))?.status).toBe("active");
      await reconcileStanding(db(), ws, { graceDays: 0 }, new Date(due));
      expect((await getAccount(db(), ws))?.status).toBe("suspended");
    });

    it("starts the grace clock at the oldest unpaid due date, and a partly settled account drops back to past due", async () => {
      const ws = newWorkspace();
      await assignPlan(db(), { workspaceId: ws, planId: "builder", actor: "op" });
      await seedMarch(ws);
      const provider = new FakeInvoiceProvider();
      await generateInvoice(db(), { provider, now: NOW, netDays: 14 }, ws, PERIOD);
      await seedResource(db(), ws, { createdAt: "2026-04-01T00:00:00Z" });
      const may = new Date("2026-05-02T12:00:00Z");
      await generateInvoice(db(), { provider, now: may, netDays: 14 }, ws, "2026-04");
      const [aprilInv, marchInv] = await listInvoices(db(), ws);
      expect([aprilInv.period, marchInv.period]).toEqual(["2026-04", PERIOD]);
      const farFuture = new Date(new Date(marchInv.dueAt!).getTime() + 30 * DAY);
      await reconcileStanding(db(), ws, GRACE, farFuture);
      expect((await getAccount(db(), ws))?.status).toBe("suspended");
      // March is paid; April (due later) is still within its grace window relative to farFuture
      await db().query("update platform.billing_invoices set status = 'paid', paid_at = clock_timestamp(), amount_paid_cents = subtotal_cents, version = version + 1 where workspace_id = $1 and id = $2", [ws, marchInv.id]);
      const r = await reconcileStanding(db(), ws, GRACE, new Date(new Date(aprilInv.dueAt!).getTime() + DAY));
      expect(r).toMatchObject({ status: "past_due", changed: true });
    });

    it("applies an operator suspension that no payment and no dunning pass lifts, until an operator reinstates", async () => {
      const { ws, invoice } = await openInvoice();
      const s = await suspendWorkspace(db(), { workspaceId: ws, actor: "op_9", reason: "abuse review", now: NOW });
      expect(s).toMatchObject({ status: "suspended", suspensionReason: "operator" });
      const secret = webhookSecret();
      const e = invoiceEvent("invoice.paid", invoice, secret, NOW.getTime());
      await handleStripeWebhook(e.raw, e.header, { env: SECRET_ENV(secret), sql: async () => db(), now: () => NOW });
      await runDunning(db(), GRACE, new Date(NOW.getTime() + 60 * DAY));
      expect(await getAccount(db(), ws)).toMatchObject({ status: "suspended", suspensionReason: "operator" });
      const r = await reinstateWorkspace(db(), { workspaceId: ws, actor: "op_9", reason: "review closed", now: NOW });
      expect(r?.status).toBe("active");
      const events = await listAccountEvents(db(), ws);
      expect(events[0]).toMatchObject({ kind: "reinstated", actor: "op_9", reason: "review closed" });
    });

    it("writes nothing for a no-op standing change and nothing for a workspace without an account", async () => {
      const ws = newWorkspace();
      await assignPlan(db(), { workspaceId: ws, planId: "explore", actor: "op" });
      const before = (await listAccountEvents(db(), ws)).length;
      const r = await applyStanding(db(), { workspaceId: ws, target: { status: "active" }, actor: "x", eventKind: "reinstated", now: NOW });
      expect(r).toMatchObject({ changed: false });
      expect((await listAccountEvents(db(), ws)).length).toBe(before);
      expect(await reinstateWorkspace(db(), { workspaceId: newWorkspace(), actor: "op", reason: "x", now: NOW })).toBeNull();
      expect(await reconcileStanding(db(), newWorkspace(), GRACE, NOW)).toBeNull();
    });

    it("NEVER deletes data: every retained table keeps every row through suspension, export and reinstatement", async () => {
      const { ws, invoice } = await openInvoice();
      await collectUsage(db(), ws, "2026-04", NOW);
      const before = await retainedCounts(db(), ws);
      expect(before.resources).toBeGreaterThan(0);
      expect(before.operations).toBeGreaterThan(0);
      await suspendWorkspace(db(), { workspaceId: ws, actor: "op", reason: "test", now: NOW });
      await runDunning(db(), GRACE, new Date(new Date(invoice.dueAt!).getTime() + 90 * DAY));
      await buildTenantExport(db(), { workspaceId: ws, billing: "managed", now: NOW });
      await expect(assertBillingAdmitted({ workspaceId: ws, kind: "deploy" }, { env: STUB_BILLING, store: async () => db(), ttlMs: 0 })).rejects.toBeInstanceOf(BackpressureError);
      await reinstateWorkspace(db(), { workspaceId: ws, actor: "op", reason: "test", now: NOW });
      const after = await retainedCounts(db(), ws);
      for (const [table, n] of Object.entries(before)) expect(after[table], table).toBeGreaterThanOrEqual(n);
      // the live resources are exactly as seeded: suspension did not stop, hide or mark anything
      const statuses = await db().query<{ status: string }>("select status from platform.resources where workspace_id = $1 order by id", [ws]);
      expect(statuses.map((s) => s.status).sort()).toEqual(["active", "active", "active", "deleted", "deleted", "planned"].sort());
    });

    it("has no delete path in SQL for any billing record", async () => {
      const { ws } = await openInvoice();
      await suspendWorkspace(db(), { workspaceId: ws, actor: "op", reason: "x", now: NOW });
      for (const table of ["billing_accounts", "billing_account_events", "billing_invoices", "billing_usage_events"]) {
        await expect(db().query(`delete from platform.${table} where workspace_id = $1`, [ws]), table).rejects.toThrow(/retained|append-only/);
      }
      await expect(db().query("update platform.billing_account_events set reason = 'edited' where workspace_id = $1", [ws])).rejects.toThrow(/append-only/);
    });
  });

  /* ------------------------------- dispatch admission ------------------------------- */

  describe("admission of new work", () => {
    const opts = (extra: Record<string, unknown> = {}) => ({ env: STUB_BILLING, store: async () => db(), ttlMs: 0, ...extra });
    const refused = async (ws: string, kind: string, o = opts()) => assertBillingAdmitted({ workspaceId: ws, kind }, o).then(() => undefined, (e: unknown) => e);

    it("refuses new provisioning work for a suspended workspace with 402, but never export or destroy", async () => {
      const ws = newWorkspace();
      await assignPlan(db(), { workspaceId: ws, planId: "builder", actor: "op" });
      await suspendWorkspace(db(), { workspaceId: ws, actor: "op", reason: "x", now: NOW });
      for (const kind of ["deploy", "dayTwo", "remediation", "runner_job"]) {
        const e = await refused(ws, kind);
        expect(e, kind).toBeInstanceOf(BackpressureError);
        expect(e).toMatchObject({ code: "billing_suspended", status: 402, layer: "billing", tenant: ws });
        expect((e as BackpressureError).message).toMatch(/nothing was deleted/i);
      }
      for (const kind of ["export", "destroy"]) expect(await refused(ws, kind), kind).toBeUndefined();
    });

    it("says why: operator versus unpaid invoice", async () => {
      const { ws, invoice } = await openInvoice();
      await reconcileStanding(db(), ws, { graceDays: 0 }, new Date(new Date(invoice.dueAt!).getTime() + 1000));
      expect(((await refused(ws, "deploy")) as BackpressureError).message).toMatch(/unpaid invoice/);
      await suspendWorkspace(db(), { workspaceId: ws, actor: "op", reason: "x", now: NOW });
      expect(((await refused(ws, "deploy")) as BackpressureError).message).toMatch(/platform operator/);
    });

    it("lets work through again after reinstatement and never touches another workspace", async () => {
      const a = newWorkspace();
      const b = newWorkspace();
      await assignPlan(db(), { workspaceId: a, planId: "builder", actor: "op" });
      await assignPlan(db(), { workspaceId: b, planId: "builder", actor: "op" });
      await suspendWorkspace(db(), { workspaceId: a, actor: "op", reason: "x", now: NOW });
      expect(await refused(a, "deploy")).toBeInstanceOf(BackpressureError);
      expect(await refused(b, "deploy")).toBeUndefined();
      await reinstateWorkspace(db(), { workspaceId: a, actor: "op", reason: "x", now: NOW });
      expect(await refused(a, "deploy")).toBeUndefined();
    });

    it("does not suspend a past-due workspace: past due is a notice, not a refusal", async () => {
      const { ws, invoice } = await openInvoice();
      await reconcileStanding(db(), ws, { graceDays: 14 }, new Date(new Date(invoice.dueAt!).getTime() + 1000));
      expect((await getAccount(db(), ws))?.status).toBe("past_due");
      expect(await refused(ws, "deploy")).toBeUndefined();
    });

    it("holds a workspace to its plan's cap on queued and running operations, excluding the one being started", async () => {
      const ws = newWorkspace();
      await assignPlan(db(), { workspaceId: ws, planId: "builder", actor: "op" });
      const ops: Awaited<ReturnType<typeof seedOperation>>[] = [];
      for (let i = 0; i < 15; i++) ops.push(await seedOperation(db(), ws, { status: "queued" }));
      const e = await refused(ws, "deploy");
      expect(e).toMatchObject({ code: "plan_quota_exceeded", status: 429, layer: "billing" });
      expect(await assertBillingAdmitted({ workspaceId: ws, kind: "deploy", operationId: ops[0].id }, opts())).toBeUndefined();
      expect(await refused(ws, "destroy")).toBeUndefined();
      expect(await refused(ws, "export")).toBeUndefined();
    });

    it("refuses new work once a plan's hard usage cap is reached, without any charge, and a plan without a cap keeps going", async () => {
      const builder = newWorkspace();
      const team = newWorkspace();
      const enterprise = newWorkspace();
      await assignPlan(db(), { workspaceId: builder, planId: "builder", actor: "op" });
      await assignPlan(db(), { workspaceId: team, planId: "team", actor: "op" });
      await assignPlan(db(), { workspaceId: enterprise, planId: "enterprise", actor: "op" });
      const period = periodOf(new Date());
      for (const ws of [builder, team, enterprise]) await upsertUsage(db(), { workspaceId: ws, meter: "build_minutes", sourceId: "b", period, quantity: 1001, unit: "minute", estimated: false });
      const e = await refused(builder, "deploy");
      expect(e).toMatchObject({ code: "plan_quota_exceeded", status: 429 });
      expect((e as BackpressureError).message).toMatch(/build minutes/);
      expect(await refused(team, "deploy")).toBeUndefined();
      expect(await refused(enterprise, "deploy")).toBeUndefined();
      expect(await refused(builder, "export")).toBeUndefined();
      expect(await refused(builder, "destroy")).toBeUndefined();
      // a cap is an admission refusal, never a charge: the period's invoice for that usage is still just the minimum
      await upsertUsage(db(), { workspaceId: builder, meter: "storage_gb_month", sourceId: "s", period: PERIOD, quantity: 49, unit: "GB", estimated: false });
      await upsertUsage(db(), { workspaceId: builder, meter: "build_minutes", sourceId: "b2", period: PERIOD, quantity: 5000, unit: "minute", estimated: false });
      const r = await generateInvoice(db(), { now: NOW, netDays: 14 }, builder, PERIOD);
      expect(r).toMatchObject({ status: "ok" });
      if (r.status === "ok") expect(r.invoice.subtotalCents).toBe(2900);
    });

    it("refuses Explore every non-exempt kind with plan_feature_unavailable (402, feature deploy) and still allows export and destroy", async () => {
      const ws = newWorkspace();
      await assignPlan(db(), { workspaceId: ws, planId: "explore", actor: "op" });
      for (const kind of ["deploy", "dayTwo", "remediation", "runner_job"]) {
        const e = await refused(ws, kind);
        expect(e, kind).toBeInstanceOf(BackpressureError);
        expect(e).toMatchObject({ code: "plan_feature_unavailable", status: 402, layer: "billing", tenant: ws, detail: { feature: "deploy" } });
        expect((e as BackpressureError).message).toMatch(/Explore does not include application deployment/);
        expect((e as BackpressureError).message).toMatch(/Builder includes it/);
      }
      for (const kind of ["export", "destroy"]) expect(await refused(ws, kind), kind).toBeUndefined();
      // an unassigned workspace keeps today's fail-closed answer rather than a guess at its plan
      expect(await refused(newWorkspace(), "deploy")).toMatchObject({ code: "billing_unavailable", status: 503 });
    });

    it("admits Builder, Team and Enterprise, and a stored legacy id gets the entitlements of the plan it maps to", async () => {
      for (const planId of ["builder", "team", "enterprise"]) {
        const ws = newWorkspace();
        await assignPlan(db(), { workspaceId: ws, planId, actor: "op" });
        for (const kind of ["deploy", "dayTwo", "remediation", "runner_job", "export", "destroy"]) expect(await refused(ws, kind), `${planId} ${kind}`).toBeUndefined();
      }
      const legacyFree = newWorkspace();
      const legacyTeam = newWorkspace();
      await db().query("insert into platform.billing_accounts (workspace_id, plan_id, assigned_by) values ($1, 'free_provisional', 'legacy'), ($2, 'team_provisional', 'legacy')", [legacyFree, legacyTeam]);
      expect(await refused(legacyFree, "deploy")).toMatchObject({ code: "plan_feature_unavailable" });
      expect(await refused(legacyTeam, "deploy")).toBeUndefined();
    });

    it("applies no entitlement check at all while billing is disabled", async () => {
      const ws = newWorkspace();
      await assignPlan(db(), { workspaceId: ws, planId: "explore", actor: "op" });
      for (const env of [{}, { ZENITH_BILLING: "disabled" }]) {
        for (const kind of ["deploy", "dayTwo", "remediation", "runner_job"]) {
          await expect(assertBillingAdmitted({ workspaceId: ws, kind }, { env, store: async () => { throw new Error("store touched"); } })).resolves.toBeUndefined();
        }
      }
    });

    it("never counts an estimated or informational meter against a quota", async () => {
      const ws = newWorkspace();
      await assignPlan(db(), { workspaceId: ws, planId: "builder", actor: "op" });
      const period = periodOf(new Date());
      await upsertUsage(db(), { workspaceId: ws, meter: "egress_gb_estimated", sourceId: "env", period, quantity: 1e9, unit: "GB", estimated: true });
      await upsertUsage(db(), { workspaceId: ws, meter: "operations_executed", sourceId: "ops", period, quantity: 1e9, unit: "operation", estimated: false });
      expect(await refused(ws, "deploy")).toBeUndefined();
    });

    it("fails closed on a store outage without mutating suspension or running workloads", async () => {
      const outage = async () => { throw new Error("store down"); };
      const fresh = newWorkspace();
      expect(await refused(fresh, "deploy", opts({ store: outage }))).toMatchObject({ code: "billing_unavailable", status: 503 });
      for (const kind of ["destroy", "export"]) expect(await refused(fresh, kind, opts({ store: outage }))).toBeUndefined();
      const held = newWorkspace();
      await assignPlan(db(), { workspaceId: held, planId: "builder", actor: "op" });
      await suspendWorkspace(db(), { workspaceId: held, actor: "op", reason: "x", now: NOW });
      expect(await refused(held, "deploy")).toBeInstanceOf(BackpressureError);
      expect(await refused(held, "deploy", opts({ store: outage }))).toBeInstanceOf(BackpressureError);
    });

    it("is wired into assertDispatchAdmitted for the real dispatch callers (and export passes through it)", async () => {
      if (lane.name === "postgres" && process.env.ZENITH_TEST_OPS_EXCLUSIVE_PG !== "1") return;
      vi.stubEnv("ZENITH_BILLING", "managed");
      setOpsRuntimeForTests(buildRuntime(opsLimitsFromEnv({ ZENITH_OPS_MAINTENANCE_CACHE_MS: "0" }), async () => db()));
      const ws = newWorkspace();
      await assignPlan(db(), { workspaceId: ws, planId: "builder", actor: "op" });
      await suspendWorkspace(db(), { workspaceId: ws, actor: "op", reason: "x", now: NOW });
      await expect(assertDispatchAdmitted({ workspaceId: ws, kind: "deploy", operationId: "op_1" })).rejects.toMatchObject({ code: "billing_suspended", status: 402 });
      await expect(assertDispatchAdmitted({ workspaceId: ws, kind: "dayTwo", operationId: "op_2" })).rejects.toMatchObject({ code: "billing_suspended" });
      await expect(assertDispatchAdmitted({ workspaceId: ws, kind: "export", operationId: "op_3" })).resolves.toBeUndefined();
      await expect(assertDispatchAdmitted({ workspaceId: ws, kind: "destroy", operationId: "op_4" })).resolves.toBeUndefined();
    });
  });

  /* ------------------------------- billing: disabled ------------------------------- */

  describe("billing: disabled bypasses every billing path", () => {
    it("admits everything with no store access, even for a workspace the store says is suspended", async () => {
      const ws = newWorkspace();
      await assignPlan(db(), { workspaceId: ws, planId: "explore", actor: "op" });
      await suspendWorkspace(db(), { workspaceId: ws, actor: "op", reason: "x", now: NOW });
      for (const env of [{}, { ZENITH_BILLING: "disabled" }, { ZENITH_BILLING: "typo" }]) {
        for (const kind of ["deploy", "dayTwo", "remediation", "runner_job", "export", "destroy"]) {
          await expect(assertBillingAdmitted({ workspaceId: ws, kind }, { env, store: async () => { throw new Error("store touched"); } })).resolves.toBeUndefined();
        }
      }
    });

    it("runs no scheduled work and touches no store", async () => {
      expect(await runBillingTick(forbiddenSql, { env: {}, now: NOW })).toEqual({ enabled: false });
      expect(await runBillingTick(forbiddenSql, { env: { ZENITH_BILLING: "disabled" }, now: NOW })).toEqual({ enabled: false });
    });

    it("lets dispatch through assertDispatchAdmitted for a suspended workspace", async () => {
      if (lane.name === "postgres" && process.env.ZENITH_TEST_OPS_EXCLUSIVE_PG !== "1") return;
      vi.stubEnv("ZENITH_BILLING", "");
      setOpsRuntimeForTests(buildRuntime(opsLimitsFromEnv({ ZENITH_OPS_MAINTENANCE_CACHE_MS: "0" }), async () => db()));
      const ws = newWorkspace();
      await assignPlan(db(), { workspaceId: ws, planId: "explore", actor: "op" });
      await suspendWorkspace(db(), { workspaceId: ws, actor: "op", reason: "x", now: NOW });
      invalidateBillingState();
      await expect(assertDispatchAdmitted({ workspaceId: ws, kind: "deploy", operationId: "op_1" })).resolves.toBeUndefined();
    });

    it("still exports the tenant's records, without any billing section", async () => {
      const ws = newWorkspace();
      await seedMarch(ws);
      const bundle = await buildTenantExport(db(), { workspaceId: ws, billing: "disabled", now: NOW });
      expect(Object.keys(bundle.sections).sort()).toEqual(["cost_estimates", "operations", "portability_exports", "resources"]);
      expect(bundle.manifest.billing).toBe("disabled");
      expect(bundle.sections.resources.length).toBe(6);
    });
  });

  /* ---------------------------------- tenant export ---------------------------------- */

  describe("tenant export", () => {
    it("is complete, scrubbed, tenant-scoped, bounded and digest-checked, and works while suspended", async () => {
      const ws = newWorkspace();
      const other = newWorkspace();
      await assignPlan(db(), { workspaceId: ws, planId: "builder", actor: "op" });
      await seedMarch(ws);
      const otherResource = await seedResource(db(), other, { createdAt: "2026-03-01T00:00:00Z" });
      const akia = `AKIA${"A".repeat(16)}`;
      const leaky = `res_${hex(6)}`;
      await db().query(
        `insert into platform.resources (id, workspace_id, environment_id, address, kind, provider, native_type, ownership, spec_digest, spec)
         values ($1, $2, 'env_billing', $3, 'container_service', 'aws', 'aws:ecs_service', 'managed', $4, $5::text::jsonb)`,
        [leaky, ws, `container_service/${hex(4)}`, "a".repeat(64), JSON.stringify({ note: akia })]);
      await collectUsage(db(), ws, PERIOD, NOW);
      await generateInvoice(db(), { provider: new FakeInvoiceProvider(), now: NOW, netDays: 14 }, ws, PERIOD);
      await suspendWorkspace(db(), { workspaceId: ws, actor: "op", reason: "nonpayment drill", now: NOW });

      const bundle = await buildTenantExport(db(), { workspaceId: ws, billing: "managed", now: NOW });
      const text = JSON.stringify(bundle);
      expect(bundle.manifest).toMatchObject({ kind: "zenith_tenant_export", version: 1, workspaceId: ws, billing: "managed" });
      expect(bundle.manifest.digest).toMatch(/^[0-9a-f]{64}$/);
      expect(bundle.manifest.notice).toMatch(/launch pricing.*not live/i);
      expect(bundle.sections.resources).toHaveLength(7);
      expect(bundle.sections.billing_invoices).toHaveLength(1);
      expect((bundle.sections.billing_account as { status: string }[])[0].status).toBe("suspended");
      expect(bundle.sections.billing_usage.length).toBeGreaterThan(0);
      expect(bundle.sections.portability_exports).toHaveLength(2);
      expect(text).not.toContain(akia);
      expect(text).toContain("[redacted]");
      expect(text).not.toContain(otherResource);
      expect(bundle.manifest.sections.every((s) => !s.truncated)).toBe(true);
      // a digest that a copy can be checked against, stable across repeated exports of unchanged data
      expect((await buildTenantExport(db(), { workspaceId: ws, billing: "managed", now: new Date(NOW.getTime() + 1000) })).manifest.digest).toBe(bundle.manifest.digest);
    });

    it("says when a section hit its bound instead of silently stopping", async () => {
      const ws = newWorkspace();
      await seedResource(db(), ws, { createdAt: "2026-03-01T00:00:00Z" });
      await seedResource(db(), ws, { createdAt: "2026-03-01T00:00:00Z" });
      const bundle = await buildTenantExport(db(), { workspaceId: ws, billing: "disabled", now: NOW, limit: 1 });
      expect(bundle.sections.resources).toHaveLength(1);
      expect(bundle.manifest.sections.find((s) => s.name === "resources")).toMatchObject({ count: 1, truncated: true });
    });
  });

  /* ------------------------------ read model and tick ------------------------------ */

  describe("billing view and scheduled pass", () => {
    it("shows the decided plan and all four packages, usage against allowances and invoices; an unassigned workspace sees the default plan", async () => {
      const { ws } = await openInvoice();
      const view = await billingView(db(), ws, NOW);
      expect(view).toMatchObject({ mode: "managed", provisional: false, pricingDecision: { decision: "DEC-BUSINESS", approvedAt: "2026-10-13" }, assigned: true, period: "2026-04", account: { planId: "builder", status: "active" } });
      expect(view.plan).toMatchObject({ provisional: false, id: "builder" });
      expect(view.packages.map((p) => p.id)).toEqual(["explore", "builder", "team", "enterprise"]);
      expect(view.zcuDefinition).toMatch(/one resource managed by Zenith for one hour/);
      expect(view.notice).toMatch(/not live/i);
      expect(view.usage.find((u) => u.meter === "build_minutes")).toMatchObject({ included: 1000, hardCap: 1000, charged: false });
      expect(view.usage.find((u) => u.meter === "managed_resource_hours")).toMatchObject({ unit: "ZCU-hour", charged: true });
      expect(view.usage.find((u) => u.meter === "egress_gb_estimated")).toMatchObject({ charged: false, estimated: true });
      expect(view.invoices).toHaveLength(1);
      expect(view.whatSuspensionMeans).toMatch(/never deletes/i);
      const unassigned = await billingView(db(), newWorkspace(), NOW);
      expect(unassigned).toMatchObject({ assigned: false, account: null, plan: { id: "explore" } });
    });

    it("collects, invoices the ended period once and runs dunning, repeatably", async () => {
      const ws = newWorkspace();
      await assignPlan(db(), { workspaceId: ws, planId: "builder", actor: "op" });
      await seedMarch(ws);
      const provider = new FakeInvoiceProvider();
      const deps = { env: { ...STUB_BILLING, ZENITH_BILLING_GRACE_DAYS: "14" }, provider, now: NOW };
      const first = await runBillingTick(db(), deps);
      expect(first).toMatchObject({ enabled: true, invoicing: "fake_contract_level" });
      const invoice = (await getInvoiceByPeriod(db(), ws, PERIOD))!;
      expect(invoice).toMatchObject({ status: "open", subtotalCents: 2900 });
      const calls = provider.calls.length;
      const second = await runBillingTick(db(), deps);
      expect(second).toMatchObject({ enabled: true, invoicesCreated: 0, invoicesOpened: 0 });
      expect(provider.calls.length).toBe(calls);
      expect((await getInvoiceByPeriod(db(), ws, PERIOD))?.version).toBe(invoice.version);
      // a pass long after the due date and grace suspends nonpayment, and says so
      const late = await runBillingTick(db(), { ...deps, now: new Date(new Date(invoice.dueAt!).getTime() + 15 * DAY) });
      expect(late).toMatchObject({ enabled: true });
      expect((await getAccount(db(), ws))?.status).toBe("suspended");
    });

    it("waits out the settle window before invoicing a period that just ended", async () => {
      const ws = newWorkspace();
      await assignPlan(db(), { workspaceId: ws, planId: "builder", actor: "op" });
      await runBillingTick(db(), { env: STUB_BILLING, provider: new FakeInvoiceProvider(), now: new Date("2026-04-01T01:00:00Z") });
      expect(await getInvoiceByPeriod(db(), ws, PERIOD)).toBeNull();
      await runBillingTick(db(), { env: STUB_BILLING, provider: new FakeInvoiceProvider(), now: new Date("2026-04-01T07:00:00Z") });
      expect(await getInvoiceByPeriod(db(), ws, PERIOD)).not.toBeNull();
    });
  });
});
