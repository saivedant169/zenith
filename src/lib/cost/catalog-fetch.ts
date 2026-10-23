/**
 * Gated live download of official price files into a snapshot directory.
 *
 * This is the ONLY code in the refresh tooling that can reach a network, and
 * it refuses unless the operator opts in:
 *
 *   ZENITH_LIVE_CATALOG_REFRESH=1                    explicit opt-in (public price endpoints, no cloud account)
 *   ZENITH_LIVE_GCP_CATALOG_API_KEY_FILE=<abs path>  GCP only: file holding an API key for the
 *                                                    Cloud Billing Catalog API (sent as a header, never in a URL)
 *
 * Every download is capped in size, written to disk with its SHA-256 and byte
 * count in `manifest.json`, and retrieved with an injectable `fetch` so tests
 * exercise the whole path offline. Tests never enable the gate.
 *
 * Honest limit: the AWS regional EC2 offer file is very large. Files above
 * `MAX_FILE_BYTES` are refused rather than truncated; use a pre-filtered copy
 * saved into the directory with a manifest entry instead.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { sha256Hex } from "@/lib/controlplane/digest";
import { AWS_RULES } from "@/lib/placement/catalog-refresh/normalize-aws";
import { RefreshError, type RefreshProvider, type SnapshotEntry, type SnapshotFormat, type SnapshotManifest } from "@/lib/placement/catalog-refresh/types";

export const MAX_FILE_BYTES = 450 * 1024 * 1024;
const TIMEOUT_MS = 120_000;
const MAX_RETRIES = 6;
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

export const GCP_SERVICES: Readonly<Record<string, string>> = {
  "Compute Engine": "6F81-5844-456A",
  "Cloud Run": "152E-C115-5142",
  Networking: "E505-1604-58F8",
  "Cloud Storage": "95FF-2EF5-5EA1",
  "Cloud SQL": "9662-B51E-5089",
};
export const AZURE_SERVICES: readonly string[] = ["Virtual Machines", "Virtual Network", "Bandwidth", "NAT Gateway", "Azure Container Apps", "Storage", "Log Analytics", "Azure DNS", "Azure Database for PostgreSQL"];
export const OCI_PRICE_LIST_URL = "https://apexapps.oracle.com/pls/apex/cetools/api/v1/products/?currencyCode=USD";

export type EnvLike = Readonly<Record<string, string | undefined>>;

export function refreshGateOpen(env: EnvLike): { open: true } | { open: false; reason: string } {
  return env.ZENITH_LIVE_CATALOG_REFRESH === "1" ? { open: true } : { open: false, reason: "ZENITH_LIVE_CATALOG_REFRESH=1 is not set; live price downloads are disabled." };
}

export interface FetchDeps {
  env: EnvLike;
  fetch: typeof fetch;
  /** YYYY-MM-DD stamped on every file */
  today: string;
  readFile?: (path: string) => string;
  /** test seam for rate-limit backoff */
  sleep?: (ms: number) => Promise<void>;
}

export interface FetchRequest {
  providers: readonly RefreshProvider[];
  /** regions per provider, from the catalog being refreshed */
  regions: Readonly<Record<string, readonly string[]>>;
  outDir: string;
}

const FORMAT: Record<RefreshProvider, SnapshotFormat> = {
  aws: "aws_price_list",
  gcp: "gcp_billing_catalog",
  azure: "azure_retail_prices",
  oci: "oci_price_list",
};

const slug = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80);

async function download(deps: FetchDeps, url: string, headers: Record<string, string> = {}): Promise<{ bytes: Buffer }> {
  const u = new URL(url);
  if (u.protocol !== "https:") throw new RefreshError("gate", "Only https price endpoints are fetched.");
  let response = await deps.fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
  // Public price APIs rate-limit bulk reads (Azure Retail Prices answers 429): bounded retries, honoring Retry-After.
  for (let attempt = 1; (response.status === 429 || response.status === 503) && attempt <= MAX_RETRIES; attempt++) {
    const after = Number(response.headers.get("retry-after"));
    await (deps.sleep ?? sleep)(Math.min(Number.isFinite(after) && after > 0 ? after * 1000 : 2000 * 2 ** attempt, 60_000));
    response = await deps.fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
  }
  if (!response.ok) throw new RefreshError("format", `${u.host} answered HTTP ${response.status}.`);
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_FILE_BYTES) throw new RefreshError("format", `${u.host} file is larger than ${MAX_FILE_BYTES} bytes; use a pre-filtered copy.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > MAX_FILE_BYTES) throw new RefreshError("format", `${u.host} file is larger than ${MAX_FILE_BYTES} bytes; use a pre-filtered copy.`);
  return { bytes };
}

export async function fetchOfficialSnapshots(request: FetchRequest, deps: FetchDeps): Promise<SnapshotManifest> {
  const gate = refreshGateOpen(deps.env);
  if (!gate.open) throw new RefreshError("gate", gate.reason);
  if (!isAbsolute(request.outDir)) throw new RefreshError("gate", "The output directory must be an absolute path.");
  mkdirSync(request.outDir, { recursive: true });
  const snapshots: SnapshotEntry[] = [];
  const save = (provider: RefreshProvider, service: string, region: string | undefined, url: string, name: string, bytes: Buffer) => {
    const file = `${slug(name)}.json`;
    writeFileSync(join(request.outDir, file), bytes);
    snapshots.push({ provider, format: FORMAT[provider], service, ...(region ? { region } : {}), url, retrievedAt: deps.today, sha256: sha256Hex(bytes), bytes: bytes.byteLength, file });
  };

  for (const provider of request.providers) {
    const regions = request.regions[provider] ?? [];
    if (provider === "aws") {
      const offers = [...new Set(AWS_RULES.flatMap((r) => r.offers))].sort();
      for (const region of regions) {
        for (const offer of offers) {
          const url = `https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/${offer}/current/${region}/index.json`;
          save("aws", offer, region, url, `aws-${offer}-${region}`, (await download(deps, url)).bytes);
        }
      }
    } else if (provider === "gcp") {
      const keyFile = deps.env.ZENITH_LIVE_GCP_CATALOG_API_KEY_FILE;
      if (!keyFile || !isAbsolute(keyFile)) throw new RefreshError("gate", "ZENITH_LIVE_GCP_CATALOG_API_KEY_FILE must be an absolute path to a file holding the API key.");
      const key = (deps.readFile ?? ((p: string) => readFileSync(p, "utf8")))(keyFile).trim();
      if (!key) throw new RefreshError("gate", "The GCP API key file is empty.");
      for (const [service, id] of Object.entries(GCP_SERVICES)) {
        let token = "";
        for (let page = 1; page <= 200; page++) {
          const url = `https://cloudbilling.googleapis.com/v1/services/${id}/skus?currencyCode=USD&pageSize=5000${token ? `&pageToken=${encodeURIComponent(token)}` : ""}`;
          const { bytes } = await download(deps, url, { "x-goog-api-key": key });
          let next = "";
          try {
            next = String((JSON.parse(bytes.toString("utf8")) as { nextPageToken?: string }).nextPageToken ?? "");
          } catch {
            throw new RefreshError("format", "A Cloud Billing Catalog page was not JSON.");
          }
          // One saved file per (service, region, page): the page is saved once per region so each file stays self-describing.
          for (const region of regions) save("gcp", service, region, url, `gcp-${service}-${region}-p${page}`, bytes);
          if (!next) break;
          token = next;
          if (page === 200) throw new RefreshError("format", "Cloud Billing Catalog paging did not finish within 200 pages.");
        }
      }
    } else if (provider === "azure") {
      for (const region of regions) {
        for (const service of AZURE_SERVICES) {
          let url: string | null = `https://prices.azure.com/api/retail/prices?currencyCode='USD'&$filter=${encodeURIComponent(`armRegionName eq '${region}' and serviceName eq '${service}'`)}`;
          for (let page = 1; url && page <= 100; page++) {
            const { bytes } = await download(deps, url);
            let next: string | null = null;
            try {
              next = (JSON.parse(bytes.toString("utf8")) as { NextPageLink?: string | null }).NextPageLink ?? null;
            } catch {
              throw new RefreshError("format", "An Azure Retail Prices page was not JSON.");
            }
            save("azure", service, region, url, `azure-${service}-${region}-p${page}`, bytes);
            url = next;
          }
        }
      }
    } else {
      const { bytes } = await download(deps, OCI_PRICE_LIST_URL);
      save("oci", "OCI public price list", undefined, OCI_PRICE_LIST_URL, "oci-price-list", bytes);
    }
  }
  const manifest: SnapshotManifest = { schema: 1, snapshots };
  writeFileSync(join(request.outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
