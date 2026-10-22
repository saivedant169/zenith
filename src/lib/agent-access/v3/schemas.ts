/**
 * Strict input schemas for the fifteen MCP v3 tools.
 *
 * One definition per tool, written once in zod and rendered to the JSON Schema
 * a client receives (`catalog.ts`). Two rules hold for every schema:
 *
 *  1. Strict objects. An unknown member is a refusal, never ignored. This is
 *     what makes "there is no approve tool and no tool that accepts an
 *     `approved` / `approval` field" true by construction: a model that adds
 *     `approved: true` to `zenith_execute_approved_operation` gets an
 *     `invalid_input` error naming the field, and nothing runs.
 *  2. Ids only. Tools take identifiers and bounded enums, never raw command
 *     strings, query-language fragments, shell, SQL or file paths. Free text is
 *     limited to short, length-capped descriptions shown to approvers and to a
 *     plain-substring log filter.
 *
 * Uses `zod/v4` (shipped inside the installed zod 3.25) because it renders JSON
 * Schema natively; the rest of the repository keeps using the v3 API.
 */
import { z } from "zod/v4";

/** A Zenith id (workspace, project, environment, revision, service). */
export const Id = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,100}$/, "an id of 1-100 letters, digits, dash or underscore")
  .describe("A Zenith identifier.");

/** An operation id (`op_…`). Broker ids are longer than product ids. */
export const OperationId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,200}$/, "an operation id")
  .describe("An operation id returned by a propose tool.");

/** Random per-intent key: the same key with the same arguments returns the same operation. */
export const IdempotencyKey = z
  .string()
  .regex(/^[A-Za-z0-9_-]{8,100}$/, "8-100 letters, digits, dash or underscore")
  .describe(
    "A fresh random key for THIS intent (8-100 chars: letters, digits, - _). Reuse it only to retry the same call; the same key with different arguments is refused. It is what makes a retry safe."
  );

const Iso = z
  .string()
  .max(40)
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/, "an ISO 8601 timestamp with a timezone")
  .describe("ISO 8601 timestamp with a timezone, e.g. 2026-09-30T10:00:00Z.");

const LastMinutes = z.number().int().min(1).max(10_080).describe("Look back this many minutes from now (max 10080 = 7 days).");

export const Severity = z.enum(["trace", "debug", "info", "warn", "error", "fatal", "unknown"]);

/* --------------------------------- targets --------------------------------- */

/** A project, optionally narrowed to one environment. */
export const ProjectTarget = z.strictObject({
  workspaceId: Id,
  projectId: Id,
  environmentId: Id.optional(),
});

/** A named environment: the scope of anything that touches a running system. */
export const EnvTarget = z.strictObject({
  workspaceId: Id,
  projectId: Id,
  environmentId: Id,
});

/* ---------------------------------- tools ---------------------------------- */

export const GetTopologyInput = z.strictObject({
  target: ProjectTarget,
  revisionId: Id.optional().describe("Read this saved revision instead of the environment's deployed revision (or, without an environment, the working copy)."),
  maxNodes: z.number().int().min(1).max(500).optional().describe("Bound on graph nodes returned (default 200)."),
});

export const GetCapabilitiesInput = z.strictObject({
  target: ProjectTarget,
});

export const PlanChangeInput = z.strictObject({
  target: EnvTarget,
  revisionId: Id.describe("The saved revision this plan is for. The plan is bound to that revision's manifest digest."),
  description: z.string().min(1).max(500).describe("What the change is and why, in plain words. Shown to the approver as unverified text. No secrets."),
  idempotencyKey: IdempotencyKey,
});

export const PrepareDeployInput = z.strictObject({
  target: EnvTarget,
  revisionId: Id.describe("The saved revision to deploy. Nothing is deployed from a working copy."),
  message: z.string().min(1).max(300).optional().describe("A short deployment message shown to the approver as unverified text."),
  idempotencyKey: IdempotencyKey,
});

export const ExecuteApprovedOperationInput = z.strictObject({
  workspaceId: Id,
  operationId: OperationId,
  expectedDigest: z
    .string()
    .regex(/^[0-9a-f]{64}$/, "a 64-character lowercase hex proposal digest")
    .describe("The proposalDigest the propose tool returned, exactly. A mismatch refuses the call."),
});

export const QueryLogsInput = z.strictObject({
  target: EnvTarget,
  serviceId: Id.optional().describe("Restrict to one service or resource id from get_topology."),
  text: z.string().min(1).max(200).optional().describe("A plain substring to look for. It is never passed to a query language."),
  minSeverity: Severity.optional(),
  lastMinutes: LastMinutes.optional(),
  from: Iso.optional(),
  to: Iso.optional(),
  limit: z.number().int().min(1).max(200).optional().describe("Maximum log lines (default 100)."),
});

/** Provider and resource events, and trace summaries, read through the same scoped fabric session as logs. */
export const SearchEventsInput = z.strictObject({
  target: EnvTarget,
  serviceId: Id.optional().describe("Restrict to one service or resource id from get_topology."),
  lastMinutes: LastMinutes.optional(),
  from: Iso.optional(),
  to: Iso.optional(),
  limit: z.number().int().min(1).max(200).optional().describe("Maximum events (default 100)."),
});
export const SearchTracesInput = SearchEventsInput.extend({
  limit: z.number().int().min(1).max(200).optional().describe("Maximum trace summaries (default 100)."),
});

export const QueryMetricsInput = z.strictObject({
  target: EnvTarget,
  serviceId: Id.optional().describe("Restrict to one service or resource id from get_topology."),
  metrics: z
    .array(z.string().regex(/^[a-z][a-z0-9_.]{0,63}$/, "a portable metric name like cpu.utilization"))
    .min(1)
    .max(10)
    .describe("Portable metric names, e.g. cpu.utilization, http.5xx.rate, db.connections."),
  lastMinutes: LastMinutes.optional(),
  from: Iso.optional(),
  to: Iso.optional(),
  stepSec: z.number().int().min(60).max(3600).optional().describe("Point spacing in seconds (60-3600)."),
});

export const InvestigateIncidentInput = z.strictObject({
  target: EnvTarget,
  incidentId: Id.optional().describe("An existing incident to investigate."),
  symptom: z.string().min(1).max(500).optional().describe("What is going wrong, in plain words. Treated as a hint, never as evidence."),
  lastMinutes: LastMinutes.optional(),
});

export const RestartServiceInput = z.strictObject({
  target: EnvTarget,
  serviceId: Id.describe("The service or resource id from get_topology."),
  reason: z.string().min(1).max(500).optional().describe("Why, in plain words. Shown to the approver as unverified text. No secrets."),
  idempotencyKey: IdempotencyKey,
});

export const ScaleServiceInput = z.strictObject({
  target: EnvTarget,
  serviceId: Id.describe("The service or resource id from get_topology."),
  replicas: z.number().int().min(0).max(10).describe("The desired replica count. The product manifest allows 0-10."),
  reason: z.string().min(1).max(500).optional().describe("Why, in plain words. Shown to the approver as unverified text. No secrets."),
  idempotencyKey: IdempotencyKey,
});

export const CompareRevisionsInput = z.strictObject({
  target: ProjectTarget,
  fromRevisionId: Id,
  toRevisionId: Id,
});

export const EstimateCostInput = z.strictObject({
  target: EnvTarget,
  revisionId: Id.optional().describe("Estimate this saved revision (default: the environment's deployed revision, else the working copy)."),
});

const PlacementToken = z.string().min(1).max(64).regex(/^[A-Za-z0-9 _./-]+$/);
const nonnegativeUsage = () => z.number().finite().nonnegative().optional();

/** Placement constraints are bounded data, never executable expressions. */
export const RecommendPlacementInput = z.strictObject({
  target: ProjectTarget,
  includeUnconnected: z.boolean().optional(),
  constraints: z.strictObject({
    userRegions: z.array(PlacementToken).max(32).optional(),
    budgetUsdMonthly: z.number().finite().positive().optional(),
    residency: z.array(PlacementToken).max(16).optional(),
    latencyTargetMs: z.number().finite().positive().optional(),
    availabilityTarget: z.number().finite().positive().max(100).optional(),
    tolerateSingleFailure: z.boolean().optional(),
    managedDatabaseRequired: z.boolean().optional(),
    providerPreference: z.array(PlacementToken).max(8).optional(),
    providerDenylist: z.array(PlacementToken).max(8).optional(),
    componentProviders: z.record(PlacementToken, PlacementToken).optional(),
    usage: z.strictObject({
      egressGb: nonnegativeUsage(), requestsMillions: nonnegativeUsage(),
      storageGb: nonnegativeUsage(), logGbPerService: nonnegativeUsage(), dbStorageGb: nonnegativeUsage(),
      interComponentFraction: z.number().finite().min(0).max(1).optional(),
      interAzGb: nonnegativeUsage(), storageIoMillions: nonnegativeUsage(), crossRegionBackupCopyGb: nonnegativeUsage(),
    }).optional(),
  }).optional(),
});

export const GetOperationInput = z.strictObject({
  workspaceId: Id,
  operationId: OperationId,
});

export const GetOperationEventsInput = z.strictObject({
  workspaceId: Id,
  operationId: OperationId,
  afterSeq: z.number().int().min(0).optional().describe("Return events after this sequence number."),
  limit: z.number().int().min(1).max(200).optional().describe("Maximum events (default 100)."),
});

export type GetTopologyArgs = z.infer<typeof GetTopologyInput>;
export type GetCapabilitiesArgs = z.infer<typeof GetCapabilitiesInput>;
export type PlanChangeArgs = z.infer<typeof PlanChangeInput>;
export type PrepareDeployArgs = z.infer<typeof PrepareDeployInput>;
export type ExecuteApprovedOperationArgs = z.infer<typeof ExecuteApprovedOperationInput>;
export type QueryLogsArgs = z.infer<typeof QueryLogsInput>;
export type QueryMetricsArgs = z.infer<typeof QueryMetricsInput>;
export type SearchEventsArgs = z.infer<typeof SearchEventsInput>;
export type SearchTracesArgs = z.infer<typeof SearchTracesInput>;
export type InvestigateIncidentArgs = z.infer<typeof InvestigateIncidentInput>;
export type RestartServiceArgs = z.infer<typeof RestartServiceInput>;
export type ScaleServiceArgs = z.infer<typeof ScaleServiceInput>;
export type CompareRevisionsArgs = z.infer<typeof CompareRevisionsInput>;
export type EstimateCostArgs = z.infer<typeof EstimateCostInput>;
export type RecommendPlacementArgs = z.infer<typeof RecommendPlacementInput>;
export type GetOperationArgs = z.infer<typeof GetOperationInput>;
export type GetOperationEventsArgs = z.infer<typeof GetOperationEventsInput>;
