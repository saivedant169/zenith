/**
 * PROD-OPS-01 measurement calculator, offline. No AWS, no database: the pure module under
 * scripts/acceptance/live/product/ops01-measure.ts is exercised with synthetic samples and instants.
 */
import { describe, expect, it } from "vitest";
import { sloDefinitions } from "@/lib/slo/definitions";
import { computeRecovery } from "@/lib/slo/recovery";
import { measure, Ops01Error, OPS01_LABEL, proportionLowerBound, samplesToDemonstrate, type TimedSample } from "../../scripts/acceptance/live/product/ops01-measure";

const fast = (n: number): TimedSample[] => Array.from({ length: n }, () => ({ durationMs: 100, ok: true }));
const T0 = Date.parse("2026-10-26T10:00:00Z");

describe("statistics", () => {
  it("nearest-rank percentiles over a known list, and p99 is flagged unreliable below 100 samples", () => {
    const samples = Array.from({ length: 100 }, (_, i) => ({ durationMs: i + 1, ok: true }));
    const r = measure({ reference: "stats-1", controlPlane: { vantage: "runner-local", samples } });
    expect(r.controlPlane).toMatchObject({ samples: 100, p50Ms: 50, p95Ms: 95, p99Ms: 99, p99Reliable: true });
    const small = measure({ reference: "stats-2", controlPlane: { vantage: "runner-local", samples: fast(20) } });
    expect(small.controlPlane?.p99Reliable).toBe(false);
  });

  it("zero-failure sample sizes match the closed form, and the bound clears exactly at that size", () => {
    const n999 = samplesToDemonstrate(0.999);
    expect(n999).toBe(2995);
    expect(proportionLowerBound(n999, n999)).toBeGreaterThanOrEqual(0.999);
    expect(proportionLowerBound(n999 - 1, n999 - 1)).toBeLessThan(0.999);
    const n95 = samplesToDemonstrate(0.95);
    expect(n95).toBe(59);
    expect(proportionLowerBound(n95, n95)).toBeGreaterThanOrEqual(0.95);
    expect(proportionLowerBound(n95 - 1, n95 - 1)).toBeLessThan(0.95);
  });

  it("the one-sided lower bound is bounded by the point estimate and rises with successes", () => {
    expect(proportionLowerBound(0, 500)).toBe(0);
    let previous = 0;
    for (const x of [900, 950, 990, 999, 1000]) {
      const lower = proportionLowerBound(x, 1000);
      expect(lower).toBeLessThanOrEqual(x / 1000);
      expect(lower).toBeGreaterThan(previous);
      previous = lower;
    }
  });
});

describe("ratio objectives from control-plane samples", () => {
  it("demonstrates the availability target only when the lower bound clears it", () => {
    const ok = measure({ reference: "avail-1", controlPlane: { vantage: "runner-local", samples: fast(3000) } });
    expect(ok.measurements.find((m) => m.objective === "control_plane_availability")).toMatchObject({ verdict: "demonstrated", samples: 3000, good: 3000 });
    const short = measure({ reference: "avail-2", controlPlane: { vantage: "runner-local", samples: fast(2000) } });
    expect(short.measurements.find((m) => m.objective === "control_plane_availability")).toMatchObject({ verdict: "not_demonstrated", samplesToDemonstrate: 2995 });
    const tooFew = measure({ reference: "avail-3", controlPlane: { vantage: "runner-local", samples: [...fast(2997), ...Array.from({ length: 3 }, () => ({ durationMs: 100, ok: false }))] } });
    expect(tooFew.measurements.find((m) => m.objective === "control_plane_availability")).toMatchObject({ verdict: "not_demonstrated", good: 2997 });
    const breached = measure({ reference: "avail-4", controlPlane: { vantage: "runner-local", samples: [...fast(2990), ...Array.from({ length: 10 }, () => ({ durationMs: 100, ok: false }))] } });
    expect(breached.measurements.find((m) => m.objective === "control_plane_availability")).toMatchObject({ verdict: "not_met" });
  });

  it("api latency counts a request as good only within the definition's threshold, failures included when fast", () => {
    const threshold = (sloDefinitions().objectives.find((o) => o.id === "api_latency") as { thresholdSeconds: number }).thresholdSeconds;
    expect(threshold).toBe(0.5);
    const demonstrated = measure({ reference: "lat-1", controlPlane: { vantage: "runner-local", samples: fast(59) } });
    expect(demonstrated.measurements.find((m) => m.objective === "api_latency")).toMatchObject({ verdict: "demonstrated", thresholdMs: 500 });
    const notDemonstrated = measure({ reference: "lat-2", controlPlane: { vantage: "runner-local", samples: fast(58) } });
    expect(notDemonstrated.measurements.find((m) => m.objective === "api_latency")).toMatchObject({ verdict: "not_demonstrated" });
    const slow = [...fast(50), ...Array.from({ length: 10 }, () => ({ durationMs: 900, ok: true }))];
    expect(measure({ reference: "lat-3", controlPlane: { vantage: "runner-local", samples: slow } }).measurements.find((m) => m.objective === "api_latency")).toMatchObject({ verdict: "not_met", good: 50 });
  });

  it("reports no data, and names every objective it cannot speak to", () => {
    const r = measure({ reference: "none-1" });
    expect(r.measurements).toEqual([]);
    expect(r.notEvaluated.map((n) => n.objective)).toEqual(sloDefinitions().objectives.map((o) => o.id));
  });
});

describe("provider baseline and recovery", () => {
  it("summarises Lambda invocations but compares them to no objective", () => {
    const r = measure({ reference: "base-1", providerBaseline: { vantage: "aws-lambda", samples: fast(300) } });
    expect(r.providerBaseline).toMatchObject({ vantage: "aws-lambda", samples: 300, okRatio: 1 });
    expect(r.measurements).toEqual([]);
  });

  it("derives RPO and RTO exactly as the production arithmetic does", () => {
    const failureAt = new Date(T0), dataThrough = new Date(T0 - 210_000), restored = new Date(T0 + 2_530_000);
    const expected = computeRecovery({ failureAt, dataRecoveredThrough: dataThrough, serviceRestoredAt: restored });
    const r = measure({ reference: "rec-1", restore: { failureAtMs: T0, dataRecoveredThroughMs: T0 - 210_000, serviceRestoredAtMs: T0 + 2_530_000, scope: "application" } });
    expect(expected).toEqual({ rpoSeconds: 210, rtoSeconds: 2530 });
    expect(r.recovery).toMatchObject({ scope: "application", observations: 1, rpoSeconds: 210, restoreElapsedSeconds: 2530 });
    expect(r.measurements.find((m) => m.objective === "rpo")).toMatchObject({ valueSeconds: 210, verdict: "within_target", observations: 1 });
    expect(r.measurements.find((m) => m.objective === "rto")).toMatchObject({ valueSeconds: 2530, verdict: "within_target" });
  });

  it("flags an RPO or RTO over its target", () => {
    const r = measure({ reference: "rec-2", restore: { failureAtMs: T0, dataRecoveredThroughMs: T0 - 1_000_000, serviceRestoredAtMs: T0 + 20_000_000, scope: "application" } });
    expect(r.measurements.find((m) => m.objective === "rpo")).toMatchObject({ verdict: "over_target" });
    expect(r.measurements.find((m) => m.objective === "rto")).toMatchObject({ verdict: "over_target" });
  });

  it("never calls a database-scope restore a service recovery: RTO is not evaluated", () => {
    const r = measure({ reference: "rec-3", restore: { failureAtMs: T0, dataRecoveredThroughMs: T0 - 60_000, serviceRestoredAtMs: T0 + 1_500_000, scope: "database" } });
    expect(r.measurements.map((m) => m.objective)).toEqual(["rpo"]);
    expect(r.notEvaluated).toContainEqual({ objective: "rto", reason: "database-scope restore: DB availability is not service recovery" });
  });
});

describe("honesty and sanitisation", () => {
  it("labels every result provisional and copies, never writes, the target approval state", () => {
    const r = measure({ reference: "label-1", controlPlane: { vantage: "runner-local", samples: fast(5) } });
    expect(r.label).toBe(OPS01_LABEL);
    expect(OPS01_LABEL).toBe("provisional");
    expect(r.targetApproval).toBe(sloDefinitions().approval.status);
  });

  it("returns no timestamps, sample arrays, approver fields or environment names", () => {
    const r = measure({
      reference: "clean-1",
      controlPlane: { vantage: "runner-local", samples: fast(3000) },
      restore: { failureAtMs: T0, dataRecoveredThroughMs: T0 - 1000, serviceRestoredAtMs: T0 + 2000, scope: "application" },
    });
    const json = JSON.stringify(r);
    expect(json).toContain('"rpoSeconds":');
    expect(json).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(json).not.toMatch(/approvedBy|approver|arn:|\b\d{12}\b/);
    expect(json).not.toContain('"samples":[');
  });

  it("refuses malformed evidence before any number is produced", () => {
    const base = { controlPlane: { vantage: "runner-local", samples: fast(3) } };
    expect(() => measure({ reference: "bad token!", ...base })).toThrow(Ops01Error);
    expect(() => measure({ reference: "ok-1", controlPlane: { vantage: "Runner Local", samples: fast(3) } })).toThrow(Ops01Error);
    expect(() => measure({ reference: "ok-2", controlPlane: { vantage: "runner-local", samples: [{ durationMs: -1, ok: true }] } })).toThrow(Ops01Error);
    expect(() => measure({ reference: "ok-3", restore: { failureAtMs: T0, dataRecoveredThroughMs: T0 + 1, serviceRestoredAtMs: T0 + 5, scope: "application" } })).toThrow(Ops01Error);
    expect(() => measure({ reference: "ok-4", restore: { failureAtMs: T0, dataRecoveredThroughMs: T0 - 1, serviceRestoredAtMs: T0 - 5, scope: "application" } })).toThrow(Ops01Error);
    expect(() => proportionLowerBound(5, 4)).toThrow(Ops01Error);
  });
});
