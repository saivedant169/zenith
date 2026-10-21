/**
 * Telemetry envelope (PROD-OBS-02): fresh, scoped telemetry with provenance.
 *
 * Every telemetry read (logs, metrics, traces, provider/resource events,
 * resource health, machine health) answers with a `TelemetryEnvelope` beside
 * its items. The envelope says, per source and overall:
 *
 *   - WHERE it came from: source id, provider, evidence level (contract /
 *     emulated / real / simulated), and whether the data is simulated;
 *   - FOR WHOM: the scope (workspace/project/environment/addresses), the time
 *     range asked for, and a non-secret reference to the scoped credential
 *     session that served the read (never the credentials, never a bearer);
 *   - WHEN: `observedAt` (when Zenith read it), the newest/oldest item
 *     timestamps and the age of the newest one against a per-signal freshness
 *     budget;
 *   - HOW MUCH TO TRUST IT: an explicit state. "No data came back" is never one
 *     value: `empty` (reachable, nothing in the window), `stale` (answered, but
 *     the newest item is older than the budget), `unknown` (could not be
 *     determined: timeout, not implemented, no source), `inaccessible` (the
 *     scope or credentials refused the read). None of them is `fresh`.
 *
 * Pure functions only: no I/O, no clock reads (callers pass `observedAt`).
 */
import { createHash } from "node:crypto";
import type { ProviderSession } from "@/lib/credentials/types";
import { SOURCE_EVIDENCE } from "./evidence";
import { tsMs } from "./normalize";
import type { SignalScope, SignalType, TimeRange } from "./types";

export const TELEMETRY_SCHEMA_VERSION = 1;

/** A source's (or the whole answer's) trust state. Only `fresh` means "recent data was read". */
export type TelemetryState = "fresh" | "stale" | "empty" | "unknown" | "inaccessible";

export type TelemetrySignal = SignalType;

/**
 * Freshness budgets (ms): the newest item may be at most this old, measured at
 * `observedAt`, before the answer is labeled `stale`. Health reads are
 * point-in-time so their budget is short.
 */
export const FRESHNESS_BUDGET_MS: Readonly<Record<TelemetrySignal, number>> = {
  log: 15 * 60_000,
  metric: 10 * 60_000,
  trace: 15 * 60_000,
  event: 60 * 60_000,
  health: 5 * 60_000,
};

/** Non-secret description of the scoped session that served a read. */
export interface TelemetrySession {
  provider: string;
  /** stable fingerprint of (provider, account/project, region, expiry); not reversible to a credential */
  ref: string;
  region?: string;
  transport?: string;
  expiresAt?: string;
}

export interface TelemetryScope {
  workspaceId: string;
  projectId?: string;
  environmentId: string;
  addresses?: string[];
}

export interface SourceProvenance {
  source: string;
  /** resource address, for per-resource reads (health) */
  address?: string;
  provider: string;
  evidence: { level: string; basis: string };
  simulated: boolean;
  state: TelemetryState;
  /** why the state is `unknown`/`inaccessible` (already redacted by the caller) */
  reason?: string;
  itemCount: number;
  /** when this source finished answering */
  observedAt: string;
  newestAt?: string;
  oldestAt?: string;
  /** observedAt minus newestAt; absent when no timestamped item came back */
  ageMs?: number;
}

export interface TelemetryEnvelope {
  schemaVersion: typeof TELEMETRY_SCHEMA_VERSION;
  signal: TelemetrySignal;
  scope: TelemetryScope;
  range?: { from: string; to: string };
  session?: TelemetrySession;
  observedAt: string;
  /** best state across answering sources; `inaccessible`/`unknown` only when NO source answered */
  state: TelemetryState;
  /** true when at least one covering source was unknown or inaccessible */
  partial: boolean;
  freshness: { budgetMs: number; newestAt?: string; ageMs?: number };
  provenance: SourceProvenance[];
}

/* ------------------------------ classification ------------------------------ */

const INACCESSIBLE =
  /(?:access ?denied|denied|forbidden|unauthori[sz]ed|not authori[sz]ed|permission|credential|session (?:ended|expired|refused)|refused a session|scope is unavailable|expired ?token|invalid ?(?:client ?)?token|unrecognized ?client|signature ?does ?not ?match|\b40[13]\b)/i;
/** No provider session was ever requested for this read: nothing was refused, so the state is undetermined. */
const NOT_ATTEMPTED = /\bneeds? (?:a workspace and )?a credential-broker\b/i;

/** Map a source's failure text to `inaccessible` (refused) or `unknown` (could not be determined). */
export function classifyUnavailable(reason: string): "unknown" | "inaccessible" {
  return !NOT_ATTEMPTED.test(reason) && INACCESSIBLE.test(reason) ? "inaccessible" : "unknown";
}

export function evidenceOf(source: string): { level: string; basis: string } {
  return SOURCE_EVIDENCE[source] ?? { level: "unknown", basis: "no evidence level is recorded for this source" };
}

const RANK: Record<TelemetryState, number> = { fresh: 4, stale: 3, empty: 2, unknown: 1, inaccessible: 0 };

/** Combine answering sources: the best state wins; the caller handles "nothing answered". */
export function bestState(states: readonly TelemetryState[]): TelemetryState | undefined {
  let best: TelemetryState | undefined;
  for (const s of states) if (best === undefined || RANK[s] > RANK[best]) best = s;
  return best;
}

/** Combine states when nothing answered: all refused is `inaccessible`, otherwise `unknown`. */
export function worstUnanswered(states: readonly TelemetryState[]): TelemetryState {
  return states.length > 0 && states.every((s) => s === "inaccessible") ? "inaccessible" : "unknown";
}

/* ------------------------------ source builders ----------------------------- */

export interface AnsweredInput {
  source: string;
  provider: string;
  simulated: boolean;
  /** ISO timestamps of the items this source contributed (after scope filtering) */
  timestamps: readonly string[];
  observedAt: string;
  budgetMs: number;
  address?: string;
  /** when set, overrides the evidence lookup */
  evidence?: { level: string; basis: string };
}

/** Provenance for a source that answered. Items with unparseable timestamps count but never make an answer `fresh`. */
export function answeredProvenance(i: AnsweredInput): SourceProvenance {
  const observedMs = tsMs(i.observedAt);
  let newest = Number.NEGATIVE_INFINITY;
  let oldest = Number.POSITIVE_INFINITY;
  for (const ts of i.timestamps) {
    const t = tsMs(ts);
    if (t === Number.NEGATIVE_INFINITY) continue;
    if (t > newest) newest = t;
    if (t < oldest) oldest = t;
  }
  const dated = newest > Number.NEGATIVE_INFINITY;
  const ageMs = dated ? Math.max(0, observedMs - newest) : undefined;
  let state: TelemetryState;
  if (i.timestamps.length === 0) state = "empty";
  else if (ageMs === undefined) state = "unknown";
  else state = ageMs <= i.budgetMs ? "fresh" : "stale";
  return {
    source: i.source,
    ...(i.address !== undefined ? { address: i.address } : {}),
    provider: i.provider,
    evidence: i.evidence ?? evidenceOf(i.source),
    simulated: i.simulated,
    state,
    ...(state === "unknown" ? { reason: "items carried no parseable timestamp, so freshness cannot be established" } : {}),
    itemCount: i.timestamps.length,
    observedAt: i.observedAt,
    ...(dated ? { newestAt: new Date(newest).toISOString(), oldestAt: new Date(oldest).toISOString(), ageMs } : {}),
  };
}

export interface FailedInput {
  source: string;
  provider?: string;
  reason: string;
  observedAt: string;
  simulated?: boolean;
  address?: string;
  evidence?: { level: string; basis: string };
}

/** Provenance for a source that could not answer: `inaccessible` when refused, else `unknown`. */
export function failedProvenance(i: FailedInput): SourceProvenance {
  return {
    source: i.source,
    ...(i.address !== undefined ? { address: i.address } : {}),
    provider: i.provider ?? "unknown",
    evidence: i.evidence ?? evidenceOf(i.source),
    simulated: i.simulated ?? false,
    state: classifyUnavailable(i.reason),
    reason: i.reason,
    itemCount: 0,
    observedAt: i.observedAt,
  };
}

/* --------------------------------- envelope --------------------------------- */

export interface EnvelopeInput {
  signal: TelemetrySignal;
  scope: SignalScope | TelemetryScope;
  range?: TimeRange;
  session?: TelemetrySession;
  observedAt: string;
  provenance: SourceProvenance[];
  budgetMs?: number;
}

export function scopeOf(scope: SignalScope | TelemetryScope): TelemetryScope {
  return {
    workspaceId: scope.workspaceId,
    ...(scope.projectId !== undefined ? { projectId: scope.projectId } : {}),
    environmentId: scope.environmentId,
    ...(scope.addresses?.length ? { addresses: [...scope.addresses] } : {}),
  };
}

/** A source "answered" when it was reached: fresh, stale or empty (or unknown-but-returned-items). */
const answeredOf = (p: SourceProvenance): boolean => p.state === "fresh" || p.state === "stale" || p.state === "empty" || (p.state === "unknown" && p.itemCount > 0);

export function buildEnvelope(i: EnvelopeInput): TelemetryEnvelope {
  const budgetMs = i.budgetMs ?? FRESHNESS_BUDGET_MS[i.signal];
  const answered = i.provenance.filter(answeredOf);
  const unanswered = i.provenance.filter((p) => !answeredOf(p));
  const state = bestState(answered.map((p) => p.state)) ?? (i.provenance.length === 0 ? "unknown" : worstUnanswered(unanswered.map((p) => p.state)));
  let newest: string | undefined;
  for (const p of i.provenance) if (p.newestAt && (newest === undefined || tsMs(p.newestAt) > tsMs(newest))) newest = p.newestAt;
  const observedMs = tsMs(i.observedAt);
  return {
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    signal: i.signal,
    scope: scopeOf(i.scope),
    ...(i.range ? { range: { from: i.range.from, to: i.range.to ?? i.observedAt } } : {}),
    ...(i.session ? { session: i.session } : {}),
    observedAt: i.observedAt,
    state,
    partial: unanswered.length > 0,
    freshness: { budgetMs, ...(newest ? { newestAt: newest, ageMs: Math.max(0, observedMs - tsMs(newest)) } : {}) },
    provenance: i.provenance,
  };
}

/* ---------------------------------- session --------------------------------- */

/**
 * Describe a brokered session without exposing anything secret. The ref is a
 * truncated SHA-256 over non-secret identifiers, so two reads through the same
 * session correlate and a different session never does.
 */
export function describeSession(session: ProviderSession | undefined): TelemetrySession | undefined {
  if (!session) return undefined;
  const s = session as unknown as Record<string, unknown>;
  const str = (k: string): string | undefined => (typeof s[k] === "string" ? (s[k] as string) : undefined);
  const identity = str("accountId") ?? str("projectId") ?? str("subscriptionId") ?? str("capability") ?? "";
  const region = str("region");
  const expiresAt = str("expiresAt");
  const transport = str("transport");
  const ref = createHash("sha256").update([session.provider, identity, region ?? "", expiresAt ?? ""].join("|")).digest("hex").slice(0, 16);
  return { provider: session.provider, ref, ...(region ? { region } : {}), ...(transport ? { transport } : {}), ...(expiresAt ? { expiresAt } : {}) };
}
