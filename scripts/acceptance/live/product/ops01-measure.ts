/**
 * PROD-OPS-01 measurement calculator. Pure: no AWS, no database, no I/O.
 *
 * Turns timed samples and restore instants into the figures the objectives in src/lib/slo ask for, and compares them
 * with those targets. The targets and their approval state are read from sloDefinitions() and copied, never restated.
 * Every result is labelled `provisional`: it is a measurement. It records no approver and adds no approval.
 *
 * Statistics: a ratio objective is "demonstrated" only when the exact one-sided 95% Clopper-Pearson lower bound on the
 * observed proportion clears the target, so a short run cannot pass on a lucky point estimate. Percentiles are
 * nearest-rank and descriptive. A restore gives one observation, so its figures are never called a distribution.
 *
 * Sources: `controlPlane` samples (requests to the Zenith API from a named vantage) feed control_plane_availability and
 * api_latency. `providerBaseline` samples (AWS Lambda invocations) feed no objective and are only summarised.
 * `restore` instants feed rpo, and rto only when the restore scope is "application". A `capacity` run (an open-loop
 * burst at a fixed offered rate) feeds the capacity objective as one observation; only 2xx answers count as served.
 */
import { sloDefinitions, type CapacityObjective, type LatencyRatioObjective, type Objective, type RatioObjective } from "@/lib/slo/definitions";
import { quantile } from "@/lib/slo/sli";

export const OPS01_LABEL = "provisional" as const;
export const CONFIDENCE = 0.95;
const MAX_SAMPLES = 100_000;
const REFERENCE = /^[A-Za-z0-9._:-]{1,80}$/;
const VANTAGE = /^[a-z0-9-]{1,40}$/;
/** Objectives whose SLI the control-plane sample stream measures. Others are reported as not evaluated. */
const FROM_CONTROL_PLANE = ["control_plane_availability", "api_latency"] as const;

export interface TimedSample { durationMs: number; ok: boolean }
export interface SampleSet { vantage: string; samples: readonly TimedSample[] }
export interface RestoreInstants {
  failureAtMs: number;
  dataRecoveredThroughMs: number;
  /** "database": the restored DB instance is available. "application": the service answers a health check. */
  scope: "database" | "application";
  serviceRestoredAtMs: number;
}
/** An open-loop burst: requests offered at a fixed rate; `elapsedMs` runs from the first request to the last answer. */
export interface CapacityRun { vantage: string; offeredPerSecond: number; elapsedMs: number; samples: readonly TimedSample[] }
export interface Ops01Evidence {
  /** short token naming the run's evidence; never a secret, ARN, account id or hostname */
  reference: string;
  controlPlane?: SampleSet;
  providerBaseline?: SampleSet;
  restore?: RestoreInstants;
  capacity?: CapacityRun;
}

export interface Percentiles { p50Ms: number | null; p95Ms: number | null; p99Ms: number | null; p99Reliable: boolean }
export type RatioVerdict = "demonstrated" | "not_demonstrated" | "not_met" | "no_data";
export interface RatioMeasurement {
  objective: string; status: Objective["status"]; kind: RatioObjective["kind"] | LatencyRatioObjective["kind"]; target: number; thresholdMs?: number;
  samples: number; good: number; ratio: number | null; lowerBound: number | null; verdict: RatioVerdict; samplesToDemonstrate: number;
}
export interface RecoveryMeasurement {
  objective: string; status: Objective["status"]; kind: "recovery_seconds"; maxSeconds: number; valueSeconds: number; observations: 1; verdict: "within_target" | "over_target";
}
export interface CapacityMeasurement {
  objective: string; status: Objective["status"]; kind: "capacity"; minRequestsPerSecond: number; maxP95Ms: number; maxErrorRate: number;
  offeredPerSecond: number; samples: number; requestsPerSecond: number; p95Ms: number | null; errorRate: number; observations: 1; verdict: "within_target" | "over_target";
}
export type Measurement = RatioMeasurement | RecoveryMeasurement | CapacityMeasurement;

export interface Ops01Result {
  label: typeof OPS01_LABEL;
  reference: string;
  definitionVersion: string;
  /** The approval state of the target file as it stands. This run adds no approval. */
  targetApproval: "approved_targets" | "not_approved";
  confidence: number;
  controlPlane?: { vantage: string; samples: number } & Percentiles;
  providerBaseline?: { vantage: string; samples: number; okRatio: number | null; lowerBound: number | null } & Percentiles;
  recovery?: { scope: RestoreInstants["scope"]; observations: 1; rpoSeconds: number; restoreElapsedSeconds: number };
  measurements: Measurement[];
  notEvaluated: { objective: string; reason: string }[];
}

export class Ops01Error extends Error {}
const fail = (message: string): never => { throw new Ops01Error(message); };

/** Exact one-sided lower confidence bound for a proportion (Clopper-Pearson). Monotone in `successes`. */
export function proportionLowerBound(successes: number, trials: number, confidence = CONFIDENCE): number {
  if (!Number.isInteger(trials) || trials < 0 || trials > MAX_SAMPLES) fail(`sample count must be an integer from 0 to ${MAX_SAMPLES}.`);
  if (!Number.isInteger(successes) || successes < 0 || successes > trials) fail("successes must be an integer from 0 to the sample count.");
  if (successes === 0 || trials === 0) return 0;
  const logFact = new Float64Array(trials + 1);
  for (let i = 1; i <= trials; i++) logFact[i] = logFact[i - 1] + Math.log(i);
  // P(X >= successes | p) rises with p. The bound is the p at which that tail equals 1 - confidence.
  const tailAt = (p: number): number => {
    let sum = 0;
    for (let k = successes; k <= trials; k++) sum += Math.exp(logFact[trials] - logFact[k] - logFact[trials - k] + k * Math.log(p) + (trials - k) * Math.log1p(-p));
    return sum;
  };
  let lo = 0, hi = 1;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (tailAt(mid) < 1 - confidence) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Zero-failure samples needed before a ratio target can be demonstrated at this confidence. */
export const samplesToDemonstrate = (target: number, confidence = CONFIDENCE): number => Math.ceil(Math.log(1 - confidence) / Math.log(target));

function validSamples(samples: readonly TimedSample[]): readonly TimedSample[] {
  if (samples.length > MAX_SAMPLES) fail(`at most ${MAX_SAMPLES} samples per run.`);
  for (const s of samples) {
    if (!Number.isFinite(s.durationMs) || s.durationMs < 0 || typeof s.ok !== "boolean") fail("each sample needs a finite durationMs >= 0 and a boolean ok.");
  }
  return samples;
}

function percentiles(samples: readonly TimedSample[]): Percentiles {
  const ms = samples.map((s) => s.durationMs);
  // p99 is only distinct from the maximum with at least 100 samples.
  return { p50Ms: quantile(ms, 0.5), p95Ms: quantile(ms, 0.95), p99Ms: quantile(ms, 0.99), p99Reliable: ms.length >= 100 };
}

function ratioMeasurement(o: RatioObjective | LatencyRatioObjective, samples: readonly TimedSample[]): RatioMeasurement {
  const threshold = o.kind === "latency_ratio" ? o.thresholdSeconds * 1000 : undefined;
  const good = samples.filter((s) => (threshold === undefined ? s.ok : s.durationMs <= threshold)).length;
  const n = samples.length;
  const lowerBound = n === 0 ? null : proportionLowerBound(good, n);
  const verdict: RatioVerdict = n === 0 ? "no_data" : lowerBound! >= o.target ? "demonstrated" : good / n >= o.target ? "not_demonstrated" : "not_met";
  return {
    objective: o.id, status: o.status, kind: o.kind, target: o.target, ...(threshold === undefined ? {} : { thresholdMs: threshold }),
    samples: n, good, ratio: n === 0 ? null : good / n, lowerBound, verdict, samplesToDemonstrate: samplesToDemonstrate(o.target),
  };
}

function capacityMeasurement(o: CapacityObjective, run: CapacityRun): CapacityMeasurement {
  if (!VANTAGE.test(run.vantage)) fail("vantage must be a short lowercase label (letters, digits and -).");
  if (!Number.isFinite(run.elapsedMs) || run.elapsedMs <= 0 || !Number.isFinite(run.offeredPerSecond) || run.offeredPerSecond <= 0) fail("a capacity run needs a positive elapsedMs and offeredPerSecond.");
  const samples = validSamples(run.samples);
  if (!samples.length) fail("a capacity run needs at least one sample.");
  const served = samples.filter((s) => s.ok).length;
  const requestsPerSecond = served / (run.elapsedMs / 1000), errorRate = (samples.length - served) / samples.length;
  const p95Ms = quantile(samples.map((s) => s.durationMs), 0.95);
  const within = requestsPerSecond >= o.minRequestsPerSecond && p95Ms !== null && p95Ms <= o.maxP95Ms && errorRate <= o.maxErrorRate;
  return {
    objective: o.id, status: o.status, kind: "capacity", minRequestsPerSecond: o.minRequestsPerSecond, maxP95Ms: o.maxP95Ms, maxErrorRate: o.maxErrorRate,
    offeredPerSecond: run.offeredPerSecond, samples: samples.length, requestsPerSecond, p95Ms, errorRate, observations: 1, verdict: within ? "within_target" : "over_target",
  };
}

/** Pure measurement from evidence to the result object. Nothing here is written anywhere. */
export function measure(evidence: Ops01Evidence): Ops01Result {
  const defs = sloDefinitions();
  if (!REFERENCE.test(evidence.reference)) fail("reference must be a short token (letters, digits and . _ : -).");
  const measurements: Measurement[] = [];
  const notEvaluated: Ops01Result["notEvaluated"] = [];
  const result: Ops01Result = {
    label: OPS01_LABEL, reference: evidence.reference, definitionVersion: defs.definitionVersion,
    targetApproval: defs.approval.status, confidence: CONFIDENCE, measurements, notEvaluated,
  };

  if (evidence.controlPlane) {
    if (!VANTAGE.test(evidence.controlPlane.vantage)) fail("vantage must be a short lowercase label (letters, digits and -).");
    const samples = validSamples(evidence.controlPlane.samples);
    result.controlPlane = { vantage: evidence.controlPlane.vantage, samples: samples.length, ...percentiles(samples) };
  }
  if (evidence.providerBaseline) {
    if (!VANTAGE.test(evidence.providerBaseline.vantage)) fail("vantage must be a short lowercase label (letters, digits and -).");
    const samples = validSamples(evidence.providerBaseline.samples);
    const ok = samples.filter((s) => s.ok).length;
    result.providerBaseline = {
      vantage: evidence.providerBaseline.vantage, samples: samples.length, okRatio: samples.length ? ok / samples.length : null,
      lowerBound: samples.length ? proportionLowerBound(ok, samples.length) : null, ...percentiles(samples),
    };
  }

  for (const o of defs.objectives) {
    const fromControlPlane = (FROM_CONTROL_PLANE as readonly string[]).includes(o.id);
    if (fromControlPlane && (o.kind === "ratio" || o.kind === "latency_ratio")) {
      if (!evidence.controlPlane) notEvaluated.push({ objective: o.id, reason: "no control-plane samples supplied" });
      else measurements.push(ratioMeasurement(o, validSamples(evidence.controlPlane.samples)));
    } else if (o.kind === "capacity") {
      if (!evidence.capacity) notEvaluated.push({ objective: o.id, reason: "no capacity run supplied" });
      else measurements.push(capacityMeasurement(o, evidence.capacity));
    } else if (o.kind === "recovery_seconds" && (o.id === "rpo" || o.id === "rto")) {
      if (!evidence.restore) notEvaluated.push({ objective: o.id, reason: "no restore instants supplied" });
      else if (o.id === "rto" && evidence.restore.scope !== "application") notEvaluated.push({ objective: o.id, reason: "database-scope restore: DB availability is not service recovery" });
    } else {
      notEvaluated.push({ objective: o.id, reason: "no ops-01 evidence source for this objective" });
    }
  }

  if (evidence.restore) {
    const r = evidence.restore;
    if (![r.failureAtMs, r.dataRecoveredThroughMs, r.serviceRestoredAtMs].every(Number.isFinite)) fail("restore instants must be finite epoch milliseconds.");
    if (r.dataRecoveredThroughMs > r.failureAtMs) fail("data recovered through cannot be after the failure instant.");
    if (r.serviceRestoredAtMs < r.failureAtMs) fail("service restored cannot be before the failure instant.");
    const rpoSeconds = (r.failureAtMs - r.dataRecoveredThroughMs) / 1000;
    const restoreElapsedSeconds = (r.serviceRestoredAtMs - r.failureAtMs) / 1000;
    result.recovery = { scope: r.scope, observations: 1, rpoSeconds, restoreElapsedSeconds };
    const rpo = defs.objectives.find((o) => o.id === "rpo");
    if (rpo?.kind === "recovery_seconds") measurements.push({ objective: rpo.id, status: rpo.status, kind: "recovery_seconds", maxSeconds: rpo.maxSeconds, valueSeconds: rpoSeconds, observations: 1, verdict: rpoSeconds <= rpo.maxSeconds ? "within_target" : "over_target" });
    const rto = defs.objectives.find((o) => o.id === "rto");
    if (rto?.kind === "recovery_seconds" && r.scope === "application") measurements.push({ objective: rto.id, status: rto.status, kind: "recovery_seconds", maxSeconds: rto.maxSeconds, valueSeconds: restoreElapsedSeconds, observations: 1, verdict: restoreElapsedSeconds <= rto.maxSeconds ? "within_target" : "over_target" });
  }
  return result;
}
