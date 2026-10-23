/**
 * Payment-webhook ingestion and idempotent reconciliation (PROD-MAN-06).
 *
 * `handleStripeWebhook` is the whole pipeline behind the route, in this order:
 *
 *   1. managed mode only (otherwise `disabled`, with no other work);
 *   2. the RAW body is bounded and its signature verified against the endpoint secret BEFORE it is parsed or any store is
 *      touched (an unsigned, stale or mis-signed request is a 400/503 and nothing else happens);
 *   3. the verified body is parsed and shape-checked;
 *   4. one transaction records the event id (first writer wins), matches it to OUR invoice, applies the settlement move
 *      and re-derives the workspace's standing. A redelivered or replayed event id changes nothing.
 *
 * Reconciliation rules: an invoice is matched by the provider invoice id AND must carry our workspace id in its metadata
 * (a cross-tenant or foreign invoice is `rejected`); `paid` requires the provider's `amount_paid` to equal the invoice's
 * recorded total (otherwise `amount_mismatch`, not paid); `paid` is terminal and a stale `failed` after it is ignored; a
 * `paid` event arriving before the failure that preceded it still wins. The payload is not stored, only its digest.
 */
import { z } from "zod";
import type { Sql } from "@/lib/controlplane/types";
import { sha256Hex } from "@/lib/controlplane/digest";
import { billingConfigFromEnv, type Env } from "./config";
import { reconcileStanding } from "./standing";
import { verifyStripeSignature, type SignatureFailure } from "./stripe";
import {
  beginWebhookEvent, finishWebhookEvent, findInvoiceByProviderId, getInvoice, markInvoiceOpen, transitionInvoice,
  type Invoice, type WebhookOutcome,
} from "./store";

export const WEBHOOK_MAX_BYTES = 256 * 1024;

const EventSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_]{1,100}$/),
  type: z.string().min(1).max(120),
  created: z.number().int().min(0).max(4_000_000_000),
  data: z.object({ object: z.record(z.string(), z.unknown()) }),
}).passthrough();
export type StripeEvent = z.infer<typeof EventSchema>;

const PAID = new Set(["invoice.paid", "invoice.payment_succeeded"]);
const FAILED = new Set(["invoice.payment_failed", "invoice.marked_uncollectible"]);
const VOID = new Set(["invoice.voided"]);

export type IngestResult = { status: "duplicate" } | { status: "processed"; outcome: WebhookOutcome; workspaceId?: string; invoiceStatus?: Invoice["status"] };

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

/** Apply one verified event. Idempotent on `event.id`. Everything here is one database transaction. */
export async function ingestStripeEvent(sql: Sql, event: StripeEvent, rawBody: string | Buffer, graceDays: number, now: Date): Promise<IngestResult> {
  return sql.tx(async (tx) => {
    const first = await beginWebhookEvent(tx, { id: event.id, type: event.type, payloadSha256: sha256Hex(typeof rawBody === "string" ? rawBody : new Uint8Array(rawBody)), created: event.created });
    if (!first) return { status: "duplicate" } as const;
    const done = async (outcome: WebhookOutcome, invoice?: Invoice): Promise<IngestResult> => {
      await finishWebhookEvent(tx, event.id, outcome, invoice?.workspaceId);
      return { status: "processed", outcome, ...(invoice ? { workspaceId: invoice.workspaceId, invoiceStatus: invoice.status } : {}) };
    };

    const kind = PAID.has(event.type) ? "paid" : FAILED.has(event.type) ? "failed" : VOID.has(event.type) ? "void" : undefined;
    if (!kind) return done("ignored");
    const obj = event.data.object;
    const providerInvoiceId = str(obj.id);
    if (!providerInvoiceId) return done("rejected");
    const metadata = (obj.metadata && typeof obj.metadata === "object" ? obj.metadata : {}) as Record<string, unknown>;
    const metaWorkspace = str(metadata.zenith_workspace_id);
    const metaInvoice = str(metadata.zenith_invoice_id);

    let invoice = await findInvoiceByProviderId(tx, providerInvoiceId);
    if (!invoice && metaWorkspace && metaInvoice) {
      // Crash window: the provider invoice exists but our `draft` row never recorded its id. Adopt it, bound to the same workspace.
      const draft = await getInvoice(tx, metaWorkspace, metaInvoice);
      const customer = str(obj.customer);
      if (draft?.status === "draft" && customer && /^[A-Za-z0-9_]{1,100}$/.test(providerInvoiceId) && /^[A-Za-z0-9_]{1,100}$/.test(customer)) {
        invoice = await markInvoiceOpen(tx, metaWorkspace, metaInvoice, { stripeInvoiceId: providerInvoiceId, stripeCustomerId: customer });
      }
    }
    if (!invoice) return done("unmatched");
    if (metaWorkspace !== invoice.workspaceId || (obj.currency !== undefined && obj.currency !== "usd")) return done("rejected");

    if (kind === "paid") {
      const paid = obj.amount_paid;
      if (typeof paid !== "number" || !Number.isInteger(paid) || paid !== invoice.subtotalCents) return done("amount_mismatch", invoice);
    }
    const moved = await transitionInvoice(tx, invoice.workspaceId, invoice.id, {
      to: kind, eventCreated: event.created, now,
      ...(kind === "paid" ? { amountPaidCents: obj.amount_paid as number } : {}),
    });
    await reconcileStanding(tx, invoice.workspaceId, { graceDays }, now, "system:stripe-webhook");
    const fresh = (await getInvoice(tx, invoice.workspaceId, invoice.id)) ?? moved?.invoice ?? invoice;
    return done(moved?.applied ? "applied" : "ignored", fresh);
  });
}

export type WebhookResponse =
  | { status: 200; body: { received: true; duplicate: boolean; outcome?: WebhookOutcome } }
  | { status: 400 | 404 | 413 | 503; body: { error: { code: string; message: string } } };

const refuse = (status: 400 | 404 | 413 | 503, code: string, message: string): WebhookResponse => ({ status, body: { error: { code, message } } });

export interface WebhookDeps {
  env?: Env;
  sql: () => Promise<Sql>;
  now?: () => Date;
}

const REASON_STATUS: Record<SignatureFailure, 400 | 503> = {
  missing_header: 400, malformed_header: 400, timestamp_outside_tolerance: 400, no_matching_signature: 400, secret_not_configured: 503,
};

/** The route's whole body of work, given the raw bytes and the signature header. Pure of HTTP types so it is tested directly. */
export async function handleStripeWebhook(raw: string, signatureHeader: string | null, deps: WebhookDeps): Promise<WebhookResponse> {
  const env = deps.env ?? process.env;
  const cfg = billingConfigFromEnv(env);
  if (cfg.mode !== "managed") return refuse(404, "billing_disabled", "Billing is not enabled on this installation.");
  if (Buffer.byteLength(raw, "utf8") > WEBHOOK_MAX_BYTES) return refuse(413, "payload_too_large", "The webhook body is too large.");
  const now = deps.now?.() ?? new Date();
  const verified = verifyStripeSignature({ secret: env.ZENITH_BILLING_STRIPE_WEBHOOK_SECRET?.trim(), header: signatureHeader, payload: raw, nowMs: now.getTime() });
  if (!verified.ok) {
    return refuse(REASON_STATUS[verified.reason], verified.reason === "secret_not_configured" ? "webhook_not_configured" : "invalid_signature",
      verified.reason === "secret_not_configured" ? "The webhook signing secret is not configured." : "The webhook signature is missing, malformed, stale or does not match.");
  }
  let parsed: StripeEvent;
  try { parsed = EventSchema.parse(JSON.parse(raw)); } catch { return refuse(400, "invalid_event", "The webhook body is not a valid event."); }
  const result = await ingestStripeEvent(await deps.sql(), parsed, raw, cfg.graceDays, now);
  return result.status === "duplicate"
    ? { status: 200, body: { received: true, duplicate: true } }
    : { status: 200, body: { received: true, duplicate: false, outcome: result.outcome } };
}
