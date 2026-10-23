/**
 * Runbook definitions (PROD-MACH-03).
 *
 * A runbook is an ordered list of STEPS. Each step is one semantic machine
 * operation with fully static, schema-validated arguments (`parseMachineArgs`),
 * so the effect a human approves is exactly the effect that runs: there is no
 * templating, no shell string and no argument that is resolved at run time.
 *
 * Classification is by OPERATION, never by command text. `machine.exec` and
 * `container.exec` are the raw escape hatch: they are always classified
 * `critical`/escape-hatch and always need explicit approval. Nothing here (or
 * anywhere in the runbook module) inspects an argv to decide a command is
 * "safe": argv parsing is not a sandbox, and an arbitrary command is unclassified.
 */
import { z } from "zod";
import { digest } from "@/lib/controlplane/digest";
import { capability } from "@/lib/capabilities/catalog";
import { credentialPatternsIn } from "@/lib/credentials/redact";
import { IMPLEMENTED_OPERATIONS, MachineTargetSchema, describeIssues, isImplementedOperation, parseMachineArgs } from "../args";
import { DEFAULT_MAX_OUTPUT_BYTES, DEFAULT_TIMEOUT_SEC, MAX_OUTPUT_BYTES, MAX_TIMEOUT_SEC } from "../limits";
import type { MachineOperation, MachineTarget } from "../types";

export const RUNBOOK_SCHEMA_VERSION = 1;
export const MAX_RUNBOOK_STEPS = 32;
export const MAX_RUNBOOK_TARGETS = 25;
export const MAX_PARALLEL_TARGETS = 5;
/** hard ceiling for one run, regardless of definition or window */
export const MAX_RUN_DURATION_SEC = 6 * 60 * 60;
export const RUNBOOK_ID_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const STEP_ID_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;

/** Operations that run caller-supplied command lines. Never auto-classified as safe. */
export const ESCAPE_HATCH_OPERATIONS: ReadonlySet<MachineOperation> = new Set<MachineOperation>(["machine.exec", "container.exec"]);

export const RunbookStepSchema = z
  .object({
    id: z.string().regex(STEP_ID_RE, "step id must match [a-z0-9][a-z0-9_-]{0,47}"),
    title: z.string().min(1).max(200),
    operation: z.enum(IMPLEMENTED_OPERATIONS as [MachineOperation, ...MachineOperation[]]),
    args: z.record(z.string(), z.unknown()),
    timeoutSec: z.number().int().min(1).max(MAX_TIMEOUT_SEC).prefault(DEFAULT_TIMEOUT_SEC),
    maxOutputBytes: z.number().int().min(1).max(MAX_OUTPUT_BYTES).prefault(DEFAULT_MAX_OUTPUT_BYTES),
    /** `abort` stops the remaining steps on that target; `continue` records the failure and goes on */
    onFailure: z.enum(["abort", "continue"]).prefault("abort"),
  })
  .strict();

export const RunbookDefinitionSchema = z
  .object({
    schemaVersion: z.literal(RUNBOOK_SCHEMA_VERSION),
    name: z.string().min(1).max(120),
    description: z.string().max(2000).prefault(""),
    steps: z.array(RunbookStepSchema).min(1).max(MAX_RUNBOOK_STEPS),
  })
  .strict();

export type RunbookStep = z.output<typeof RunbookStepSchema>;
export type RunbookDefinition = z.output<typeof RunbookDefinitionSchema>;

export type RunbookErrorCode =
  | "invalid_definition"
  | "invalid_binding"
  | "signature_invalid"
  | "not_found"
  | "conflict"
  | "approval_required"
  | "approval_invalid"
  | "outside_window"
  | "forbidden";

export class RunbookError extends Error {
  readonly code: RunbookErrorCode;
  readonly issues: readonly string[];
  constructor(code: RunbookErrorCode, message: string, issues: readonly string[] = []) {
    super(message);
    this.name = "RunbookError";
    this.code = code;
    this.issues = issues;
  }
}

/**
 * Validate and normalise a definition. Step args are parsed with the SAME schema the
 * executor uses and the PARSED form is stored, so the signed bytes are the executed bytes.
 * Credential-looking values are refused: a runbook is signed, stored and audited in clear.
 */
export function parseRunbookDefinition(raw: unknown): RunbookDefinition {
  const parsed = RunbookDefinitionSchema.safeParse(raw);
  if (!parsed.success) throw new RunbookError("invalid_definition", "The runbook definition is invalid.", describeIssues(parsed.error));
  const def = parsed.data;
  const seen = new Set<string>();
  const issues: string[] = [];
  const steps = def.steps.map((step, i) => {
    if (seen.has(step.id)) issues.push(`steps.${i}.id: duplicate step id`);
    seen.add(step.id);
    if (!isImplementedOperation(step.operation)) {
      issues.push(`steps.${i}.operation: not implemented`);
      return step;
    }
    const args = parseMachineArgs(step.operation, step.args);
    if (!args.ok) {
      issues.push(...args.issues.map((m) => `steps.${i}.args.${m}`));
      return step;
    }
    if (credentialPatternsIn(JSON.stringify(args.args)).length) issues.push(`steps.${i}.args: contains credential-like material; reference secrets, never embed them`);
    const argTimeout = (args.args as { timeoutSec?: unknown }).timeoutSec;
    if (typeof argTimeout === "number" && argTimeout > step.timeoutSec) issues.push(`steps.${i}.timeoutSec: smaller than the command's own timeoutSec`);
    return { ...step, args: args.args as Record<string, unknown> };
  });
  if (issues.length) throw new RunbookError("invalid_definition", "The runbook definition is invalid.", issues.slice(0, 16));
  return { ...def, steps };
}

/** SHA-256 over the canonical normalised definition: the identity a signature binds. */
export function definitionDigest(def: RunbookDefinition): string {
  return digest({ v: RUNBOOK_SCHEMA_VERSION, def });
}

export type RunbookRisk = "low" | "medium" | "high" | "critical";
export interface RunbookClassification {
  risk: RunbookRisk;
  /** steps that run a raw command line; always unclassified, always need approval */
  escapeHatchSteps: string[];
  mutatingSteps: string[];
  /** catalog capabilities every step will need a broker grant for */
  capabilities: string[];
  /** read-only runbooks may run without run-level approval; everything else may not */
  requiresApproval: boolean;
  /** constant: nothing in this module analyses command text to call it safe */
  argvClassification: "never_classified_safe";
}

const RISK_RANK: Record<RunbookRisk, number> = { low: 0, medium: 1, high: 2, critical: 3 };

export function classifyRunbook(def: RunbookDefinition): RunbookClassification {
  let risk: RunbookRisk = "low";
  const escapeHatchSteps: string[] = [];
  const mutatingSteps: string[] = [];
  const caps = new Set<string>();
  for (const step of def.steps) {
    const cap = capability(step.operation);
    caps.add(cap.name);
    let stepRisk = cap.risk as RunbookRisk;
    if (ESCAPE_HATCH_OPERATIONS.has(step.operation) || cap.escapeHatch) {
      escapeHatchSteps.push(step.id);
      stepRisk = "critical";
    }
    if (cap.mutates) mutatingSteps.push(step.id);
    if (RISK_RANK[stepRisk] > RISK_RANK[risk]) risk = stepRisk;
  }
  return {
    risk,
    escapeHatchSteps,
    mutatingSteps,
    capabilities: [...caps].sort(),
    requiresApproval: escapeHatchSteps.length > 0 || mutatingSteps.length > 0,
    argvClassification: "never_classified_safe",
  };
}

/* --------------------------------- targets --------------------------------- */

/**
 * A run target is a machine the grant can be scoped to: it MUST carry a
 * `resourceId` (resource-level capabilities refuse unscoped grants). The
 * workspace is taken from the run, never from the target.
 */
export const RunbookTargetSchema = MachineTargetSchema.omit({ workspaceId: true }).extend({ resourceId: z.string().min(1).max(128) }).strict();
export type RunbookTarget = z.output<typeof RunbookTargetSchema>;

export function parseRunbookTargets(raw: unknown): RunbookTarget[] {
  const parsed = z.array(RunbookTargetSchema).min(1).max(MAX_RUNBOOK_TARGETS).safeParse(raw);
  if (!parsed.success) throw new RunbookError("invalid_binding", `Targets must be 1 to ${MAX_RUNBOOK_TARGETS} resource-scoped machines.`, describeIssues(parsed.error));
  const keys = new Set<string>();
  for (const t of parsed.data) {
    const k = `${t.transport}\0${t.targetId}`;
    if (keys.has(k)) throw new RunbookError("invalid_binding", "Targets must be unique.");
    keys.add(k);
  }
  // canonical order makes the binding digest independent of how the caller listed them
  return [...parsed.data].sort((a, b) => (`${a.transport}\0${a.targetId}` < `${b.transport}\0${b.targetId}` ? -1 : 1));
}

export function machineTargetFor(workspaceId: string, t: RunbookTarget): MachineTarget {
  return MachineTargetSchema.parse({ workspaceId, ...t }) as MachineTarget;
}
