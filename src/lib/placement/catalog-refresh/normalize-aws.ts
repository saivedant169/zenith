/**
 * AWS Price List Bulk API normalizer. Input: one regional offer file
 * (`https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/<OfferCode>/current/<region>/index.json`),
 * saved with its checksum. Output: observations for the catalog SKUs the rules
 * below know how to read.
 *
 * Rules match product attributes and the usage type suffix (region prefixes such
 * as `APS3-` are tolerated), check the price dimension's unit, and refuse to
 * guess: no match, several different prices, or an unexpected unit all become
 * `skipped` entries and leave the old catalog value alone.
 *
 * HONEST LIMIT: these rules encode the documented shape of the Price List
 * files. They are exercised in tests against recorded fixtures shaped like the
 * official format, not against live files; the first live refresh must be
 * reviewed through the coverage report before its catalog is adopted.
 */
import { buildTiered, resolveCandidates, toNumber, type Dimension, type Priced } from "@/lib/placement/catalog-refresh/common";
import type { NormalizeResult, Normalizer, PriceObservation, Skipped } from "@/lib/placement/catalog-refresh/types";
import type { PriceEntry } from "@/lib/placement/types";

type Attrs = Readonly<Record<string, string | undefined>>;
interface Product {
  sku?: string;
  productFamily?: string;
  attributes?: Attrs;
}

interface AwsRule {
  sku: string;
  unit: PriceEntry["unit"];
  offers: readonly string[];
  match: (product: Product, attrs: Attrs, usage: string) => boolean;
  /** accepted `priceDimensions[].unit` values */
  dimUnit: RegExp;
  /** multiply the provider price to reach the catalog unit (per-request -> per-million) */
  scale?: number;
  /** `tiers`: first paid price plus volume tiers; `first_paid`: first positive dimension only */
  pick: "tiers" | "first_paid";
  how?: "single" | "mode";
  note: string;
}

const usage = (re: RegExp) => (_p: Product, _a: Attrs, u: string) => re.test(u);
const suffix = (s: string) => new RegExp(`(^|-)${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);

function instance(offer: string, sku: string, instanceType: string, extra: (a: Attrs) => boolean, family: string, note: string): AwsRule {
  return {
    sku,
    unit: "hour",
    offers: [offer],
    match: (p, a) => p.productFamily === family && a.instanceType === instanceType && extra(a),
    dimUnit: /hrs?|hour/i,
    pick: "first_paid",
    note,
  };
}

const ec2 = (sku: string, type: string) =>
  instance("AmazonEC2", sku, type, (a) => a.operatingSystem === "Linux" && a.tenancy === "Shared" && a.capacitystatus === "Used" && a.preInstalledSw === "NA", "Compute Instance", `${type} Linux shared on-demand`);
const rds = (sku: string, type: string) =>
  instance("AmazonRDS", sku, type, (a) => a.databaseEngine === "PostgreSQL" && a.deploymentOption === "Single-AZ", "Database Instance", `${type} PostgreSQL Single-AZ`);
const cache = (sku: string, type: string) =>
  // Plain NodeUsage only: Extended Support usage types (year 1-2, year 3) carry the same instance type at other prices.
  instance("AmazonElastiCache", sku, type, (a) => a.cacheEngine === "Redis" && /^(?:[A-Z0-9]+-)?NodeUsage:/.test(a.usagetype ?? ""), "Cache Instance", `${type} Redis on-demand node`);

export const AWS_RULES: readonly AwsRule[] = [
  { sku: "aws.nat_gateway.hour", unit: "hour", offers: ["AmazonEC2", "AmazonVPC"], match: usage(suffix("NatGateway-Hours")), dimUnit: /hrs?|hour/i, pick: "first_paid", note: "NAT Gateway hourly charge" },
  { sku: "aws.nat_gateway.gb", unit: "gb", offers: ["AmazonEC2", "AmazonVPC"], match: usage(suffix("NatGateway-Bytes")), dimUnit: /^gb$/i, pick: "first_paid", note: "NAT Gateway data processed per GB" },
  { sku: "aws.ipv4.hour", unit: "hour", offers: ["AmazonVPC", "AmazonEC2"], match: usage(suffix("PublicIPv4:InUseAddress")), dimUnit: /hrs?|hour/i, pick: "first_paid", note: "Public IPv4 address in use, per hour" },
  {
    sku: "aws.data_transfer.internet_gb",
    unit: "gb",
    offers: ["AWSDataTransfer"],
    match: (_p, a, u) => a.transferType === "AWS Outbound" && suffix("DataTransfer-Out-Bytes").test(u),
    dimUnit: /^gb$/i,
    pick: "tiers",
    note: "Data transfer out to internet; first paid tier price from 0 GB (free allowance not deducted), provider volume tiers from their cumulative GB boundaries",
  },
  {
    sku: "aws.data_transfer.inter_region_gb",
    unit: "gb",
    offers: ["AWSDataTransfer"],
    match: (_p, a, u) => a.transferType === "InterRegion Outbound" && suffix("AWS-Out-Bytes").test(u),
    dimUnit: /^gb$/i,
    pick: "first_paid",
    how: "mode",
    note: "Data transfer to another AWS region; most common destination rate, higher rate on a tie",
  },
  {
    sku: "aws.data_transfer.inter_az_gb",
    unit: "gb",
    offers: ["AmazonEC2", "AWSDataTransfer"],
    match: usage(suffix("DataTransfer-Regional-Bytes")),
    dimUnit: /^gb$/i,
    pick: "first_paid",
    note: "Data transfer between availability zones in a region, per GB; AWS bills it in each direction",
  },
  // Outposts and Trust Store usage types share the LoadBalancerUsage suffix; the group description names the plain ALB hour.
  { sku: "aws.alb.hour", unit: "hour", offers: ["AWSELB"], match: (p, a, u) => p.productFamily === "Load Balancer-Application" && suffix("LoadBalancerUsage").test(u) && !/Outposts/.test(u) && (a.groupDescription === undefined || a.groupDescription === "LoadBalancer hourly usage by Application Load Balancer"), dimUnit: /hrs?|hour/i, pick: "first_paid", note: "Application Load Balancer hourly charge" },
  { sku: "aws.alb.lcu_hour", unit: "hour", offers: ["AWSELB"], match: (p, _a, u) => p.productFamily === "Load Balancer-Application" && suffix("LCUUsage").test(u), dimUnit: /lcu|hrs?|hour/i, pick: "first_paid", note: "ALB Load Balancer Capacity Unit hour" },
  { sku: "aws.fargate.vcpu_hour", unit: "hour", offers: ["AmazonECS"], match: usage(suffix("Fargate-vCPU-Hours:perCPU")), dimUnit: /hour|hrs?/i, pick: "first_paid", note: "Fargate Linux/X86 on-demand, per vCPU-hour" },
  { sku: "aws.fargate.gb_hour", unit: "hour", offers: ["AmazonECS"], match: usage(suffix("Fargate-GB-Hours")), dimUnit: /hour|hrs?/i, pick: "first_paid", note: "Fargate Linux/X86 on-demand, per GB-hour" },
  { sku: "aws.ebs.gp3_gb_month", unit: "gb_month", offers: ["AmazonEC2"], match: (_p, a, u) => a.volumeApiName === "gp3" && suffix("EBS:VolumeUsage.gp3").test(u), dimUnit: /gb-mo/i, pick: "first_paid", note: "EBS gp3 storage" },
  { sku: "aws.ebs.gp3_iops_month", unit: "iops_month", offers: ["AmazonEC2"], match: (_p, a, u) => a.volumeApiName === "gp3" && suffix("EBS:VolumeP-IOPS.gp3").test(u), dimUnit: /iops-mo/i, pick: "first_paid", note: "EBS gp3 provisioned IOPS above baseline" },
  { sku: "aws.ebs.snapshot_gb_month", unit: "gb_month", offers: ["AmazonEC2"], match: usage(suffix("EBS:SnapshotUsage")), dimUnit: /gb-mo/i, pick: "first_paid", note: "EBS snapshot storage (standard tier)" },
  { sku: "aws.rds_postgres.storage_gb_month", unit: "gb_month", offers: ["AmazonRDS"], match: (_p, a, u) => a.deploymentOption === "Single-AZ" && suffix("RDS:GP3-Storage").test(u), dimUnit: /gb-mo/i, pick: "first_paid", note: "RDS gp3 storage Single-AZ" },
  { sku: "aws.rds_postgres.iops_month", unit: "iops_month", offers: ["AmazonRDS"], match: (_p, a, u) => a.deploymentOption === "Single-AZ" && suffix("RDS:GP3-PIOPS").test(u), dimUnit: /iops-mo/i, pick: "first_paid", note: "RDS gp3 provisioned IOPS above baseline, Single-AZ" },
  { sku: "aws.rds_postgres.backup_gb_month", unit: "gb_month", offers: ["AmazonRDS"], match: usage(suffix("RDS:ChargedBackupUsage")), dimUnit: /gb-mo/i, pick: "first_paid", note: "RDS backup storage beyond the free allowance" },
  { sku: "aws.s3.storage_gb_month", unit: "gb_month", offers: ["AmazonS3"], match: (_p, a, u) => a.volumeType === "Standard" && suffix("TimedStorage-ByteHrs").test(u), dimUnit: /gb-mo/i, pick: "first_paid", note: "S3 Standard first paid tier" },
  { sku: "aws.s3.get_million", unit: "million_requests", offers: ["AmazonS3"], match: usage(suffix("Requests-Tier2")), dimUnit: /requests?/i, scale: 1e6, pick: "first_paid", note: "S3 GET/SELECT (Tier 2) per million" },
  { sku: "aws.s3.put_million", unit: "million_requests", offers: ["AmazonS3"], match: usage(suffix("Requests-Tier1")), dimUnit: /requests?/i, scale: 1e6, pick: "first_paid", note: "S3 PUT/COPY/POST/LIST (Tier 1) per million" },
  // us-east-1 names the Standard tier-1 usage type Requests-RBP; the group attribute is stable in every region.
  { sku: "aws.sqs.requests_million", unit: "million_requests", offers: ["AWSQueueService"], match: (_p, a, u) => a.group !== undefined ? a.queueType === "Standard" && a.group === "SQS-APIRequest-Tier1" : suffix("Requests-Tier1").test(u), dimUnit: /requests?/i, scale: 1e6, pick: "first_paid", note: "SQS Standard queue requests per million (first paid tier)" },
  { sku: "aws.route53.zone_month", unit: "month", offers: ["AmazonRoute53"], match: usage(suffix("HostedZone")), dimUnit: /.*/, pick: "first_paid", note: "Route 53 hosted zone (first paid tier)" },
  { sku: "aws.route53.queries_million", unit: "million_requests", offers: ["AmazonRoute53"], match: usage(suffix("DNS-Queries")), dimUnit: /quer/i, scale: 1e6, pick: "first_paid", note: "Route 53 standard queries, first paid tier" },
  { sku: "aws.cloudwatch.logs_ingest_gb", unit: "gb", offers: ["AmazonCloudWatch"], match: (p, _a, u) => p.productFamily === "Data Payload" && suffix("DataProcessing-Bytes").test(u), dimUnit: /^gb$/i, pick: "first_paid", note: "CloudWatch Logs standard ingestion per GB" },
  { sku: "aws.cloudwatch.logs_storage_gb_month", unit: "gb_month", offers: ["AmazonCloudWatch"], match: usage(suffix("TimedStorage-ByteHrs")), dimUnit: /gb-mo/i, pick: "first_paid", note: "CloudWatch Logs storage" },
  ec2("aws.ec2.small_hour", "t3.small"),
  ec2("aws.ec2.medium_hour", "t3.medium"),
  ec2("aws.ec2.large_hour", "m6i.large"),
  rds("aws.rds_postgres.nano_hour", "db.t4g.micro"),
  rds("aws.rds_postgres.small_hour", "db.t4g.small"),
  rds("aws.rds_postgres.standard_hour", "db.t4g.medium"),
  rds("aws.rds_postgres.performance_hour", "db.m6g.large"),
  cache("aws.elasticache_redis.nano_hour", "cache.t4g.micro"),
  cache("aws.elasticache_redis.small_hour", "cache.t4g.small"),
  cache("aws.elasticache_redis.standard_hour", "cache.t4g.medium"),
  cache("aws.elasticache_redis.performance_hour", "cache.m6g.large"),
];

interface PriceDimension {
  unit?: string;
  beginRange?: string;
  pricePerUnit?: { USD?: string };
}

interface OfferFile {
  offerCode?: string;
  publicationDate?: string;
  products?: Record<string, Product>;
  terms?: { OnDemand?: Record<string, Record<string, { priceDimensions?: Record<string, PriceDimension> }>> };
}

export const normalizeAws: Normalizer = (text, snapshot): NormalizeResult => {
  const region = snapshot.region;
  const skipped: Skipped[] = [];
  const observations: PriceObservation[] = [];
  let file: OfferFile;
  try {
    file = JSON.parse(text) as OfferFile;
  } catch {
    return { observations, skipped: [{ sku: "(file)", region: region ?? "", reason: "not valid JSON" }] };
  }
  if (!region || !file.products || !file.terms?.OnDemand) return { observations, skipped: [{ sku: "(file)", region: region ?? "", reason: "not an AWS regional offer file" }] };
  const offer = file.offerCode ?? snapshot.service;
  const pubDate = file.publicationDate ?? "unknown publication date";

  for (const rule of AWS_RULES) {
    if (!rule.offers.includes(offer)) continue;
    const candidates: Priced[] = [];
    let unitProblem: string | undefined;
    for (const [id, product] of Object.entries(file.products)) {
      const attrs = product.attributes ?? {};
      const usageType = attrs.usagetype ?? "";
      const fileRegion = attrs.regionCode ?? attrs.fromRegionCode;
      if (fileRegion !== undefined && fileRegion !== region) continue;
      if (!rule.match(product, attrs, usageType)) continue;
      const terms = file.terms.OnDemand[id];
      if (!terms) continue;
      const dims: Dimension[] = [];
      for (const term of Object.values(terms)) {
        for (const d of Object.values(term.priceDimensions ?? {})) {
          if (d.unit !== undefined && !rule.dimUnit.test(d.unit)) {
            unitProblem = `unexpected price unit "${String(d.unit).slice(0, 40)}"`;
            continue;
          }
          const usd = toNumber(d.pricePerUnit?.USD);
          const from = toNumber(d.beginRange ?? "0");
          if (usd === undefined || from === undefined) continue;
          dims.push({ from, usd: usd * (rule.scale ?? 1) });
        }
      }
      if (dims.length === 0) continue;
      if (rule.pick === "tiers") {
        const tiered = buildTiered(dims);
        if (tiered) candidates.push(tiered);
      } else {
        const first = [...dims].sort((a, b) => a.from - b.from).find((d) => d.usd > 0);
        if (first) candidates.push({ usd: first.usd });
      }
    }
    if (candidates.length === 0 && unitProblem) {
      skipped.push({ sku: rule.sku, region, reason: unitProblem });
      continue;
    }
    const resolved = resolveCandidates(candidates, rule.how ?? "single");
    if (!resolved.ok) {
      skipped.push({ sku: rule.sku, region, reason: resolved.reason });
      continue;
    }
    observations.push({
      provider: "aws",
      region,
      sku: rule.sku,
      unit: rule.unit,
      usd: resolved.priced.usd,
      ...(resolved.priced.tiers ? { tiers: resolved.priced.tiers } : {}),
      note: `${rule.note} (AWS Price List ${offer}, published ${pubDate})`,
      snapshotSha256: snapshot.sha256,
    });
  }
  return { observations, skipped };
};

export function awsRefreshableSkus(): string[] {
  return AWS_RULES.map((r) => r.sku);
}
