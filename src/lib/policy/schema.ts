/**
 * Runtime schemas for the policy boundary (ADR-0008).
 *
 * Two documents cross the wasm boundary and both are validated, strictly, on
 * the way in and out:
 *   - `PolicyInputSchema` — what the broker hands the engine. Unknown keys are
 *     rejected (a typo such as `autonomyLevl` must fail closed rather than be
 *     silently ignored by the Rego rules), every list and string is bounded, and
 *     region names are constrained to a conservative character set because they
 *     are echoed into decision reasons that people and models read.
 *   - `PolicyDecisionSchema` — what the wasm returns. A decision that does not
 *     match (an unknown outcome, `require_approval` without an approval, an
 *     approval on a deny, extra keys) is treated as an evaluation failure, never
 *     interpreted.
 *
 * The schemas validate shape and bounds only. They do not consult the
 * capability catalog; the engine does that separately.
 */
import { z } from "zod";
import type { PolicyDecision, PolicyInput, WorkspacePolicyParams } from "./types";

const ENVIRONMENT_CLASSES = ["sandbox", "development", "staging", "production"] as const;
const MAX_LIST = 5000;

export const EnvironmentClassSchema = z.enum(ENVIRONMENT_CLASSES);

/** A cloud region / location name: lowercase letters, digits, dashes. */
export const RegionSchema = z
  .string()
  .min(2)
  .max(40)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "region names are lowercase letters, digits and dashes");

const shortString = z.string().min(1).max(1024);
const addressList = z.array(shortString).max(MAX_LIST);
const nonNegativeInt = z.number().int().min(0).max(1_000_000);

const AutoRemediationModeSchema = z.enum(["none", "safe", "any"]);

/** The shape of a fully resolved workspace policy, as the policy engine consumes it. */
export const WorkspacePolicyParamsSchema = z
  .object({
    approvedRegions: z.array(RegionSchema).max(200).optional(),
    costApprovalThresholdUsd: z.number().finite().min(0).max(1e12),
    budgetUsdMonthly: z.number().finite().min(0).max(1e12).optional(),
    allowEscapeHatchInProduction: z.boolean(),
    twoPersonProduction: z.boolean(),
    autoRemediation: z
      .object({
        sandbox: AutoRemediationModeSchema,
        development: AutoRemediationModeSchema,
        staging: AutoRemediationModeSchema,
        production: AutoRemediationModeSchema,
      })
      .strict(),
    deniedCapabilities: z.array(z.string().min(1).max(100)).max(500),
  })
  .strict();

const PlanFactsSchema = z
  .object({
    create: nonNegativeInt,
    update: nonNegativeInt,
    delete: nonNegativeInt,
    replace: nonNegativeInt,
    destroysData: z.boolean(),
    destroyedStatefulAddresses: addressList,
    statefulDeletes: addressList.optional(),
    dnsDeletes: addressList.optional(),
    regions: z.array(RegionSchema).max(200),
    publicDatabases: addressList,
    openIngress: z
      .array(
        z
          .object({
            address: shortString,
            port: z.string().regex(/^(?:all|unknown|\d{1,5}(?:-\d{1,5})?)$/),
            cidr: z.string().min(1).max(64),
          })
          .strict()
      )
      .max(MAX_LIST),
    wildcardIam: addressList,
    identityChanges: addressList,
    firewallChanges: addressList,
    dnsChanges: addressList,
    unresolved: addressList.optional(),
    costDeltaUsdMonthly: z.number().finite().optional(),
    projectedMonthlyUsd: z.number().finite().optional(),
  })
  .strict();

const AutonomyLevelSchema = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]);
const IdSchema = z.string().min(1).max(200);

export const PolicyInputSchema = z
  .object({
    version: z.literal(1),
    request: z
      .object({
        capability: z.string().min(1).max(100),
        risk: z.enum(["low", "medium", "high", "critical"]),
        mutates: z.boolean(),
        destructive: z.boolean(),
        escapeHatch: z.boolean(),
        defaultAutonomy: z.number().int().min(0).max(6),
        integrationScope: z.enum(["read", "plan", "logs", "write", "publish"]).optional(),
        scope: z
          .object({
            workspaceId: IdSchema,
            projectId: IdSchema.optional(),
            environmentId: IdSchema.optional(),
            resourceId: IdSchema.optional(),
          })
          .strict(),
        requestedDurationSec: z.number().int().min(1).max(31_536_000).optional(),
        constraints: z.record(z.string(), z.union([z.string().max(1000), z.number().finite(), z.boolean(), z.null()])).optional(),
      })
      .strict(),
    principal: z
      .object({
        kind: z.enum(["user", "integration", "navigator", "system", "runner", "machine"]),
        id: IdSchema,
        role: z.enum(["viewer", "editor", "admin", "none"]),
        integrationScopes: z.array(z.string().min(1).max(50)).max(50).optional(),
      })
      .strict(),
    environment: z
      .object({
        id: IdSchema,
        class: EnvironmentClassSchema,
        autonomyLevel: AutonomyLevelSchema,
        provider: z.string().min(1).max(100),
        region: z.string().max(100),
      })
      .strict()
      .optional(),
    resource: z
      .object({
        address: z.string().min(1).max(2048),
        kind: z.string().min(1).max(200),
        stateful: z.boolean(),
        ownership: z.enum(["managed", "referenced", "external"]),
        publiclyExposed: z.boolean(),
      })
      .strict()
      .optional(),
    plan: PlanFactsSchema.optional(),
    workspacePolicy: WorkspacePolicyParamsSchema,
    context: z
      .object({
        now: z.string().datetime({ offset: true }),
        origin: z.enum(["human", "agent", "navigator", "system", "reconciler"]),
      })
      .strict(),
  })
  .strict();

const ReasonSchema = z
  .object({
    code: z.string().min(1).max(100),
    message: z.string().min(1).max(2000),
    rule: z.string().min(1).max(200).optional(),
  })
  .strict();

const ApprovalSchema = z
  .object({
    count: z.number().int().min(1).max(10),
    minRole: z.enum(["editor", "admin"]),
    separationOfDuties: z.boolean(),
  })
  .strict();

/** The decision the wasm returns; `refine` enforces the outcome/approval/constraint coupling. */
export const PolicyDecisionSchema = z
  .object({
    outcome: z.enum(["allow", "deny", "require_approval"]),
    reasons: z.array(ReasonSchema).min(1).max(200),
    approval: ApprovalSchema.optional(),
    constraints: z.record(z.string(), z.union([z.string(), z.number().finite(), z.boolean()])).optional(),
  })
  .strict()
  .superRefine((decision, ctx) => {
    if (decision.outcome === "require_approval" && !decision.approval) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "require_approval without an approval requirement", path: ["approval"] });
    }
    if (decision.outcome !== "require_approval" && decision.approval) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "approval requirement on a decision that is not require_approval", path: ["approval"] });
    }
    if (decision.outcome === "deny" && decision.constraints) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "constraints on a denial", path: ["constraints"] });
    }
  });

/* Compile-time checks: the schemas produce exactly the contract types. */
export type ParsedPolicyInput = z.infer<typeof PolicyInputSchema>;
export const asPolicyInput = (parsed: ParsedPolicyInput): PolicyInput => parsed;
export const asWorkspacePolicy = (parsed: z.infer<typeof WorkspacePolicyParamsSchema>): WorkspacePolicyParams => parsed;
export const asPolicyDecision = (parsed: z.infer<typeof PolicyDecisionSchema>): PolicyDecision => parsed;
