/** PROD-COST-01: pre-filtering an oversized AWS offer must not change what the normalizer reads. Offline fixtures only. */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeAws, parseManifest } from "@/lib/placement/catalog-refresh";
import { prefilterAwsOffer } from "../../scripts/cost/prefilter-aws-offer";

const DIR = join(__dirname, "fixtures/price-snapshots");
const manifest = parseManifest(JSON.parse(readFileSync(join(DIR, "manifest.json"), "utf8")));

describe("AWS offer pre-filter", () => {
  const aws = manifest.snapshots.filter((entry) => entry.provider === "aws");
  it.each(aws.map((entry) => [entry.file, entry] as const))("returns the same observations and skips for %s", (_file, entry) => {
    const text = readFileSync(join(DIR, entry.file), "utf8");
    const filtered = prefilterAwsOffer(JSON.parse(text));
    expect(normalizeAws(JSON.stringify(filtered), entry, {} as never)).toEqual(normalizeAws(text, entry, {} as never));
    expect(Object.keys(filtered.products ?? {}).length).toBeLessThanOrEqual(Object.keys(JSON.parse(text).products).length);
  });
  it("drops products no rule reads and refuses a file that is not an offer", () => {
    const entry = aws.find((value) => value.service === "AmazonEC2")!;
    const file = JSON.parse(readFileSync(join(DIR, entry.file), "utf8"));
    file.products.unrelated = { sku: "unrelated", productFamily: "Something Else", attributes: { usagetype: "Nothing" } };
    file.terms.OnDemand.unrelated = { t: { priceDimensions: {} } };
    const filtered = prefilterAwsOffer(file);
    expect(filtered.products).not.toHaveProperty("unrelated");
    expect(filtered.terms?.OnDemand).not.toHaveProperty("unrelated");
    expect(() => prefilterAwsOffer({})).toThrow(/not an AWS regional offer/);
  });
  it("runs against the recorded AWS fixtures", () => {
    expect(aws.length).toBeGreaterThan(0);
    for (const entry of aws) expect(readdirSync(DIR)).toContain(entry.file);
  });
});
