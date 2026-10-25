import { createHash } from "node:crypto";
import ledger from "../../../docs/build/production/ledger.json";
import { assertRunId } from "../safety";
import { SCENARIOS, type Call, type Family, type Fixture, type Json, type Plan, type Scenario, type Settings } from "./contracts";

export const FAMILIES: Family[] = ["s3", "iam", "lambda", "ecs", "rds", "dns"];
/** Per-scenario fixture families and declared requirement scope (owner decision D3). */
const scenarios: Record<Scenario, { families: Family[]; scope?: string[] }> = {
  fixtures: { families: FAMILIES },
  "retention-s3": { families: ["s3"], scope: ["PROD-OPS-07"] },
};
export function parseScenario(raw: string): Scenario {
  if (!(SCENARIOS as readonly string[]).includes(raw)) throw new Error("Unknown AWS live scenario");
  return raw as Scenario;
}
/** Requirements this run is accountable for; the rest are reported pending, never failed. */
export function scopedRequirementIds(settings: Settings, requirementIds: string[]): string[] {
  const entry = scenarios[settings.scenario ?? "fixtures"];
  if (!entry) throw new Error("Unknown AWS live scenario");
  return entry.scope ?? requirementIds;
}
export function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function allCalls(plan: Plan): Call[] {
  return [...plan.preflight, ...plan.fixtures.flatMap(f => [...f.setup, ...f.observe, f.ownership, ...f.teardown, ...f.leak, ...(f.product ?? [])])];
}
export function teardownOrder(fixtures: Fixture[]): Fixture[] {
  const ordered: Fixture[] = [], visiting = new Set<Family>(), done = new Set<Family>();
  const visit = (fixture: Fixture) => {
    if (visiting.has(fixture.family)) throw new Error("Cyclic teardown dependencies");
    if (done.has(fixture.family)) return;
    visiting.add(fixture.family);
    for (const dependency of fixture.dependsOn) {
      const parent = fixtures.find(f => f.family === dependency);
      if (!parent) throw new Error("Missing teardown dependency");
      visit(parent);
    }
    visiting.delete(fixture.family); done.add(fixture.family); ordered.push(fixture);
  };
  fixtures.forEach(visit);
  return ordered.reverse();
}
const requirements: Record<string, Family[]> = {
  "PROD-MIX-01": ["lambda", "rds", "iam"], "PROD-MIX-02": ["lambda", "rds"],
  "PROD-MIX-03": ["lambda", "s3", "iam"], "PROD-MIX-04": ["lambda", "rds", "dns"],
  "PROD-MIX-05": ["rds", "dns", "iam"], "PROD-MIX-06": ["lambda", "rds"], "PROD-MIX-07": ["lambda", "rds"],
  "PROD-MAN-01": ["ecs", "iam"], "PROD-MAN-02": ["ecs", "dns", "s3", "rds"], "PROD-MAN-03": ["s3", "dns", "rds"],
  "PROD-MAN-04": ["ecs", "iam", "s3"], "PROD-MAN-05": ["ecs"], "PROD-MAN-06": [], "PROD-MAN-07": [],
  "PROD-OPS-01": ["lambda", "rds"], "PROD-OPS-02": ["ecs", "lambda"], "PROD-OPS-03": ["ecs", "lambda"],
  "PROD-OPS-04": ["s3", "rds"], "PROD-OPS-05": ["iam"], "PROD-OPS-06": ["s3", "rds"], "PROD-OPS-07": ["s3"],
  "PROD-OPS-08": ["iam", "ecs"], "PROD-OPS-09": ["s3", "iam"],
  "PROD-REL-01": FAMILIES, "PROD-REL-02": [], "PROD-REL-03": [], "PROD-REL-04": FAMILIES,
};
export function buildPlan(input: Settings): Plan {
  // Canonical settings omit the default scenario, so existing fixtures digests do not change.
  const { scenario = "fixtures", ...rest } = input;
  parseScenario(scenario);
  const settings: Settings = scenario === "fixtures" ? rest : { ...rest, scenario };
  assertRunId(settings.runId);
  if (!/^\d{12}$/.test(settings.accountId)) throw new Error("Explicit 12-digit sandbox account required");
  if (!/^(us|eu|ap|ca|sa|me|af|il|mx)-(central|north|south|east|west|northeast|northwest|southeast|southwest)-\d$/.test(settings.region)) throw new Error("Commercial AWS region required");
  if (!Number.isInteger(settings.durationMinutes) || settings.durationMinutes < 5 || settings.durationMinutes > 20) throw new Error("Duration must be 5..20 minutes (25 minutes reserved for cleanup)");
  const { accountId: account, region, runId } = settings;
  const prefix = `zenith-${runId}`;
  if (!/^zenith-live-[a-z0-9-]+$/.test(settings.dbSubnetGroup) || !/^sg-[a-f0-9]{8,17}$/.test(settings.dbSecurityGroup)) throw new Error("Owned bootstrap DB network required");
  if (settings.workloadBoundaryArn !== `arn:aws:iam::${account}:policy/ZenithLiveWorkloadBoundary`) throw new Error("Exact sandbox workload boundary required");
  const tags = { "zenith:live-run": runId, "zenith:managed": "true", "zenith:purpose": "live-acceptance" };
  const Tags = Object.entries(tags).map(([Key, Value]) => ({ Key, Value }));
  const arn = (service: string, suffix: string) => `arn:aws:${service}:${region}:${account}:${suffix}`;
  const s3Actions: Record<string, string> = { PutPublicAccessBlock: "PutBucketPublicAccessBlock", GetPublicAccessBlock: "GetBucketPublicAccessBlock", PutBucketEncryption: "PutEncryptionConfiguration", HeadBucket: "ListBucket", ListObjectsV2: "ListBucket", DeleteObjects: "DeleteObject" };
  const call = (id: string, service: string, command: string, resource: string, input: Record<string, Json>, maximumCalls = 1, action = `${service}:${service === "s3" ? s3Actions[command] ?? command : command}`): Call => ({ id, service, command, action, resource, input, maximumCalls });
  const ref = (value: string): Json => ({ $ref: value });
  const bucket = `${prefix}-${account}`, bucketArn = `arn:aws:s3:::${bucket}`;
  const role = `${prefix}-lambda`, roleArn = `arn:aws:iam::${account}:role/${role}`;
  const fn = `${prefix}-fn`, functionArn = arn("lambda", `function:${fn}`);
  const cluster = `${prefix}-ecs`, clusterArn = arn("ecs", `cluster/${cluster}`);
  const db = `${prefix}-db`, dbArn = arn("rds", `db:${db}`);
  const zoneName = `${prefix}.invalid.`;
  // Reserved .invalid name: no real domain purchase or changes to existing DNS.
  const zoneArn = "arn:aws:route53:::hostedzone/${dns-create.HostedZone.Id}";
  const ownership = (family: Family, service: string, command: string, resource: string, input: Record<string, Json>) => call(`${family}-ownership`, service, command, resource, input, 4);
  const families = scenarios[scenario].families;
  // Bounded drain before DeleteBucket: each round lists one page (<=1000 keys) under retention/ and
  // deletes exactly that page; the final empty listing proves the prefix is clear. Guard counts cap
  // the rounds at 5 (5000 objects); a leftover page after that fails cleanup closed.
  const retention: Call[] = scenario === "retention-s3" ? [
    call("s3-retention-list", "s3", "ListObjectsV2", bucketArn, { Bucket: bucket, Prefix: "retention/", MaxKeys: 1000 }, 6),
    call("s3-retention-delete", "s3", "DeleteObjects", `${bucketArn}/retention/*`, { Bucket: bucket, Delete: { Objects: { $keys: "s3-retention-list" }, Quiet: true } }, 5),
  ] : [];
  // Independent readback of the product's archive objects, through the guard only. Object bodies are sealed and
  // larger than the transport's 2 KiB readback cap, so the listing is the S3 evidence; SQL proves the rest.
  const retentionReadback: Call[] = scenario === "retention-s3" ? [
    call("s3-retention-readback-runner", "s3", "ListObjectsV2", bucketArn, { Bucket: bucket, Prefix: `retention/${runId}/runner_job_logs/`, MaxKeys: 100 }, 2),
    call("s3-retention-readback-machine", "s3", "ListObjectsV2", bucketArn, { Bucket: bucket, Prefix: `retention/${runId}/machine_request_logs/`, MaxKeys: 100 }, 2),
  ] : [];
  const allFixtures: Fixture[] = [
    { family: "s3", dependsOn: [], setup: [
      call("s3-create", "s3", "CreateBucket", bucketArn, { Bucket: bucket, ...(region === "us-east-1" ? {} : { CreateBucketConfiguration: { LocationConstraint: region } }) }),
      call("s3-tag", "s3", "PutBucketTagging", bucketArn, { Bucket: bucket, Tagging: { TagSet: Tags } }),
      call("s3-private", "s3", "PutPublicAccessBlock", bucketArn, { Bucket: bucket, PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true } }),
      call("s3-encrypt", "s3", "PutBucketEncryption", bucketArn, { Bucket: bucket, ServerSideEncryptionConfiguration: { Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } }] } }),
      call("s3-put", "s3", "PutObject", `${bucketArn}/probe`, { Bucket: bucket, Key: "probe", Body: runId, ServerSideEncryption: "AES256" }),
    ], observe: [call("s3-read", "s3", "GetObject", `${bucketArn}/probe`, { Bucket: bucket, Key: "probe" }), call("s3-read-private", "s3", "GetPublicAccessBlock", bucketArn, { Bucket: bucket })],
    ownership: ownership("s3", "s3", "GetBucketTagging", bucketArn, { Bucket: bucket }),
    teardown: [...retention, call("s3-delete-object", "s3", "DeleteObject", `${bucketArn}/probe`, { Bucket: bucket, Key: "probe" }), call("s3-delete", "s3", "DeleteBucket", bucketArn, { Bucket: bucket }, 4)],
    leak: [call("s3-leak", "s3", "HeadBucket", bucketArn, { Bucket: bucket }, 4)],
    ...(scenario === "retention-s3" ? { product: retentionReadback } : {}) },
    { family: "iam", dependsOn: [], setup: [call("iam-create", "iam", "CreateRole", roleArn, { RoleName: role, Tags, PermissionsBoundary: settings.workloadBoundaryArn, AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] }) })],
    observe: [call("iam-read", "iam", "GetRole", roleArn, { RoleName: role })], ownership: ownership("iam", "iam", "ListRoleTags", roleArn, { RoleName: role }),
    teardown: [call("iam-delete", "iam", "DeleteRole", roleArn, { RoleName: role }, 4)], leak: [call("iam-leak", "iam", "GetRole", roleArn, { RoleName: role }, 4)] },
    { family: "lambda", dependsOn: ["iam"], setup: [call("lambda-create", "lambda", "CreateFunction", functionArn, { FunctionName: fn, Role: roleArn, Runtime: "nodejs22.x", Handler: "index.handler", Architectures: ["arm64"], MemorySize: 128, Timeout: 3, Tags: tags, Code: { ZipFile: { $artifact: "nonce-lambda.zip" } } }, 12)],
    observe: [call("lambda-ready", "lambda", "GetFunctionConfiguration", functionArn, { FunctionName: fn }, 60), call("lambda-invoke", "lambda", "Invoke", functionArn, { FunctionName: fn, Payload: { nonce: runId } }, 1, "lambda:InvokeFunction")],
    ownership: ownership("lambda", "lambda", "ListTags", functionArn, { Resource: functionArn }), teardown: [call("lambda-delete", "lambda", "DeleteFunction", functionArn, { FunctionName: fn }, 4)],
    leak: [call("lambda-leak", "lambda", "GetFunctionConfiguration", functionArn, { FunctionName: fn }, 4)] },
    { family: "ecs", dependsOn: [], setup: [call("ecs-create", "ecs", "CreateCluster", clusterArn, { clusterName: cluster, tags: Tags.map(t => ({ key: t.Key, value: t.Value })), settings: [{ name: "containerInsights", value: "disabled" }] })],
    observe: [call("ecs-read", "ecs", "DescribeClusters", clusterArn, { clusters: [clusterArn], include: ["TAGS"] })],
    ownership: ownership("ecs", "ecs", "ListTagsForResource", clusterArn, { resourceArn: clusterArn }), teardown: [call("ecs-delete", "ecs", "DeleteCluster", clusterArn, { cluster: clusterArn }, 4)],
    leak: [call("ecs-leak", "ecs", "DescribeClusters", clusterArn, { clusters: [clusterArn] }, 4)] },
    { family: "rds", dependsOn: [], setup: [call("rds-create", "rds", "CreateDBInstance", dbArn, { DBInstanceIdentifier: db, Engine: "postgres", DBInstanceClass: "db.t4g.micro", AllocatedStorage: 20, StorageType: "gp3", StorageEncrypted: true, MasterUsername: "zenithlive", ManageMasterUserPassword: true, DBSubnetGroupName: settings.dbSubnetGroup, VpcSecurityGroupIds: [settings.dbSecurityGroup], PubliclyAccessible: false, MultiAZ: false, BackupRetentionPeriod: 0, DeletionProtection: false, AutoMinorVersionUpgrade: false, CopyTagsToSnapshot: true, Tags })],
    observe: [call("rds-ready", "rds", "DescribeDBInstances", dbArn, { DBInstanceIdentifier: db }, 180)],
    ownership: ownership("rds", "rds", "ListTagsForResource", dbArn, { ResourceName: dbArn }),
    teardown: [call("rds-delete", "rds", "DeleteDBInstance", dbArn, { DBInstanceIdentifier: db, SkipFinalSnapshot: true, DeleteAutomatedBackups: true }, 180)],
    leak: [call("rds-leak", "rds", "DescribeDBInstances", dbArn, { DBInstanceIdentifier: db }, 300), call("rds-secret-leak", "secretsmanager", "DescribeSecret", arn("secretsmanager", "secret:rds!db-*"), { SecretId: ref("rds-secret.SecretArn") }, 180)] },
    { family: "dns", dependsOn: [], setup: [
      call("dns-create", "route53", "CreateHostedZone", "*", { Name: zoneName, CallerReference: runId, HostedZoneConfig: { Comment: `Zenith disposable ${runId}` } }),
      call("dns-tag", "route53", "ChangeTagsForResource", zoneArn, { ResourceType: "hostedzone", ResourceId: ref("dns-create.HostedZone.Id"), AddTags: Tags }),
      call("dns-put", "route53", "ChangeResourceRecordSets", zoneArn, { HostedZoneId: ref("dns-create.HostedZone.Id"), ChangeBatch: { Changes: [{ Action: "CREATE", ResourceRecordSet: { Name: `probe.${zoneName}`, Type: "TXT", TTL: 60, ResourceRecords: [{ Value: `"${runId}"` }] } }] } }),
    ], observe: [call("dns-read", "route53", "ListResourceRecordSets", zoneArn, { HostedZoneId: ref("dns-create.HostedZone.Id"), MaxItems: "10" })],
    ownership: ownership("dns", "route53", "ListTagsForResource", zoneArn, { ResourceType: "hostedzone", ResourceId: ref("dns-create.HostedZone.Id") }),
    teardown: [call("dns-remove-record", "route53", "ChangeResourceRecordSets", zoneArn, { HostedZoneId: ref("dns-create.HostedZone.Id"), ChangeBatch: { Changes: [{ Action: "DELETE", ResourceRecordSet: { Name: `probe.${zoneName}`, Type: "TXT", TTL: 60, ResourceRecords: [{ Value: `"${runId}"` }] } }] } }), call("dns-delete", "route53", "DeleteHostedZone", zoneArn, { Id: ref("dns-create.HostedZone.Id") }, 4)],
    leak: [call("dns-leak", "route53", "GetHostedZone", zoneArn, { Id: ref("dns-create.HostedZone.Id") }, 4)] },
  ];
  const fixtures = allFixtures.filter(f => families.includes(f.family));
  const preflight = [
    call("identity", "sts", "GetCallerIdentity", "*", {}, 4),
    call("marker", "ssm", "GetParameter", arn("ssm", "parameter/zenith/live-sandbox"), { Name: "/zenith/live-sandbox", WithDecryption: false }, 4),
    call("run-claim", "ssm", "PutParameter", arn("ssm", `parameter/zenith/live-runs/${runId}`), { Name: `/zenith/live-runs/${runId}`, Type: "String", Tier: "Standard", Overwrite: false, Value: runId, Tags: Tags.map(t => t.Key === "zenith:purpose" ? { ...t, Value: "live-acceptance-receipt" } : t) }),
    call("run-claim-read", "ssm", "GetParameter", arn("ssm", `parameter/zenith/live-runs/${runId}`), { Name: `/zenith/live-runs/${runId}`, WithDecryption: false }, 4),
    // Database network proof applies only when an RDS fixture is planned.
    ...(families.includes("rds") ? [
      call("db-network", "rds", "DescribeDBSubnetGroups", arn("rds", `subgrp:${settings.dbSubnetGroup}`), { DBSubnetGroupName: settings.dbSubnetGroup }),
      call("db-security", "ec2", "DescribeSecurityGroups", "*", { GroupIds: [settings.dbSecurityGroup] }),
    ] : []),
    call("prior-leaks", "tag", "GetResources", "*", { TagFilters: [{ Key: "zenith:purpose", Values: ["live-acceptance"] }], ResourcesPerPage: 100 }, 100),
    // A deleted ECS cluster stays INACTIVE (no tasks, no cost) and still appears in the tag inventory.
    // Only owned run clusters are described, at most 100 per call; any other tagged resource still blocks.
    call("prior-leaks-ecs", "ecs", "DescribeClusters", arn("ecs", "cluster/zenith-zlive-*-ecs"), { clusters: [] }, 10),
    ...(families.includes("dns") ? [call("dns-discover", "route53", "ListHostedZonesByName", "*", { DNSName: zoneName, MaxItems: "2" }, 4)] : []),
    ...fixtures.filter(f => f.family !== "dns").map(f => ({ ...f.leak[0], id: `${f.family}-preexist`, maximumCalls: 1 })),
  ];
  // Retention S3 cost: S3 LIST/PUT are $0.005 per 1,000 requests, DELETE is free, and storage of
  // under 1 MiB for under an hour is far below a cent. The 0.25 base and 0.01/minute are generous
  // ceilings for a few dozen planned requests plus retries; the 0.25 reserve is kept for cleanup.
  // Duration bounds stay 5..20 because the product archive/restore path runs inside that window.
  const estimate: Plan["estimate"] = scenario === "retention-s3" ? { usd: 0.25 + settings.durationMinutes * 0.01, cleanupReserveUsd: 0.25, provisional: true, basis: "Conservative provisional USD ceiling for one owned S3 bucket, a few sealed objects under retention/, a bounded list/delete drain and a few dozen planned S3 requests; includes 0.25USD cleanup reserve. No RDS, ECS, DNS, IAM or Lambda cost. Owner must validate regional S3 rates." } : { usd: 6 + settings.durationMinutes * 0.03, cleanupReserveUsd: 2, provisional: true, basis: "Conservative provisional USD ceiling: one private 20GiB db.t4g.micro <=45min including cleanup, one 128MiB Lambda invocation, one empty ECS cluster, <=1KiB S3, one disposable hosted zone, managed DB secret; includes 2USD cleanup reserve. Owner must validate regional rates; delayed deletion can exceed estimate." };
  const body: Omit<Plan, "sha256"> = {
    schema: 1, settings, tags, fixtures, preflight, estimate,
    requirements: ledger.requirements.filter(r => r.requiredEvidence.includes("live_sandbox")).map(r => ({ id: r.id, acceptance: r.acceptance, fixtures: requirements[r.id] ?? [], join: "Wave 5 release ProductScenarioPort: real approved product operations, independent traffic/readback, quiescence. AWS fixtures alone do not meet this requirement." })),
  };
  return { ...body, sha256: digest(body) };
}
