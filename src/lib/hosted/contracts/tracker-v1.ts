/**
 * Tracker data contract v1 — the one fixed, reviewed record type hosted apps
 * may read and write in month one: an equipment request.
 *
 * Frozen. Additive changes bump `TRACKER_SCHEMA_VERSION` and ship a migration
 * that only adds nullable columns; destructive changes are rejected at intake.
 *
 * Wire paths (reserved on every app host, served by the fixed broker, never by
 * app code):
 *
 *   GET    /_zenith/session
 *   GET    /_zenith/data/v1/requests?limit=&cursor=&status=&category=  → 200 ListRequestsResult
 *   GET    /_zenith/data/v1/requests/:id         → 200 { record } | 404 not_found
 *   POST   /_zenith/data/v1/requests            { writeId, record }        → 201 { record }
 *   PATCH  /_zenith/data/v1/requests/:id        { writeId, expectedVersion, patch } → 200 { record } | 409 stale_version
 *
 * Roles: owner/editor/viewer may read; owner/editor may create and update;
 * viewer gets `forbidden` on every mutation regardless of HTTP verb. There is no
 * delete in v1 — decline the request instead.
 *
 * Import from `@/lib/hosted/contracts`.
 */
import { z } from "zod";

export const TRACKER_SCHEMA_VERSION = 1 as const;

export const RequestCategory = z.enum([
  "laptop",
  "monitor",
  "peripheral",
  "software",
  "furniture",
  "other",
]);
export type RequestCategory = z.infer<typeof RequestCategory>;

export const RequestPriority = z.enum(["low", "normal", "high"]);
export type RequestPriority = z.infer<typeof RequestPriority>;

export const RequestStatus = z.enum(["requested", "approved", "ordered", "delivered", "declined"]);
export type RequestStatus = z.infer<typeof RequestStatus>;

export const TRACKER_LIMITS = {
  title: 120,
  details: 2000,
  requestedFor: 120,
  quantityMax: 99,
  listMax: 100,
  listDefault: 25,
  /** how long a write id replays the original result */
  writeIdRetentionMs: 30 * 24 * 60 * 60_000,
} as const;

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be a calendar date, YYYY-MM-DD")
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), "must be a real date");

/** Field rules without defaults: a patch must never fill in defaults for fields it does not name. */
const RequestFields = {
  title: z.string().trim().min(1).max(TRACKER_LIMITS.title),
  details: z.string().trim().max(TRACKER_LIMITS.details),
  category: RequestCategory,
  quantity: z.number().int().min(1).max(TRACKER_LIMITS.quantityMax),
  priority: RequestPriority,
  status: RequestStatus,
  /** who the item is for; free text, not an identity */
  requestedFor: z.string().trim().max(TRACKER_LIMITS.requestedFor),
  neededBy: isoDate.nullable(),
};

export const EquipmentRequestInput = z
  .object({
    ...RequestFields,
    details: RequestFields.details.prefault(""),
    quantity: RequestFields.quantity.prefault(1),
    priority: RequestFields.priority.prefault("normal"),
    status: RequestFields.status.prefault("requested"),
    requestedFor: RequestFields.requestedFor.prefault(""),
    neededBy: RequestFields.neededBy.prefault(null),
  })
  .strict();
export type EquipmentRequestInput = z.infer<typeof EquipmentRequestInput>;

// zod 4 applies an inner default inside .partial()/.optional(); zod 3 did not. Build the patch from undefaulted fields.
export const EquipmentRequestPatch = z.object(RequestFields).partial().strict();
export type EquipmentRequestPatch = z.infer<typeof EquipmentRequestPatch>;

export interface EquipmentRequest extends EquipmentRequestInput {
  id: string;
  /** starts at 1; every committed update increments it */
  version: number;
  createdBy: string;
  createdByEmail: string;
  createdAt: string;
  updatedBy: string;
  updatedByEmail: string;
  updatedAt: string;
}

const uuid = z.string().guid();

export const CreateRequestBody = z
  .object({ writeId: uuid, record: EquipmentRequestInput })
  .strict();
export type CreateRequestBody = z.infer<typeof CreateRequestBody>;

export const UpdateRequestBody = z
  .object({
    writeId: uuid,
    expectedVersion: z.number().int().min(1),
    patch: EquipmentRequestPatch,
  })
  .strict();
export type UpdateRequestBody = z.infer<typeof UpdateRequestBody>;

export const ListRequestsQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(TRACKER_LIMITS.listMax).prefault(TRACKER_LIMITS.listDefault),
    cursor: z.string().max(200).optional(),
    status: RequestStatus.optional(),
    category: RequestCategory.optional(),
  })
  .strict();
export type ListRequestsQuery = z.infer<typeof ListRequestsQuery>;

export interface ListRequestsResult {
  items: EquipmentRequest[];
  nextCursor?: string;
}

/** Body of a 409 `stale_version`: the caller re-bases on `current` and retries with a new writeId. */
export interface StaleVersionDetails extends Record<string, unknown> {
  expectedVersion: number;
  current: EquipmentRequest;
}

/** What `/_zenith/session` answers for an admitted request. */
export interface SessionInfo {
  subject: string;
  email: string;
  role: "owner" | "editor" | "viewer";
  app: { id: string; slug: string; name: string };
  /** where the recipient came from and where a revoked/expired session can send them back */
  controlOrigin: string;
  releaseId: string;
  schemaVersion: typeof TRACKER_SCHEMA_VERSION;
  limits: { listMax: number; bodyBytes: number };
  expiresAt: string;
}

/**
 * Canonical intent hash input for a write: the broker hashes
 * `JSON.stringify(canonicalWriteIntent(...))` with SHA-256 and stores it with
 * the write id, so a replay with different content is refused.
 */
export function canonicalWriteIntent(
  op: "create" | "update",
  appId: string,
  subject: string,
  recordId: string | null,
  body: unknown
): Record<string, unknown> {
  return { v: TRACKER_SCHEMA_VERSION, op, appId, subject, recordId, body };
}
