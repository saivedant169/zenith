/**
 * Pure scheduling math for runbook runs (PROD-MACH-03). No clock, no I/O.
 *
 * Everything is UTC. A window is a day-of-week plus a minute range that does
 * not cross midnight (split a wrap-around window in two); there is no time-zone
 * or DST arithmetic to get wrong. A scheduled slot only runs inside a window,
 * and a run's deadline is the end of that window, so a run can never spill past
 * the maintenance window it was approved for.
 */
import { z } from "zod";
import { MAX_RUN_DURATION_SEC, RunbookError } from "./definition";

const MIN = 60_000;
const DAY = 86_400_000;
export const MIN_INTERVAL_SEC = 60;
export const MAX_INTERVAL_SEC = 30 * 86_400;
/** a slot is runnable only this long after it was due; later ones are recorded as missed, never run late */
export const MAX_SLOT_GRACE_SEC = 300;
const SEARCH_LIMIT = 20_000;

export const WindowSchema = z
  .object({
    /** 0 = Sunday ... 6 = Saturday, UTC */
    days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    startMinute: z.number().int().min(0).max(1439),
    endMinute: z.number().int().min(1).max(1440),
  })
  .strict()
  .refine((w) => w.endMinute > w.startMinute, "endMinute must be after startMinute (windows do not cross midnight)");
export type RunWindow = z.output<typeof WindowSchema>;

const isoInstant = z.string().datetime({ offset: false });

export const ScheduleSpecSchema = z
  .object({
    cadence: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("interval"), everySec: z.number().int().min(MIN_INTERVAL_SEC).max(MAX_INTERVAL_SEC), anchor: isoInstant }).strict(),
      z.object({ kind: z.literal("once"), at: isoInstant }).strict(),
    ]),
    /** at least one: an unbounded schedule is not accepted */
    windows: z.array(WindowSchema).min(1).max(14),
    notBefore: isoInstant.optional(),
    notAfter: isoInstant.optional(),
    maxRunDurationSec: z.number().int().min(10).max(MAX_RUN_DURATION_SEC).prefault(1800),
    maxParallelTargets: z.number().int().min(1).max(5).prefault(1),
  })
  .strict();
export type ScheduleSpec = z.output<typeof ScheduleSpecSchema>;

export function parseScheduleSpec(raw: unknown): ScheduleSpec {
  const p = ScheduleSpecSchema.safeParse(raw);
  if (!p.success) throw new RunbookError("invalid_binding", "The schedule is invalid.", p.error.issues.slice(0, 8).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`.slice(0, 200)));
  const s = p.data;
  if (s.notBefore && s.notAfter && Date.parse(s.notAfter) <= Date.parse(s.notBefore)) throw new RunbookError("invalid_binding", "notAfter must be after notBefore.");
  return s;
}

/** The window containing `ms`, with its end, or undefined when `ms` is outside every window. */
export function windowAt(windows: readonly RunWindow[], ms: number): { endMs: number } | undefined {
  const d = new Date(ms);
  const minuteOfDay = d.getUTCHours() * 60 + d.getUTCMinutes();
  const dayStart = Math.floor(ms / DAY) * DAY;
  let best: number | undefined;
  for (const w of windows) {
    if (!w.days.includes(d.getUTCDay())) continue;
    if (minuteOfDay >= w.startMinute && minuteOfDay < w.endMinute) {
      const end = dayStart + w.endMinute * MIN;
      if (best === undefined || end > best) best = end;
    }
  }
  return best === undefined ? undefined : { endMs: best };
}

/** First slot of the cadence strictly after `afterMs` (or exactly the one-shot instant), ignoring windows. */
export function nextRawSlot(spec: ScheduleSpec, afterMs: number): number | undefined {
  if (spec.cadence.kind === "once") {
    const at = Date.parse(spec.cadence.at);
    return at > afterMs ? at : undefined;
  }
  const anchor = Date.parse(spec.cadence.anchor);
  const step = spec.cadence.everySec * 1000;
  if (afterMs < anchor) return anchor;
  return anchor + (Math.floor((afterMs - anchor) / step) + 1) * step;
}

/**
 * The next slot strictly after `afterMs` that lies inside a window and inside
 * [notBefore, notAfter]. Bounded search: returns undefined (never loops) when none exists.
 */
export function nextSlotInWindow(spec: ScheduleSpec, afterMs: number): number | undefined {
  const nb = spec.notBefore ? Date.parse(spec.notBefore) : undefined;
  const na = spec.notAfter ? Date.parse(spec.notAfter) : undefined;
  let cursor = nb !== undefined && afterMs < nb ? nb - 1 : afterMs;
  for (let i = 0; i < SEARCH_LIMIT; i += 1) {
    const slot = nextRawSlot(spec, cursor);
    if (slot === undefined || (na !== undefined && slot > na)) return undefined;
    if (windowAt(spec.windows, slot)) return slot;
    cursor = slot;
  }
  return undefined;
}

export type SlotDecision =
  | { action: "run"; slotMs: number; deadlineMs: number }
  | { action: "missed"; slotMs: number; reason: "late" | "outside_window" };

/** Decide what to do with a slot that is due at `nowMs`. A slot is never run late and never past its window. */
export function decideSlot(spec: ScheduleSpec, slotMs: number, nowMs: number): SlotDecision {
  const win = windowAt(spec.windows, slotMs);
  if (!win) return { action: "missed", slotMs, reason: "outside_window" };
  const grace = Math.min(MAX_SLOT_GRACE_SEC * 1000, spec.cadence.kind === "interval" ? spec.cadence.everySec * 1000 : MAX_SLOT_GRACE_SEC * 1000);
  if (nowMs - slotMs > grace || nowMs >= win.endMs) return { action: "missed", slotMs, reason: "late" };
  let deadline = Math.min(win.endMs, slotMs + spec.maxRunDurationSec * 1000);
  if (spec.notAfter) deadline = Math.min(deadline, Date.parse(spec.notAfter));
  return { action: "run", slotMs, deadlineMs: deadline };
}

/** Deadline of an ad-hoc run: the shortest of the window end, the duration cap and notAfter. */
export function adHocDeadline(opts: { nowMs: number; windows?: readonly RunWindow[]; maxRunDurationSec: number; notAfter?: string }): number {
  let deadline = opts.nowMs + opts.maxRunDurationSec * 1000;
  if (opts.windows && opts.windows.length) {
    const win = windowAt(opts.windows, opts.nowMs);
    if (!win) throw new RunbookError("outside_window", "The run was requested outside its allowed window.");
    deadline = Math.min(deadline, win.endMs);
  }
  if (opts.notAfter) deadline = Math.min(deadline, Date.parse(opts.notAfter));
  if (deadline <= opts.nowMs) throw new RunbookError("outside_window", "The run's window has already closed.");
  return deadline;
}
