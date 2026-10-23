/**
 * Pre-filter an AWS Price List regional offer file that exceeds the fetch size cap (PROD-COST-01).
 *
 *   NODE_OPTIONS=--max-old-space-size=8192 tsx scripts/cost/prefilter-aws-offer.ts <full index.json> <filtered.json>
 *
 * Keeps the file's header fields, every product that at least one catalog rule for this offer
 * matches, and exactly those products' OnDemand terms. The AWS normalizer reads nothing else,
 * so it returns the same observations for the filtered copy (tests/cost/prefilter-aws-offer.test.ts).
 * Prints the full file's SHA-256 and size so the refresh report can cite the original bytes.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { sha256Hex } from "@/lib/controlplane/digest";
import { AWS_RULES } from "@/lib/placement/catalog-refresh/normalize-aws";

type Attrs = Record<string, string | undefined>;
interface OfferFile { offerCode?: string; products?: Record<string, { productFamily?: string; attributes?: Attrs }>; terms?: { OnDemand?: Record<string, unknown> } & Record<string, unknown> }

export function prefilterAwsOffer(file: OfferFile): OfferFile {
  const offer = file.offerCode;
  if (!offer || !file.products || !file.terms?.OnDemand) throw new Error("not an AWS regional offer file");
  const rules = AWS_RULES.filter((rule) => rule.offers.includes(offer));
  const products: NonNullable<OfferFile["products"]> = {}, onDemand: Record<string, unknown> = {};
  for (const [id, product] of Object.entries(file.products)) {
    const attrs = product.attributes ?? {};
    if (!rules.some((rule) => rule.match(product, attrs, attrs.usagetype ?? ""))) continue;
    products[id] = product;
    if (id in file.terms.OnDemand) onDemand[id] = file.terms.OnDemand[id];
  }
  // Reserved and other term types are never read by the normalizer.
  return { ...file, products, terms: { OnDemand: onDemand } };
}

if (process.argv[1]?.endsWith("prefilter-aws-offer.ts")) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) throw new Error("usage: prefilter-aws-offer.ts <full index.json> <filtered.json>");
  const raw = readFileSync(input);
  const filtered = prefilterAwsOffer(JSON.parse(raw.toString("utf8")) as OfferFile);
  const bytes = Buffer.from(JSON.stringify(filtered));
  writeFileSync(output, bytes, { flag: "wx" });
  console.log(JSON.stringify({ sourceSha256: sha256Hex(raw), sourceBytes: raw.byteLength, filteredSha256: sha256Hex(bytes), filteredBytes: bytes.byteLength, keptProducts: Object.keys(filtered.products ?? {}).length }));
}
