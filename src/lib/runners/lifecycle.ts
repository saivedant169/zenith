/**
 * Agent delivery lifecycle (PROD-MACH-04): what the control plane shows about a
 * runner or zenithd machine's connection, durable result spool and release.
 *
 * Two kinds of fact, kept apart on purpose:
 *  - DERIVED by the control plane, trusted: revoked, and offline (no heartbeat
 *    for 90 s on the store's clock). These alone decide whether work is taken
 *    or dispatched.
 *  - REPORTED by the agent in its heartbeat, informational: its own connection
 *    state, how many results wait in its durable spool, and its release state.
 *    A report is validated, bounded and redacted, never trusted for authority,
 *    and a malformed one is dropped without failing the heartbeat (liveness
 *    must not depend on telemetry).
 *
 * The result is one `connection` state an operator can read:
 *   revoked     the agent was revoked; it takes no work and is told to stop
 *   offline     silent past the stale threshold; no work is dispatched; results
 *               it produced meanwhile wait in its spool
 *   recovering  heard from again, but it still holds spooled results, reports
 *               shaky connectivity, or just came back; replay is in progress
 *   online      healthy
 */
import { z } from "zod";
import { redactText } from "@/lib/runners/redact";
import type { AgentLifecycle, AgentRecord } from "@/lib/runners/ports";
import { STALE_AFTER_SEC } from "@/lib/runners/types";

const SHORT = /^[^\u0000-\u001f\u007f]*$/;
const text = (max: number) => z.string().max(max).regex(SHORT);
const isoish = z
  .string()
  .max(40)
  .refine((s) => Number.isFinite(Date.parse(s)), "must be a timestamp")
  .transform((s) => new Date(s).toISOString());
const count = (max: number) => z.number().int().min(0).max(max);

const ReportSchema = z.object({
  connection: z
    .object({
      state: z.enum(["online", "degraded", "offline"]),
      consecutiveFailures: count(1_000_000).prefault(0),
      offlineSince: isoish.optional(),
      lastRecoveredAt: isoish.optional(),
      lastOfflineSec: count(31_536_000).optional(),
    })
    .optional(),
  spool: z
    .object({
      depth: count(1_000_000),
      bytes: count(2 ** 40),
      oldestAt: isoish.optional(),
      replayed: count(2 ** 40).prefault(0),
    })
    .optional(),
  update: z
    .object({
      state: z.enum(["current", "pending_health", "rolled_back", "check_failed"]),
      channel: text(32).optional(),
      running: text(64),
      target: text(64).optional(),
      previous: text(64).optional(),
      lastSeq: count(2 ** 52).prefault(0),
      lastCheckAt: isoish.optional(),
      lastError: text(300).optional(),
      rolledBackFrom: text(64).optional(),
      rolledBackAt: isoish.optional(),
      rollbackReason: text(200).optional(),
      deadline: isoish.optional(),
    })
    .optional(),
});

/**
 * Validate an agent-reported lifecycle block. Returns undefined for anything
 * malformed (the heartbeat still counts). Free-text fields are redacted.
 */
export function parseLifecycleReport(value: unknown): AgentLifecycle | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = ReportSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const r = parsed.data;
  const out: AgentLifecycle = {};
  if (r.connection) out.connection = r.connection;
  if (r.spool) out.spool = r.spool;
  if (r.update) {
    const u = r.update;
    out.update = {
      ...u,
      ...(u.lastError !== undefined ? { lastError: redactText(u.lastError) } : {}),
      ...(u.rollbackReason !== undefined ? { rollbackReason: redactText(u.rollbackReason) } : {}),
    };
  }
  return Object.keys(out).length ? out : undefined;
}

export type ConnectionState = "online" | "recovering" | "offline" | "revoked";

export interface ConnectionView {
  state: ConnectionState;
  /** one sentence an operator can act on; no codes */
  summary: string;
  /** whether the control plane will dispatch work to this agent right now */
  takesWork: boolean;
  /** the agent's last report is older than the stale threshold (shown, not trusted) */
  reportStale: boolean;
  offlineSince?: string;
  spooledResults: number;
  /** a release was rolled back or is awaiting its health check */
  releaseAttention?: string;
}

/** An agent that just came back stays "recovering" for this long after it says so. */
const RECENT_RECOVERY_MS = 5 * 60_000;

/**
 * Derive the operator-facing connection state. `nowMs` is the same clock the
 * record's `stale` flag was computed on (the store clock); only the
 * "recently recovered" window uses it.
 */
export function connectionView(agent: Pick<AgentRecord, "status" | "stale" | "lastHeartbeatAt" | "registeredAt" | "lifecycle">, nowMs: number): ConnectionView {
  const life = agent.lifecycle;
  const spooled = life?.spool?.depth ?? 0;
  const reportAgeMs = life?.reportedAt ? nowMs - Date.parse(life.reportedAt) : Infinity;
  const reportStale = reportAgeMs > STALE_AFTER_SEC * 1000;
  const release = releaseAttention(life);
  if (agent.status === "revoked") {
    return { state: "revoked", summary: "Revoked. It takes no work and is told to stop; register it again with a new token to bring it back.", takesWork: false, reportStale, spooledResults: spooled, releaseAttention: release };
  }
  if (agent.stale) {
    const since = agent.lastHeartbeatAt ?? agent.registeredAt;
    const pending = spooled > 0 ? ` ${spooled} finished result${spooled === 1 ? "" : "s"} wait on the host and will be delivered when it reconnects.` : "";
    return { state: "offline", summary: `Offline since ${since}. No work is sent to it.${pending}`, takesWork: false, reportStale, offlineSince: since, spooledResults: spooled, releaseAttention: release };
  }
  const conn = life?.connection;
  const recoveredAt = conn?.lastRecoveredAt ? Date.parse(conn.lastRecoveredAt) : NaN;
  const recent = Number.isFinite(recoveredAt) && nowMs - recoveredAt <= RECENT_RECOVERY_MS;
  if (!reportStale && (spooled > 0 || conn?.state === "offline" || conn?.state === "degraded" || recent)) {
    const bits: string[] = [];
    if (spooled > 0) bits.push(`delivering ${spooled} saved result${spooled === 1 ? "" : "s"}`);
    if (conn?.state === "degraded") bits.push("its connection is unstable");
    if (conn?.state === "offline") bits.push("it cannot reach Zenith from its side");
    if (recent && conn?.lastOfflineSec !== undefined) bits.push(`it was offline for ${humanSeconds(conn.lastOfflineSec)}`);
    return { state: "recovering", summary: `Reconnected: ${bits.join("; ") || "catching up"}.`, takesWork: true, reportStale, spooledResults: spooled, releaseAttention: release };
  }
  return { state: "online", summary: "Online and sending heartbeats.", takesWork: true, reportStale, spooledResults: spooled, releaseAttention: release };
}

function releaseAttention(life: AgentLifecycle | undefined): string | undefined {
  const u = life?.update;
  if (!u) return undefined;
  if (u.state === "rolled_back") return `Version ${u.rolledBackFrom ?? "unknown"} failed its health check and was rolled back to ${u.running}.`;
  if (u.state === "pending_health") return `Version ${u.running} is running its health check${u.deadline ? ` (deadline ${u.deadline})` : ""}.`;
  if (u.state === "check_failed") return "The last release check failed; the running version is unchanged.";
  return undefined;
}

function humanSeconds(sec: number): string {
  if (sec < 90) return `${sec} seconds`;
  if (sec < 5400) return `${Math.round(sec / 60)} minutes`;
  return `${Math.round(sec / 3600)} hours`;
}
