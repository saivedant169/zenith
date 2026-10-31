/** OPS-02: a control store whose reads hang still yields a fast scrape with zenith_control_store_up 0. */
import { describe, expect, it } from "vitest";
import { sampleControlPlane } from "@/lib/ops/sampler";
import { metricsRegistry } from "@/lib/ops/telemetry/metrics";

describe("sampleControlPlane bound", () => {
  it("reports the store down within the bound when reads never answer", async () => {
    metricsRegistry().reset();
    const hanging = { query: () => new Promise(() => undefined), tx: () => new Promise(() => undefined) };
    const started = Date.now();
    expect(await sampleControlPlane(hanging as never, {}, 50)).toEqual({ up: false });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(metricsRegistry().renderPrometheus()).toContain("zenith_control_store_up 0");
  });
});
