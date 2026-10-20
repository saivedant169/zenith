/**
 * Runbook policy gate and approval binding (PROD-MACH-03). Deterministic code,
 * no model in the loop.
 *
 * The BINDING DIGEST is the immutable effect an approver approves: workspace,
 * runbook, version, the digest of the signed definition, the exact sorted
 * target list, the window(s), the duration/parallelism bounds and, for a
 * schedule, the whole cadence. Change any of them and the approval no longer
 * matches. Approval is per binding, expires, and may not be given by the
 * requester. Every individual step still goes through the capability broker and
 * grant machinery when it executes; this gate is the additional run-level gate.
 *
 * Rules: read-only runbooks need no run-level approval. Anything that mutates,
 * and always anything with a raw-exec step, needs approval. An escape-hatch
 * approval is short-lived (24 h); other approvals last at most 7 days.
 */
import { digest } from "@/lib/controlplane/digest";
import type { RunbookClassification, RunbookTarget } from "./definition";
import type { RunbookApprovalRecord } from "./ports";
import type { RunWindow, ScheduleSpec } from "./schedule";

export const ESCAPE_HATCH_APPROVAL_MAX_SEC = 24 * 3600;
export const STANDARD_APPROVAL_MAX_SEC = 7 * 24 * 3600;

export interface RunBindingInput {
  workspaceId: string;
  runbookId: string;
  version: number;
  definitionDigest: string;
  /** already canonical (sorted) via `parseRunbookTargets` */
  targets: readonly RunbookTarget[];
  maxRunDurationSec: number;
  maxParallelTargets: number;
  /** ad-hoc runs */
  windows?: readonly RunWindow[];
  notAfter?: string;
  /** scheduled runs: the whole spec is part of the approved effect */
  schedule?: ScheduleSpec;
}

export function bindingDigestOf(i: RunBindingInput): string {
  return digest({
    v: 1,
    ws: i.workspaceId,
    rb: i.runbookId,
    ver: i.version,
    def: i.definitionDigest,
    targets: i.targets,
    dur: i.maxRunDurationSec,
    par: i.maxParallelTargets,
    windows: i.windows ?? null,
    notAfter: i.notAfter ?? null,
    schedule: i.schedule ?? null,
  });
}

export type GateOutcome = "allow" | "require_approval";
export interface GateDecision {
  outcome: GateOutcome;
  /** stable code for audit and UI */
  reason: "read_only" | "approved" | "approval_missing" | "approval_expired_or_unbound" | "self_approval";
  highRisk: boolean;
}

export function approvalTtlCapSec(c: RunbookClassification): number {
  return c.escapeHatchSteps.length > 0 ? ESCAPE_HATCH_APPROVAL_MAX_SEC : STANDARD_APPROVAL_MAX_SEC;
}

export function evaluateRunbookGate(args: {
  classification: RunbookClassification;
  /** the newest unexpired approval for exactly this binding digest, if any */
  approval: RunbookApprovalRecord | null;
  requestedBy: string;
  now: Date;
}): GateDecision {
  const highRisk = args.classification.escapeHatchSteps.length > 0;
  if (!args.classification.requiresApproval) return { outcome: "allow", reason: "read_only", highRisk };
  const a = args.approval;
  if (!a) return { outcome: "require_approval", reason: "approval_missing", highRisk };
  if (Date.parse(a.expiresAt) <= args.now.getTime()) return { outcome: "require_approval", reason: "approval_expired_or_unbound", highRisk };
  if (a.approverId === args.requestedBy) return { outcome: "require_approval", reason: "self_approval", highRisk };
  // The binding digest does not name the requester: another person's identical run is not this one.
  if (a.requestedBy !== args.requestedBy) return { outcome: "require_approval", reason: "approval_expired_or_unbound", highRisk };
  return { outcome: "allow", reason: "approved", highRisk };
}
