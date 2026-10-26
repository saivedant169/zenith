/** CONTRACT ONLY: modeled transport, never AWS evidence. */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { load } from "js-yaml";
// Real installed SDK v3 error classes: `name` is what the harness matches.
import { DeleteConflictException, NoSuchEntityException } from "@aws-sdk/client-iam";
import { NotFound } from "@aws-sdk/client-s3";
import { ResourceNotFoundException as LambdaNotFound } from "@aws-sdk/client-lambda";
import { DBInstanceNotFoundFault } from "@aws-sdk/client-rds";
import { NoSuchHostedZone } from "@aws-sdk/client-route-53";
import { ResourceNotFoundException as SecretNotFound } from "@aws-sdk/client-secrets-manager";
import { buildPlan, allCalls, digest, FAMILIES, scopedRequirementIds, teardownOrder } from "../../scripts/acceptance/live/plan";
import { runLiveCli } from "../../scripts/acceptance/aws-live";
import { Guard, grantsFor, readPermission } from "../../scripts/acceptance/live/guard";
import { execute, newJournal, missing, absent, owned, checkReadback, executionProvenance } from "../../scripts/acceptance/live/execute";
import { evidencePacket } from "../../scripts/acceptance/live/evidence";
import { resumeCommand, runProductionCli } from "../../scripts/acceptance/live/cli";
import { redactAcceptance } from "../../scripts/acceptance/redact";
import { requireProductionScope } from "../../scripts/acceptance/live/scope";
import { approvedManifest } from "../release/_support";
import { nonceZip, resolveInput, sessionCredentials } from "../../scripts/acceptance/live/sdk";
import type { AwsPermission, Call, Family, Journal, Json, Plan, Transport } from "../../scripts/acceptance/live/contracts";

const now = () => new Date("2026-10-08T00:00:00Z");
const settings = { accountId: "123456789012", region: "ap-south-1", runId: "zlive-202610080000-abcd", durationMinutes: 15, dbSubnetGroup: "zenith-live-sandbox", dbSecurityGroup: "sg-12345678", workloadBoundaryArn: "arn:aws:iam::123456789012:policy/ZenithLiveWorkloadBoundary" };
const plan = () => buildPlan({ ...settings });
const permission = (p = plan()): AwsPermission => ({ schema: 1, decision: "DEC-CLOUD", approvedBy: "Owner fixture", approvedAt: "2026-10-07T23:59:00Z", expiresAt: "2026-10-08T01:00:00Z", sourceCommit: "a".repeat(40), accountId: settings.accountId, region: settings.region, runId: settings.runId, planSha256: p.sha256, maxUsd: 10, maxMinutes: 20, grants: grantsFor(p) });
const makeGuard = (p = plan()) => new Guard(p, permission(p), 10, now);
const error = (name: string) => Object.assign(new Error("modeled provider failure"), { name });
function modeled(p: Plan, fail?: (call: Call) => boolean) {
  const present = new Set<Family>(), calls: Call[] = [], tags = new Set<Family>();
  const transport: Transport = { async send(c, _input) {
    calls.push(c);
    if (fail?.(c)) throw error("AccessDeniedException");
    const family = c.id.split("-")[0] as Family;
    if (c.id === "identity") return { Account: settings.accountId, Arn: `arn:aws:sts::${settings.accountId}:assumed-role/ZenithLiveAcceptance/contract` };
    if (c.id === "marker") return { Parameter: { Value: "true" } };
    if (c.id === "run-claim") return { Version: 1 };
    if (c.id === "run-claim-read") return { Parameter: { Value: settings.runId } };
    if (c.id === "db-network") return { DBSubnetGroups: [{ VpcId: "vpc-modeled", Subnets: [{}, {}] }] };
    if (c.id === "db-security") return { SecurityGroups: [{ VpcId: "vpc-modeled", IpPermissions: [], Tags: [{ Key: "zenith:bootstrap", Value: "live-sandbox" }] }] };
    if (c.id === "prior-leaks") return { ResourceTagMappingList: [] };
    if (c.id === "dns-discover") return { HostedZones: present.has("dns") ? [{ Name: `zenith-${settings.runId}.invalid.`, Id: "/hostedzone/ZCONTRACT" }] : [] };
    if (c.id.endsWith("-create")) {
      present.add(family);
      if (!["s3", "dns"].includes(family)) tags.add(family);
      return family === "dns" ? { HostedZone: { Id: "/hostedzone/ZCONTRACT" } } : {};
    }
    if (c.id.endsWith("-tag")) { tags.add(family); return {}; }
    if (c.id.endsWith("-preexist") || c.id.endsWith("-leak")) {
      if (!present.has(family)) {
        if (family === "ecs") return { clusters: [], failures: [{ reason: "MISSING" }] };
        // HeadBucket has no body, so the SDK reports a 404 as "NotFound".
        throw error({ s3: "NotFound", iam: "NoSuchEntityException", lambda: "ResourceNotFoundException", rds: "DBInstanceNotFoundFault", dns: "NoSuchHostedZone", ecs: "unused" }[family]);
      }
      return family === "ecs" ? { clusters: [{ status: "ACTIVE" }], failures: [] } : family === "dns" ? { HostedZone: { Name: `zenith-${settings.runId}.invalid.`, CallerReference: settings.runId } } : family === "rds" ? { DBInstances: [{ MasterUserSecret: { SecretArn: `arn:aws:secretsmanager:${settings.region}:${settings.accountId}:secret:rds!db-contract` } }] } : {};
    }
    // Real shapes: S3 reports an untagged bucket as NoSuchTagSet; Route 53 returns an empty tag list.
    if (c.id.endsWith("-ownership")) {
      if (family === "s3" && !tags.has(family)) throw error("NoSuchTagSet");
      if (family === "dns") return { ResourceTagSet: { Tags: tags.has(family) ? Object.entries(p.tags).map(([Key, Value]) => ({ Key, Value })) : [] } };
      return { Tags: tags.has(family) ? p.tags : {} };
    }
    if (c.id.endsWith("-delete")) { present.delete(family); return {}; }
    if (c.id === "s3-read") return { Body: p.settings.runId };
    if (c.id === "s3-read-private") return { PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true } };
    if (c.id === "iam-read") return { Role: { PermissionsBoundary: { PermissionsBoundaryArn: settings.workloadBoundaryArn } } };
    if (c.id === "lambda-ready") return { State: "Active" };
    if (c.id === "lambda-invoke") return { StatusCode: 200, Payload: JSON.stringify({ nonce: p.settings.runId }) };
    if (c.id === "ecs-read") return { clusters: [{ status: "ACTIVE", clusterName: `zenith-${settings.runId}-ecs` }], failures: [] };
    if (c.id === "rds-ready") return { DBInstances: [{ DBInstanceStatus: "available", PubliclyAccessible: false, StorageEncrypted: true, MultiAZ: false, MasterUserSecret: { SecretArn: `arn:aws:secretsmanager:${settings.region}:${settings.accountId}:secret:rds!db-contract` } }] };
    if (c.id === "rds-secret-leak") throw error("ResourceNotFoundException");
    if (c.id === "dns-read") return { ResourceRecordSets: [{ Type: "TXT", Name: `probe.zenith-${settings.runId}.invalid.`, ResourceRecords: [{ Value: `"${settings.runId}"` }] }] };
    return {};
  } };
  return { transport, calls, present, tags };
}
async function run(fail?: (c: Call) => boolean) {
  const p = plan(), guard = makeGuard(p), model = modeled(p, fail), journal = newJournal(p, guard, "a".repeat(40), now());
  let saves = 0;
  await execute(p, guard, model.transport, journal, { now, sleep: async () => undefined, save: async state => { saves++; expect(state.counts).toEqual(guard.counts); } });
  return { p, guard, model, journal, saves };
}
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

async function rootScopeFile(edit?: (raw: Record<string, unknown>) => void) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "aws-production-scope-")); directories.push(directory);
  const file = path.join(directory, "scope.json");
  // The fixture's plan runs in ap-south-1; the test sandbox must confirm that region for the root to admit it.
  await writeFile(file, JSON.stringify(approvedManifest(raw => { (raw.sandboxes as { aws: { regions: string[] } }).aws.regions = ["ap-south-1"]; edit?.(raw); })));
  return { ZENITH_LIVE_SCOPE_FILE: file };
}

describe("production root scope join (offline)", () => {
  it("refuses a plan whose account is not the shipped root's confirmed sandbox", () => {
    expect(() => requireProductionScope(plan(), 10, {}, false, () => new Date("2026-10-25T00:00:00Z"))).toThrow(/not the owner-confirmed sandbox/);
  });
  it("refuses a plan in an account other than the confirmed sandbox, including recovery", async () => {
    const env = await rootScopeFile();
    const other = buildPlan({ ...settings, accountId: "210987654321", workloadBoundaryArn: "arn:aws:iam::210987654321:policy/ZenithLiveWorkloadBoundary" });
    expect(() => requireProductionScope(other, 10, env, false, now)).toThrow(/not the owner-confirmed sandbox/);
    expect(() => requireProductionScope(other, 10, env, true, now)).toThrow(/not the owner-confirmed sandbox/);
  });
  it("refuses a plan in a region the confirmed sandbox does not list", async () => {
    const env = await rootScopeFile();
    expect(() => requireProductionScope(buildPlan({ ...settings, region: "us-west-2" }), 10, env, false, now)).toThrow(/not the owner-confirmed sandbox/);
  });
  it("admits the approved run and separately grants owned recovery", async () => {
    const env = await rootScopeFile();
    expect(() => requireProductionScope(plan(), 10, env, false, now)).not.toThrow();
    expect(() => requireProductionScope(plan(), 10, env, true, now)).not.toThrow();
  });
  it.each(["perRunUsd", "totalUsd", "provider", "harness"])("honors the root %s ceiling", async ceiling => {
    const env = await rootScopeFile(raw => {
      const budgets = raw.budgets as { perRunUsd: number; totalUsd: number; perProviderPerRunUsd: Record<string, number> };
      const harnesses = raw.harnesses as Record<string, { maxRunUsd: number }>;
      if (ceiling === "provider") budgets.perProviderPerRunUsd.aws = 9;
      else if (ceiling === "harness") harnesses["aws-live"].maxRunUsd = 9;
      else if (ceiling === "totalUsd") budgets.totalUsd = 9;
      else { budgets.perRunUsd = 9; for (const grant of Object.values(harnesses)) grant.maxRunUsd = Math.min(grant.maxRunUsd, 9); }
    });
    expect(() => requireProductionScope(plan(), 10, env, false, now)).toThrow(/root scope ceiling/);
  });
  it("refuses a missing teardown grant before creating resources", async () => {
    const env = await rootScopeFile(raw => {
      const grant = (raw.harnesses as Record<string, { actions: string[] }>)["aws-live"];
      grant.actions = grant.actions.filter(action => action !== "teardown_run_tagged");
    });
    expect(() => requireProductionScope(plan(), 10, env, false, now)).toThrow(/teardown_run_tagged/);
    expect(() => requireProductionScope(plan(), 10, env, true, now)).toThrow(/teardown_run_tagged/);
  });
  it("allows cleanup-only grants without allowing new setup", async () => {
    const env = await rootScopeFile(raw => { (raw.harnesses as Record<string, { actions: string[] }>)["aws-live"].actions = ["read", "teardown_run_tagged"]; });
    expect(() => requireProductionScope(plan(), 10, env, true, now)).not.toThrow();
    expect(() => requireProductionScope(plan(), 10, env, false, now)).toThrow(/mutate_run_tagged/);
  });
  it("enforces the root lifetime and run tag for setup and recovery", async () => {
    const env = await rootScopeFile(raw => { (raw.budgets as { maxRunTtlMinutes: number }).maxRunTtlMinutes = 5; });
    expect(() => requireProductionScope(plan(), 10, env, false, now)).toThrow(/lifetime/);
    const foreign = plan(); foreign.tags["zenith:live-run"] = "foreign";
    expect(() => requireProductionScope(foreign, 10, env, true, now)).toThrow(/only this run/);
  });
});

describe("AWS production planner (offline)", () => {
  it("prints deterministic exact inputs, call ceilings, ownership and provisional costs", () => {
    const p = plan(); expect(p).toEqual(plan()); expect(p.fixtures.map(f => f.family)).toEqual(FAMILIES);
    expect(p.requirements).toHaveLength(27); expect(p.requirements.every(r => r.acceptance.length > 0 && r.join.includes("Wave 5"))).toBe(true);
    const { sha256, ...body } = p; expect(digest(body)).toBe(sha256);
    expect(p.estimate.usd).toBeGreaterThan(p.estimate.cleanupReserveUsd);
    expect(allCalls(p).every(c => c.maximumCalls > 0 && c.input && c.action && c.resource)).toBe(true);
  });
  it.each(["cn-north-1", "us-gov-west-1", "", "not-a-region"])("refuses unsupported region %s", region => expect(() => buildPlan({ ...settings, region })).toThrow());
  it.each([0, -1, NaN, 4, 21, 100, 5.5])("bounds duration %s", durationMinutes => expect(() => buildPlan({ ...settings, durationMinutes })).toThrow());
  it("keeps RDS private/encrypted, DNS reserved, IAM bounded and ECS scope explicit", () => {
    const p = plan(), calls = allCalls(p);
    expect(calls.find(c => c.id === "rds-create")!.input).toMatchObject({ PubliclyAccessible: false, StorageEncrypted: true, ManageMasterUserPassword: true });
    expect(calls.find(c => c.id === "dns-create")!.input.Name).toMatch(/\.invalid\.$/);
    expect(calls.find(c => c.id === "iam-create")!.input.PermissionsBoundary).toBe(settings.workloadBoundaryArn);
    expect(calls.find(c => c.id === "lambda-invoke")!.input.Payload).toEqual({ nonce: settings.runId });
    expect(calls.some(c => /CreateAccessKey|GetSecretValue|CreateUser|RunTask/.test(c.command))).toBe(false);
  });
  it("orders dependents before dependencies; rejects cycles and missing parents", () => {
    const p = plan(), order = teardownOrder(p.fixtures).map(f => f.family);
    expect(order.indexOf("lambda")).toBeLessThan(order.indexOf("iam"));
    p.fixtures.find(f => f.family === "iam")!.dependsOn = ["lambda"];
    expect(() => teardownOrder(p.fixtures)).toThrow(/Cyclic/);
    expect(() => teardownOrder(plan().fixtures.filter(f => f.family === "lambda"))).toThrow(/Missing/);
  });
  it("creates a deterministic valid ZIP without keys or external tools", () => {
    const zip = Buffer.from(nonceZip()); expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    expect(zip.subarray(-22).readUInt32LE(0)).toBe(0x06054b50);
    expect(zip.toString()).toContain("event.nonce"); expect(nonceZip()).toEqual(nonceZip());
  });
  it("refuses unbound or foreign resource references", () => {
    expect(() => resolveInput({ Id: { $ref: "dns-create.HostedZone.Id" } }, {})).toThrow();
    expect(() => resolveInput({ $ref: "dns-create.HostedZone.Id" }, { "dns-create": { HostedZone: { Id: "foreign" } } })).toThrow();
    expect(resolveInput({ $ref: "dns-create.HostedZone.Id" }, { "dns-create": { HostedZone: { Id: "/hostedzone/ZCONTRACT" } } })).toBe("ZCONTRACT");
  });
});

describe("budget and permission envelope (offline)", () => {
  it.each([0, -1, NaN, Infinity, 5, 11])("refuses budget %s before transport", budget => expect(() => new Guard(plan(), permission(), budget, now)).toThrow());
  it.each(["accountId", "region", "runId", "planSha256"] as const)("binds %s exactly", field => expect(() => new Guard(plan(), { ...permission(), [field]: "foreign" }, 10, now)).toThrow());
  it("requires owner approval and exact bounded grants for all calls, including teardown", () => {
    expect(() => readPermission({})).toThrow();
    expect(() => readPermission({ awsLive: { ...permission(), approvedBy: "" } })).toThrow();
    expect(() => readPermission({ awsLive: { ...permission(), grants: [{ action: "iam:*", resource: "*", maximumCalls: 1 }] } })).toThrow();
    const perm = permission(); perm.grants = perm.grants.filter(g => g.action !== "rds:DeleteDBInstance");
    expect(() => new Guard(plan(), perm, 10, now)).toThrow(/Missing bounded permission/);
  });
  it("refuses expired/future approvals and insufficient request counts", () => {
    expect(() => new Guard(plan(), { ...permission(), expiresAt: now().toISOString() }, 10, now)).toThrow();
    expect(() => new Guard(plan(), { ...permission(), approvedAt: "2026-10-09T00:00:00Z" }, 10, now)).toThrow();
    const perm = permission(); perm.grants[0].maximumCalls = 1;
    expect(() => new Guard(plan(), perm, 10, now)).toThrow();
  });
  it("refuses mutation of the plan after admission and exhausted attempts", () => {
    const p = plan(), guard = makeGuard(p), c = p.fixtures[0].setup[0];
    guard.consume(c); expect(() => guard.consume(c)).toThrow(/exhausted/);
    expect(() => { c.input.Bucket = "foreign"; }).toThrow();
    expect(() => guard.consume({ ...c, input: { Bucket: "foreign" } })).toThrow(/Unplanned/);
  });
  it("expired approval permits only previously authorized cleanup, never fresh creation/invocation", () => {
    const p = plan(), perm = permission(p);
    perm.expiresAt = "2026-10-07T23:59:30Z";
    const guard = new Guard(p, perm, 10, now, {}, true);
    expect(() => guard.consume(p.fixtures[0].setup[0], true)).toThrow(/Recovery/);
    expect(() => guard.consume(p.fixtures[0].teardown[0], true)).not.toThrow();
  });
  it("rejects persisted counter tampering", () => {
    expect(() => new Guard(plan(), permission(), 10, now, { foreign: 1 })).toThrow();
    expect(() => new Guard(plan(), permission(), 10, now, { identity: -1 })).toThrow();
  });
  it("refuses a self-consistent approved plan that understates cost or changes the fixed topology", () => {
    const p = plan(); p.estimate.usd = 0;
    const { sha256: _old, ...body } = p; p.sha256 = digest(body);
    expect(() => new Guard(p, permission(p), 10, now)).toThrow(/canonical bounded/);
  });
});

describe("execution, cleanup and evidence (modeled contracts only)", () => {
  it("reads actual modeled provider results, tears down all fixtures and leaves requirements pending", async () => {
    const { journal, model, saves } = await run();
    expect(journal.checks.filter(c => c.scope === "aws_fixture" && c.status === "passed")).toHaveLength(6);
    expect(journal.checks.filter(c => c.scope === "cleanup" && c.status === "passed")).toHaveLength(6);
    expect(journal.checks.filter(c => c.status === "pending")).toHaveLength(27);
    expect(journal.closed).toBe(true); expect(model.present.size).toBe(0); expect(saves).toBeGreaterThan(model.calls.length);
    expect(model.calls.findIndex(c => c.id === "lambda-delete")).toBeLessThan(model.calls.findIndex(c => c.id === "iam-delete"));
    const evidence = evidencePacket(journal, now());
    expect(evidence.verdict).toBe("incomplete"); expect(evidence.requirements.every(r => r.evidence.length === 0)).toBe(true);
    expect(Object.values(evidence.releaseStatus).every(v => v === false)).toBe(true);
  });
  it.each(["s3-put", "iam-read", "lambda-invoke", "ecs-read", "rds-ready", "dns-read"])("always cleans partial failure at %s", async id => {
    const { journal, model } = await run(c => c.id === id);
    expect(journal.checks.some(c => c.status === "failed")).toBe(true); expect(journal.closed).toBe(true); expect(model.present.size).toBe(0);
  });
  it("blocks dependency deletion after dependent cleanup fails; preserves leak failure", async () => {
    const { journal, model } = await run(c => c.id === "lambda-delete");
    expect(journal.closed).toBe(false); expect(model.calls.some(c => c.id === "iam-delete")).toBe(false);
    expect(evidencePacket(journal).verdict).toBe("failed");
  });
  it("does not delete untagged resources or invent cleanup success", async () => {
    const { journal, model } = await run(c => c.id === "s3-tag");
    expect(journal.closed).toBe(false); expect(model.calls.some(c => c.id === "s3-delete")).toBe(false);
  });
  it.each(["identity", "marker", "db-security", "run-claim"])("does not create resources after %s refusal", async id => {
    const { model } = await run(c => c.id === id);
    expect(model.calls.some(c => c.id.endsWith("-create"))).toBe(false);
  });
  it("claims a run once without overwrite before any billable creation; recovery never claims again", async () => {
    const { p, journal, model, guard } = await run();
    const claim = p.preflight.find(c => c.id === "run-claim")!;
    expect(claim.input).toMatchObject({ Overwrite: false, Tier: "Standard", Value: settings.runId });
    expect(model.calls.findIndex(c => c.id === "run-claim")).toBeLessThan(model.calls.findIndex(c => c.id === "s3-create"));
    expect(model.calls.some(c => c.command === "DeleteParameter")).toBe(false);
    const start = model.calls.length;
    await execute(p, guard, model.transport, journal, { now, sleep: async () => undefined, save: async () => undefined }, { cleanupOnly: true });
    expect(model.calls.slice(start).some(c => c.id === "run-claim")).toBe(false);
  });
  it("treats permission/unavailable/malformed responses as failures, never absence", () => {
    expect(missing(error("AccessDeniedException"))).toBe(false);
    expect(missing(error("TimeoutError"))).toBe(false);
    expect(absent(plan().fixtures.find(f => f.family === "ecs")!.leak[0], {})).toBe(false);
    expect(owned({ Tags: { ...plan().tags, "zenith:live-run": "foreign" } }, plan())).toBe(false);
    expect(checkReadback("rds", { "rds-ready": { DBInstances: [{ DBInstanceStatus: "available", PubliclyAccessible: true }] } }, plan())).toBe(false);
  });
  it.each([
    ["IAM", new NoSuchEntityException({ $metadata: {}, message: "Role not found" })],
    ["S3 HeadBucket", new NotFound({ $metadata: {}, message: "Not Found" })],
    ["Lambda", new LambdaNotFound({ $metadata: {}, message: "missing" })],
    ["RDS", new DBInstanceNotFoundFault({ $metadata: {}, message: "missing" })],
    ["Route 53", new NoSuchHostedZone({ $metadata: {}, message: "missing" })],
    ["Secrets Manager", new SecretNotFound({ $metadata: {}, message: "missing" })],
  ])("treats the installed SDK %s not-found error as absence", (_, sdkError) => {
    expect(missing(sdkError)).toBe(true);
  });
  it("lets preflight proceed past an absent planned role (real SDK NoSuchEntityException)", async () => {
    const p = plan(), guard = makeGuard(p), model = modeled(p), journal = newJournal(p, guard, "a".repeat(40), now());
    const transport: Transport = { send: (c, input, signal) => c.id === "iam-preexist" ? Promise.reject(new NoSuchEntityException({ $metadata: {}, message: "Role not found" })) : model.transport.send(c, input, signal) };
    await execute(p, guard, transport, journal, { now, sleep: async () => undefined, save: async () => undefined });
    expect(journal.checks.some(c => c.id === "execution")).toBe(false);
    expect(model.calls.some(c => c.id === "iam-create")).toBe(true);
    expect(journal.closed).toBe(true);
  });
  describe("prior-leak scan and INACTIVE owned ECS clusters", () => {
    const owned = `arn:aws:ecs:${settings.region}:${settings.accountId}:cluster/zenith-zlive-202610241436-1a61-ecs`;
    async function scan(mappings: string[], status: (clusters: string[]) => Record<string, unknown>) {
      const p = plan(), guard = makeGuard(p), model = modeled(p), journal = newJournal(p, guard, "a".repeat(40), now());
      const described: unknown[] = [];
      const transport: Transport = { send: (c, input, signal) => {
        if (c.id === "prior-leaks") return Promise.resolve({ ResourceTagMappingList: mappings.map(ResourceARN => ({ ResourceARN })) });
        if (c.id === "prior-leaks-ecs") { described.push((input as { clusters: string[] }).clusters); return Promise.resolve(status((input as { clusters: string[] }).clusters)); }
        return model.transport.send(c, input, signal);
      } };
      await execute(p, guard, transport, journal, { now, sleep: async () => undefined, save: async () => undefined });
      return { journal, model, described, failed: journal.checks.some(c => c.id === "execution" && c.status === "failed") };
    }
    it("lets a run start when the only leftover is an owned cluster ECS reports INACTIVE", async () => {
      const r = await scan([owned], clusters => ({ clusters: clusters.map(clusterArn => ({ clusterArn, status: "INACTIVE" })), failures: [] }));
      expect(r.described).toEqual([[owned]]);
      expect(r.failed).toBe(false);
      expect(r.model.calls.some(c => c.id === "s3-create")).toBe(true);
    });
    it("still blocks an owned cluster that is ACTIVE", async () => {
      const r = await scan([owned], clusters => ({ clusters: clusters.map(clusterArn => ({ clusterArn, status: "ACTIVE" })), failures: [] }));
      expect(r.failed).toBe(true);
      expect(r.model.calls.some(c => c.id.endsWith("-create"))).toBe(false);
    });
    it("still blocks any other tagged resource without describing it", async () => {
      const r = await scan([owned, `arn:aws:s3:::zenith-zlive-202610241436-1a61-${settings.accountId}`], () => ({ clusters: [], failures: [] }));
      expect(r.failed).toBe(true);
      expect(r.described).toEqual([]);
    });
    it("still blocks a cluster outside the owned name pattern, account or region", async () => {
      for (const arn of [`arn:aws:ecs:${settings.region}:${settings.accountId}:cluster/customer-prod`, `arn:aws:ecs:us-east-1:${settings.accountId}:cluster/zenith-zlive-202610241436-1a61-ecs`, `arn:aws:ecs:${settings.region}:210987654321:cluster/zenith-zlive-202610241436-1a61-ecs`]) {
        const r = await scan([arn], clusters => ({ clusters: clusters.map(clusterArn => ({ clusterArn, status: "INACTIVE" })), failures: [] }));
        expect(r.failed, arn).toBe(true);
      }
    });
    it("still blocks when the status response does not cover every listed cluster", async () => {
      const r = await scan([owned], () => ({ clusters: [], failures: [] }));
      expect(r.failed).toBe(true);
    });
  });
  it("retries a real SDK IAM DeleteConflictException during teardown until the role is gone", async () => {
    const p = plan(), guard = makeGuard(p), model = modeled(p), journal = newJournal(p, guard, "a".repeat(40), now());
    const attempts: string[] = [];
    const transport: Transport = { send: (c, input, signal) => {
      if (c.id === "iam-delete") { attempts.push(c.id); if (attempts.length === 1) return Promise.reject(new DeleteConflictException({ $metadata: {}, message: "Role has attached policies" })); }
      return model.transport.send(c, input, signal);
    } };
    await execute(p, guard, transport, journal, { now, sleep: async () => undefined, save: async () => undefined });
    expect(attempts).toHaveLength(2); expect(journal.closed).toBe(true); expect(model.present.size).toBe(0);
  });
  it("treats a Secrets Manager secret scheduled for deletion (DeletedDate) as absent for the leak proof", () => {
    const secretLeak = plan().fixtures.find(f => f.family === "rds")!.leak[1];
    expect(absent(secretLeak, { DeletedDate: new Date("2026-10-20T00:00:00Z") })).toBe(true);
    expect(absent(secretLeak, { ARN: "arn:aws:secretsmanager:ap-south-1:123456789012:secret:rds!db-contract" })).toBe(false);
  });
  it("resumes a failed cleanup journal without rerunning setup; preserves the earlier failure", async () => {
    const first = await run(c => c.id === "lambda-delete");
    const guard = new Guard(first.p, permission(first.p), 10, now, first.journal.counts, true);
    first.model.calls.splice(0);
    await execute(first.p, guard, first.model.transport, first.journal, { now, sleep: async () => undefined, save: async () => undefined }, { cleanupOnly: true });
    // This same modeled transport keeps failing lambda-delete: recovery must
    // remain failed, and cannot escape via fresh request counters or setup.
    expect(first.journal.closed).toBe(false);
    expect(first.model.calls.some(c => c.id.endsWith("-create"))).toBe(false);
  });
  it("sanitizes known secret formats and never persists raw provider responses", async () => {
    const { journal } = await run();
    const fake = ["AKIA", randomBytes(8).toString("hex").toUpperCase()].join("");
    journal.checks.push({ id: "redaction", scope: "product_requirement", status: "pending", reason: `authorization: Bearer ${fake}` });
    expect(JSON.stringify(evidencePacket(journal))).not.toContain(fake);
    expect(Object.keys(journal.responses).sort()).toEqual(["dns-create", "dns-put", "rds-secret", "s3-create"]);
  });
  it("cannot emit live evidence from a modeled transport, even when a check claims success", async () => {
    const { journal } = await run();
    journal.checks = journal.checks.filter(c => c.scope !== "product_requirement");
    for (const r of journal.plan.requirements) journal.checks.push({ id: r.id, scope: "product_requirement", status: "passed", reason: "modeled success" });
    const packet = evidencePacket(journal);
    expect(packet.provenance).toBe("contract");
    expect(packet.requirements.every(r => r.evidence.length === 0)).toBe(true);
    expect(packet.verdict).toBe("incomplete");
    // A later native cleanup proves only provider absence, not these earlier
    // modeled product checks. It must not elevate the journal's provenance.
    journal.provenance = executionProvenance(journal.provenance, true, true);
    const recovered = evidencePacket(journal);
    expect(recovered.provenance).toBe("contract");
    expect(recovered.requirements.every(r => r.evidence.length === 0)).toBe(true);
    expect(recovered.verdict).toBe("incomplete");
  });
});

describe("CLI admission and explicit credentials (offline)", () => {
  it("requires root approval before transport and admits both approved envelopes", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "aws-production-cli-scope-")); directories.push(directory);
    const p = plan(), perm = permission(p), permissionFile = path.join(directory, "permissions.json");
    perm.approvedAt = new Date(Date.now() - 60_000).toISOString();
    perm.expiresAt = new Date(Date.now() + 60_000).toISOString();
    await writeFile(permissionFile, JSON.stringify({ awsLive: perm }));
    const argv = ["--account", settings.accountId, "--run-id", settings.runId, "--db-security-group", settings.dbSecurityGroup, "--permissions", permissionFile, "--out", directory];
    const env = { ZENITH_LIVE_AWS: "1", ZENITH_LIVE_AWS_BUDGET_USD: "10", ZENITH_LIVE_BUDGET_FILE: path.join(directory, "run-budget.json") };
    const model = modeled(p); let constructed = 0;
    const deps = { source: () => perm.sourceCommit, transport: async () => { constructed++; return model.transport; } };
    const io = { out: () => undefined, err: () => undefined };
    expect(await runProductionCli(argv, env, io, deps)).toBe(2);
    expect(constructed).toBe(0); expect(model.calls).toHaveLength(0);
    const rootFile = await rootScopeFile();
    const root = JSON.parse(await readFile(rootFile.ZENITH_LIVE_SCOPE_FILE, "utf8"));
    root.approval.expiresAt = new Date(Date.now() + 60_000).toISOString();
    await writeFile(rootFile.ZENITH_LIVE_SCOPE_FILE, JSON.stringify(root));
    expect(await runProductionCli(argv, { ...env, ...rootFile }, io, deps)).toBe(3);
    expect(constructed).toBe(1); expect(model.calls.length).toBeGreaterThan(0);
    expect(model.present.size).toBe(0);
  });
  it("shows the missing budget ledger refusal before any transport is constructed", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "aws-production-cli-budget-")); directories.push(directory);
    const p = plan(), perm = permission(p), permissionFile = path.join(directory, "permissions.json");
    perm.approvedAt = new Date(Date.now() - 60_000).toISOString();
    perm.expiresAt = new Date(Date.now() + 60_000).toISOString();
    await writeFile(permissionFile, JSON.stringify({ awsLive: perm }));
    const argv = ["--account", settings.accountId, "--run-id", settings.runId, "--db-security-group", settings.dbSecurityGroup, "--permissions", permissionFile, "--out", directory];
    const rootFile = await rootScopeFile();
    const root = JSON.parse(await readFile(rootFile.ZENITH_LIVE_SCOPE_FILE, "utf8"));
    root.approval.expiresAt = new Date(Date.now() + 60_000).toISOString();
    await writeFile(rootFile.ZENITH_LIVE_SCOPE_FILE, JSON.stringify(root));
    const model = modeled(p); let constructed = 0; const errors: string[] = [];
    const deps = { source: () => perm.sourceCommit, transport: async () => { constructed++; return model.transport; } };
    expect(await runProductionCli(argv, { ZENITH_LIVE_AWS: "1", ZENITH_LIVE_AWS_BUDGET_USD: "10", ...rootFile }, { out: () => undefined, err: s => errors.push(s) }, deps)).toBe(2);
    expect(constructed).toBe(0); expect(model.calls).toHaveLength(0);
    expect(errors.join("\n")).toContain("Use one absolute owner budget FILE");
  });
  it("recovers from a journal written to disk through redaction after a crash right after s3-create", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "aws-production-roundtrip-")); directories.push(dir);
    const p = buildPlan({ ...settings, scenario: "retention-s3" }), perm = permission(p);
    perm.approvedAt = new Date(Date.now() - 60_000).toISOString();
    perm.expiresAt = new Date(Date.now() + 60_000).toISOString();
    const guard = new Guard(p, perm, 10), model = modeled(p), journal = newJournal(p, guard, perm.sourceCommit);
    let snapshot: Journal | undefined;
    // The process "dies" at s3-tag: that request never returns, so only what was saved before it survives.
    const hanging: Transport = { send: (c, input, signal) => c.id === "s3-tag" ? new Promise(() => undefined) : model.transport.send(c, input, signal) };
    void execute(p, guard, hanging, journal, { now: () => new Date(), sleep: async () => undefined, save: async state => { snapshot = structuredClone(state); } });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(snapshot?.responses["s3-create"]).toBeDefined();
    expect(model.present.has("s3")).toBe(true);
    const journalFile = path.join(dir, "journal.json"), permissionFile = path.join(dir, "permissions.json");
    // Written exactly as the CLI writes it: through acceptance redaction, which replaces repeated objects with "[Circular]".
    await writeFile(journalFile, JSON.stringify(redactAcceptance(snapshot), null, 2));
    await writeFile(permissionFile, JSON.stringify({ awsLive: perm }));
    const creates = model.calls.filter(c => c.id.endsWith("-create")).length;
    const errors: string[] = [];
    await runProductionCli(["--permissions", permissionFile, "--cleanup", journalFile], { ZENITH_LIVE_AWS: "1", ZENITH_LIVE_AWS_BUDGET_USD: "0.40", ...(await rootScopeFile()) }, { out: () => undefined, err: e => errors.push(e) }, { source: () => perm.sourceCommit, transport: async () => model.transport });
    expect(errors).toEqual([]);
    const after = JSON.parse(await readFile(journalFile, "utf8")) as Journal;
    expect(after.closed).toBe(true);
    expect(model.present.has("s3")).toBe(false);
    expect(model.calls.filter(c => c.id.endsWith("-create")).length).toBe(creates);
  });
  it("refuses a journal whose recorded plan digest does not match its settings", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "aws-production-tamper-")); directories.push(dir);
    const p = plan(), perm = permission(p), journal = newJournal(p, new Guard(p, perm, 10, now), perm.sourceCommit);
    const tampered = { ...journal, plan: { ...journal.plan, settings: { ...journal.plan.settings, runId: "zlive-202610080000-ffff" } } };
    const journalFile = path.join(dir, "journal.json"), permissionFile = path.join(dir, "permissions.json");
    await writeFile(journalFile, JSON.stringify(tampered)); await writeFile(permissionFile, JSON.stringify({ awsLive: perm }));
    const errors: string[] = []; let constructed = 0;
    const code = await runProductionCli(["--permissions", permissionFile, "--cleanup", journalFile], { ZENITH_LIVE_AWS: "1", ZENITH_LIVE_AWS_BUDGET_USD: "10" }, { out: () => undefined, err: e => errors.push(e) }, { source: () => perm.sourceCommit, transport: async () => { constructed++; throw new Error("must not run"); } });
    expect(code).toBe(2); expect(constructed).toBe(0);
    expect(errors).toEqual(["Journal plan digest does not match its recorded settings; cleanup refused"]);
  });
  it("refuses recovery from a different executing source before constructing credentials", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "aws-production-test-")); directories.push(dir);
    const p = plan(), perm = permission(p);
    perm.approvedAt = new Date(Date.now() - 60_000).toISOString();
    perm.expiresAt = new Date(Date.now() + 60_000).toISOString();
    const journal = newJournal(p, new Guard(p, perm, 10), perm.sourceCommit);
    const permissionFile = path.join(dir, "permissions.json"), journalFile = path.join(dir, "journal.json");
    await writeFile(permissionFile, JSON.stringify({ awsLive: perm }));
    await writeFile(journalFile, JSON.stringify(journal));
    let constructed = 0;
    const errors: string[] = [];
    const code = await runProductionCli(["--permissions", permissionFile, "--cleanup", journalFile], { ZENITH_LIVE_AWS: "1", ZENITH_LIVE_AWS_BUDGET_USD: "10" }, { out: () => undefined, err: s => errors.push(s) }, { source: () => "b".repeat(40), transport: async () => { constructed++; throw new Error("must not run"); } });
    expect(code).toBe(2); expect(constructed).toBe(0); expect(errors).toEqual(["Permission source commit mismatch"]);
  });
  it.each(["invalid", "short", "too-long"])("refuses %s session expiry before constructing clients", async kind => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "aws-production-test-")); directories.push(dir);
    const file = path.join(dir, "session.json");
    const expiration = kind === "invalid" ? "invalid-date" : new Date(Date.now() + (kind === "short" ? 5 : 90) * 60_000).toISOString();
    await writeFile(file, JSON.stringify({ accessKeyId: randomBytes(12).toString("hex"), secretAccessKey: randomBytes(30).toString("base64"), sessionToken: randomBytes(32).toString("base64"), expiration }), { mode: 0o600 });
    await expect(sessionCredentials({ ZENITH_LIVE_AWS_SESSION_FILE: file })).rejects.toThrow(/46..60/);
  });
  it("reads only an explicit short-lived session FILE with enough cleanup lifetime; no SDK call", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "aws-production-test-")); directories.push(dir);
    const file = path.join(dir, "session.json");
    const credentials = { accessKeyId: randomBytes(12).toString("hex"), secretAccessKey: randomBytes(30).toString("base64"), sessionToken: randomBytes(32).toString("base64") };
    await writeFile(file, JSON.stringify({ ...credentials, expiration: new Date(Date.now() + 55 * 60_000).toISOString() }), { mode: 0o600 });
    expect(await sessionCredentials({ ZENITH_LIVE_AWS_SESSION_FILE: file })).toEqual(credentials);
  });
  it("--plan never constructs a credential provider/transport, even with ambient AWS variables", async () => {
    const lines: string[] = [];
    const code = await runProductionCli(["--plan", "--run-id", settings.runId], { AWS_PROFILE: "wrong", AWS_ACCESS_KEY_ID: "unread" }, { out: s => lines.push(s), err: s => lines.push(s) }, { transport: async () => { throw new Error("must not run"); } });
    expect(code).toBe(0); expect(lines.join("")).toContain("PLAN ONLY"); expect(lines.join("")).not.toContain("unread");
  });
  it("refuses live before credential access when the env gate/budget/permission is absent", async () => {
    let constructed = 0;
    const dir = await mkdtemp(path.join(os.tmpdir(), "aws-production-test-")); directories.push(dir);
    for (const env of [{}, { ZENITH_LIVE_AWS: "1" }]) {
      expect(await runProductionCli(["--account", settings.accountId, "--db-security-group", settings.dbSecurityGroup, "--out", dir], env, { out: () => undefined, err: () => undefined }, { transport: async () => { constructed++; throw new Error("must not run"); } })).toBe(2);
    }
    expect(constructed).toBe(0);
  });
  it.each([
    { label: "absent", env: {} }, { label: "profile", env: { AWS_PROFILE: "ambient" } },
    { label: "endpoint override", env: { AWS_ENDPOINT_URL: "https://foreign.invalid" } },
    { label: "access-key-only", env: { GITHUB_ACTIONS: "true", ZENITH_LIVE_AWS_ENVIRONMENT: "live-sandbox", AWS_ACCESS_KEY_ID: randomBytes(12).toString("hex"), AWS_SECRET_ACCESS_KEY: randomBytes(30).toString("base64") } },
  ])("refuses implicit/long-lived credential source $label", async ({ env }) => { await expect(sessionCredentials(env)).rejects.toThrow(); });
});

it("keeps pre-OIDC permission admission and an unconditional hard failure gate after recovery", async () => {
  const workflow = load(await readFile(".github/workflows/live-acceptance.yml", "utf8")) as { jobs: Record<string, { env?: Record<string, string>; steps: { name?: string; id?: string; uses?: string; run?: string; env?: Record<string, string>; "continue-on-error"?: boolean }[] }> };
  const steps = workflow.jobs["aws-live"].steps;
  // The run time limit reaches preflight, harness, drill and recovery through the job env, so they all bind the same plan.
  expect(workflow.jobs["aws-live"].env?.ZENITH_LIVE_AWS_MINUTES).toBe("${{ inputs.minutes }}");
  const preflight = steps.findIndex(s => s.name === "Validate the approved permission envelope before OIDC");
  const assume = steps.findIndex(s => s.uses?.startsWith("aws-actions/configure-aws-credentials@"));
  const acceptance = steps.findIndex(s => s.id === "acceptance"), recovery = steps.findIndex(s => s.id === "recovery");
  expect(preflight).toBeGreaterThan(0); expect(preflight).toBeLessThan(assume);
  expect(steps[preflight].run).toContain("scripts/acceptance/live/preflight.ts");
  expect(steps[acceptance]["continue-on-error"]).toBe(true);
  expect(recovery).toBeGreaterThan(acceptance);
  const gate = steps.at(-1)!;
  expect(gate["continue-on-error"] ?? false).toBe(false);
  // rel-04 replaces the plain harness with the drill; the fixtures and retention-s3 gate is unchanged.
  expect(gate.env).toEqual({ ACCEPTANCE_OUTCOME: "${{ steps.acceptance.outcome }}", RECOVERY_OUTCOME: "${{ steps.recovery.outcome }}", DRILL_OUTCOME: "${{ steps.drill.outcome }}", VERIFY_OUTCOME: "${{ steps.verify.outcome }}", REL04_RECOVERY_OUTCOME: "${{ steps.recovery_rel04.outcome }}" });
  expect(gate.run).toContain('test "$ACCEPTANCE_OUTCOME" = success');
  expect(gate.run).toContain('test "$RECOVERY_OUTCOME" = success');
  expect(gate.run).toContain('test "$DRILL_OUTCOME" = success');
  expect(gate.run).toContain('test "$VERIFY_OUTCOME" = success');
  expect(gate.run).toContain('test "$REL04_RECOVERY_OUTCOME" = success');
});

describe("scenario-specific plans and scoped verdict (offline)", () => {
  const retention = () => buildPlan({ ...settings, scenario: "retention-s3" });
  const bucket = `zenith-${settings.runId}-${settings.accountId}`;
  // Finished modeled run for any plan; product checks are added by each test.
  async function finished(p: Plan, fail?: (c: Call) => boolean) {
    const guard = makeGuard(p), model = modeled(p, fail), journal = newJournal(p, guard, "a".repeat(40), now());
    await execute(p, guard, model.transport, journal, { now, sleep: async () => undefined, save: async () => undefined });
    return journal;
  }
  // Replaces execute's pending placeholders, as a complete ProductScenarioPort result would.
  const passProduct = (journal: Journal, ids: string[]) => {
    journal.provenance = "live_sandbox";
    journal.checks = journal.checks.filter(c => !(c.scope === "product_requirement" && ids.includes(c.id)));
    for (const id of ids) journal.checks.push({ id, scope: "product_requirement", status: "passed", reason: "independent readback" });
  };

  it("keeps the default fixtures digest identical to the pre-scenario planner", () => {
    // Changed deliberately when the prior-leak scan gained its bounded owned-ECS status read (prior-leaks-ecs), and again when
    // s3-tag and dns-tag gained a second planned attempt for the cleanup-only repair of a proven untagged create (G4).
    expect(plan().sha256).toBe("2ddf24bebcf4c0d237dc71c3128439c7e38131b546538cff381321547748c717");
    expect(buildPlan({ ...settings, scenario: "fixtures" }).sha256).toBe(plan().sha256);
  });
  it("retention-s3 plans only the S3 family and the preflight calls that apply to it", () => {
    const p = retention(), calls = allCalls(p);
    expect(p.sha256).not.toBe(plan().sha256);
    expect(p.fixtures.map(f => f.family)).toEqual(["s3"]);
    expect(p.preflight.map(c => c.id)).toEqual(["identity", "marker", "run-claim", "run-claim-read", "prior-leaks", "prior-leaks-ecs", "s3-preexist"]);
    // The only ECS call is the read-only status check of prior owned clusters in the leak scan.
    expect(calls.filter(c => c.service === "ecs").map(c => `${c.id}:${c.command}`)).toEqual(["prior-leaks-ecs:DescribeClusters"]);
    expect(calls.some(c => ["rds", "route53", "iam", "lambda", "secretsmanager", "ec2"].includes(c.service))).toBe(false);
    expect(calls.some(c => /Create(Role|Function|Cluster|DBInstance|HostedZone)|Delete(Role|Function|Cluster|DBInstance|HostedZone)/.test(c.command))).toBe(false);
    expect(scopedRequirementIds(p.settings, p.requirements.map(r => r.id))).toEqual(["PROD-OPS-07"]);
    expect(p.estimate.usd).toBeLessThan(plan().estimate.usd);
    expect(p.estimate.usd).toBeGreaterThan(p.estimate.cleanupReserveUsd);
  });
  it("teardown lists and deletes only retention/ objects, bounded, before DeleteBucket", () => {
    const teardown = retention().fixtures[0].teardown;
    const ids = teardown.map(c => c.id);
    expect(ids.indexOf("s3-retention-list")).toBeLessThan(ids.indexOf("s3-delete"));
    expect(ids.indexOf("s3-retention-delete")).toBeLessThan(ids.indexOf("s3-delete"));
    const list = teardown.find(c => c.id === "s3-retention-list")!, remove = teardown.find(c => c.id === "s3-retention-delete")!;
    expect(list).toMatchObject({ action: "s3:ListBucket", resource: `arn:aws:s3:::${bucket}`, input: { Bucket: bucket, Prefix: "retention/" } });
    expect(remove).toMatchObject({ action: "s3:DeleteObject", resource: `arn:aws:s3:::${bucket}/retention/*` });
    expect(list.maximumCalls).toBeGreaterThan(0); expect(remove.maximumCalls).toBeGreaterThan(0);
    // The fixtures plan has no retention drain: its digest and calls are unchanged.
    expect(plan().fixtures[0].teardown.some(c => c.id.startsWith("s3-retention"))).toBe(false);
  });
  it("drains exactly the listed retention/ page before DeleteBucket", async () => {
    const p = retention(), guard = makeGuard(p), model = modeled(p), journal = newJournal(p, guard, "a".repeat(40), now());
    const listings: { Key: string }[][] = [[{ Key: "retention/ws/class/0001" }], []], inputs: Record<string, Json>[] = [];
    const transport: Transport = { send: (c, input, signal) => {
      if (c.id === "s3-retention-list") { model.calls.push(c); return Promise.resolve({ Contents: listings.shift() ?? [] }); }
      if (c.id === "s3-retention-delete") { model.calls.push(c); inputs.push(input); return Promise.resolve({ Deleted: [] }); }
      return model.transport.send(c, input, signal);
    } };
    await execute(p, guard, transport, journal, { now, sleep: async () => undefined, save: async () => undefined });
    expect(inputs).toEqual([{ Bucket: bucket, Delete: { Objects: [{ Key: "retention/ws/class/0001" }], Quiet: true } }]);
    expect(journal.closed).toBe(true); expect(model.present.size).toBe(0);
    expect(model.calls.findIndex(c => c.id === "s3-retention-delete")).toBeLessThan(model.calls.findIndex(c => c.id === "s3-delete"));
  });
  it("refuses a retention listing outside retention/ before any delete, leaving cleanup open", async () => {
    const p = retention(), guard = makeGuard(p), model = modeled(p), journal = newJournal(p, guard, "a".repeat(40), now());
    const inputs: Record<string, Json>[] = [];
    const transport: Transport = { send: (c, input, signal) => {
      if (c.id === "s3-retention-list") { model.calls.push(c); return Promise.resolve({ Contents: [{ Key: "probe" }] }); }
      if (c.id === "s3-retention-delete") { inputs.push(input); return Promise.resolve({}); }
      return model.transport.send(c, input, signal);
    } };
    await execute(p, guard, transport, journal, { now, sleep: async () => undefined, save: async () => undefined });
    expect(inputs).toHaveLength(0); expect(model.calls.some(c => c.id === "s3-delete")).toBe(false);
    expect(journal.closed).toBe(false);
  });
  it("bounds retention key resolution to one listing page of owned keys", () => {
    expect(resolveInput({ $keys: "list" }, { list: { Contents: [{ Key: "retention/a" }] } })).toEqual([{ Key: "retention/a" }]);
    expect(() => resolveInput({ $keys: "list" }, { list: { Contents: [] } })).toThrow(/Unbounded/);
    expect(() => resolveInput({ $keys: "list" }, { list: { Contents: Array.from({ length: 1001 }, (_, i) => ({ Key: `retention/${i}` })) } })).toThrow(/Unbounded/);
    expect(() => resolveInput({ $keys: "list" }, { list: { Contents: [{ Key: "other/a" }] } })).toThrow(/outside owned retention/);
  });
  it("binds each permission to its scenario and refuses the other scenario's plan", () => {
    const f = plan(), r = retention();
    expect(() => new Guard(r, permission(f), 10, now)).toThrow(/exact plan/);
    expect(() => new Guard(f, permission(r), 10, now)).toThrow(/exact plan/);
    expect(() => new Guard(r, permission(r), 10, now)).not.toThrow();
  });
  it("refuses unknown scenarios before any plan, credential or transport", async () => {
    expect(() => buildPlan({ ...settings, scenario: "bogus" as never })).toThrow(/Unknown AWS live scenario/);
    const lines: string[] = []; let constructed = 0;
    const code = await runProductionCli(["--plan", "--run-id", settings.runId], { ZENITH_LIVE_AWS_SCENARIO: "bogus" }, { out: s => lines.push(s), err: s => lines.push(s) }, { transport: async () => { constructed++; throw new Error("must not run"); } });
    expect(code).toBe(2); expect(constructed).toBe(0); expect(lines.join("")).toContain("Unknown AWS live scenario");
  });
  it("--scenario selects the production plan and the proposal shows its scenario and scope", async () => {
    const out: string[] = [];
    const io = { out: (s: string) => out.push(s), err: () => undefined };
    expect(await runLiveCli(["--plan", "--run-id", settings.runId, "--scenario", "retention-s3"], {}, io)).toBe(0);
    const proposal = JSON.parse(out.join("\n"));
    expect(proposal).toMatchObject({ scenario: "retention-s3", scope: ["PROD-OPS-07"] });
    expect(proposal.plan.fixtures.map((f: { family: string }) => f.family)).toEqual(["s3"]);
    out.length = 0;
    expect(await runLiveCli(["--plan", "--run-id", settings.runId], {}, io)).toBe(0);
    expect(JSON.parse(out.join("\n"))).toMatchObject({ scenario: "fixtures", scope: plan().requirements.map(r => r.id) });
  });
  it("keeps legacy A-J selection for non-production scenario names", async () => {
    expect(await runLiveCli(["--scenario", "bogus"], {}, { out: () => undefined, err: () => undefined })).toBe(2);
  });
  it("retention-s3 verdict is incomplete without a product port and pending out of scope", async () => {
    const journal = await finished(retention()), packet = evidencePacket(journal, now());
    expect(packet.verdict).toBe("incomplete"); expect(packet.scope).toEqual(["PROD-OPS-07"]);
    expect(packet.requirements.find(r => r.id === "PROD-OPS-07")).toMatchObject({ status: "pending" });
    expect(packet.requirements.find(r => r.id === "PROD-OPS-07")!.reason).toContain("Wave 5");
    expect(packet.requirements.filter(r => r.id !== "PROD-OPS-07").every(r => r.status === "pending" && r.reason === "outside this run's scope" && r.evidence.length === 0)).toBe(true);
  });
  it("retention-s3 verdict is passed when every in-scope requirement passed live", async () => {
    const journal = await finished(retention());
    passProduct(journal, ["PROD-OPS-07"]);
    const packet = evidencePacket(journal, now());
    expect(packet.verdict).toBe("passed");
    expect(packet.requirements.find(r => r.id === "PROD-OPS-07")!.evidence).toHaveLength(1);
  });
  it("retention-s3 verdict is failed on a failed check or an open journal even when in scope passed", async () => {
    const failedCheck = await finished(retention());
    passProduct(failedCheck, ["PROD-OPS-07"]);
    failedCheck.checks.push({ id: "archive", scope: "product_requirement", status: "failed", reason: "restore mismatch" });
    expect(evidencePacket(failedCheck).verdict).toBe("failed");
    const open = await finished(retention(), c => c.id === "s3-delete");
    passProduct(open, ["PROD-OPS-07"]);
    expect(open.closed).toBe(false);
    expect(evidencePacket(open).verdict).toBe("failed");
  });
  it("fixtures verdict is passed only when all 27 in-scope requirements passed live, else incomplete", async () => {
    const journal = await finished(plan());
    passProduct(journal, plan().requirements.map(r => r.id));
    expect(evidencePacket(journal).verdict).toBe("passed");
    journal.checks.pop();
    expect(evidencePacket(journal).verdict).toBe("incomplete");
  });
});

describe("untagged-create recovery (G4, offline)", () => {
  // The journal a SIGKILL leaves between a planned create and its tag: the create intent is recorded, nothing else.
  function crashedAfterCreate(family: "s3" | "dns") {
    const p = plan(), guard = makeGuard(p), model = modeled(p), journal = newJournal(p, guard, "a".repeat(40), now());
    journal.attempted = [family];
    if (family === "s3") journal.responses["s3-create"] = { Bucket: String(p.fixtures.find(f => f.family === "s3")!.setup[0].input.Bucket) };
    else journal.responses["dns-create"] = { HostedZone: { Id: "/hostedzone/ZCONTRACT" } };
    model.present.add(family);
    return { p, journal, model };
  }
  const recover = (p: Plan, journal: Journal, transport: Transport) => execute(p, new Guard(p, permission(p), 10, now, journal.counts, true), transport, journal, { now, sleep: async () => undefined, save: async () => undefined }, { cleanupOnly: true });

  it("re-tags a bucket left untagged by a crash after create, then deletes it and closes the journal", async () => {
    const { p, journal, model } = crashedAfterCreate("s3");
    await recover(p, journal, model.transport);
    const ids = model.calls.map(c => c.id);
    expect(ids.indexOf("s3-tag")).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf("s3-tag")).toBeLessThan(ids.indexOf("s3-delete"));
    expect(ids.some(id => id.endsWith("-create"))).toBe(false);
    expect(journal.closed).toBe(true); expect(model.present.size).toBe(0);
  });
  it("re-tags a zone left untagged by a crash after create, and never removes a record it did not send", async () => {
    const { p, journal, model } = crashedAfterCreate("dns");
    await recover(p, journal, model.transport);
    const ids = model.calls.map(c => c.id);
    expect(ids).toContain("dns-tag"); expect(ids).not.toContain("dns-remove-record"); expect(ids).not.toContain("dns-put");
    expect(ids.some(id => id.endsWith("-create"))).toBe(false);
    expect(journal.closed).toBe(true); expect(model.present.size).toBe(0);
  });
  it("refuses a bucket whose tags are foreign: no re-tag, no deletion, journal stays open", async () => {
    const { p, journal, model } = crashedAfterCreate("s3");
    const foreign = { TagSet: [{ Key: "zenith:live-run", Value: "someone-else" }, { Key: "zenith:managed", Value: "true" }, { Key: "zenith:purpose", Value: "live-acceptance" }] };
    const transport: Transport = { async send(c, input, signal) { if (c.id !== "s3-ownership") return model.transport.send(c, input, signal); model.calls.push(c); return foreign; } };
    await recover(p, journal, transport);
    expect(model.calls.some(c => c.id === "s3-tag")).toBe(false);
    expect(model.calls.some(c => c.id === "s3-delete")).toBe(false);
    expect(journal.closed).toBe(false);
  });
  it("refuses an untagged bucket that this journal never recorded creating", async () => {
    const { p, journal, model } = crashedAfterCreate("s3");
    delete journal.responses["s3-create"];
    await recover(p, journal, model.transport);
    expect(model.calls.some(c => c.id === "s3-tag" || c.id === "s3-delete")).toBe(false);
    expect(journal.closed).toBe(false);
  });
  it("gives recovery authority only over the planned tag calls, bounded, and never over a create", () => {
    const p = plan(), guard = new Guard(p, permission(p), 10, now, {}, true);
    const s3Create = p.fixtures.find(f => f.family === "s3")!.setup.find(c => c.id === "s3-create")!;
    const s3Tag = p.fixtures.find(f => f.family === "s3")!.setup.find(c => c.id === "s3-tag")!;
    const dnsCreate = p.fixtures.find(f => f.family === "dns")!.setup.find(c => c.id === "dns-create")!;
    expect(() => guard.consume(s3Create, true, true)).toThrow(/Recovery cannot create/);
    expect(() => guard.consume(dnsCreate, true, true)).toThrow(/Recovery cannot create/);
    expect(() => guard.consume(s3Tag, true, false)).toThrow(/Recovery cannot create/);
    guard.consume(s3Tag, true, true); guard.consume(s3Tag, true, true);
    expect(() => guard.consume(s3Tag, true, true)).toThrow(/exhausted/);
  });
});

describe("expired root approval during teardown only (G3, offline)", () => {
  // approvedManifest pins expiresAt to NOW + 1 day, so this instant is after the lapse.
  const lapsed = () => new Date("2026-10-10T00:00:00Z");
  it("lets owned teardown use the original approval after it lapses", async () => {
    const env = await rootScopeFile();
    expect(() => requireProductionScope(plan(), 10, env, true, lapsed)).not.toThrow();
  });
  it("still refuses fresh creation under the same lapsed approval", async () => {
    const env = await rootScopeFile();
    expect(() => requireProductionScope(plan(), 10, env, false, lapsed)).toThrow(/has expired/);
  });
  it("keeps the content and digest check for teardown", async () => {
    const env = await rootScopeFile();
    const raw = JSON.parse(await readFile(env.ZENITH_LIVE_SCOPE_FILE, "utf8"));
    raw.budgets.totalUsd = 9;
    await writeFile(env.ZENITH_LIVE_SCOPE_FILE, JSON.stringify(raw));
    expect(() => requireProductionScope(plan(), 10, env, true, lapsed)).toThrow(/changed after it was approved/);
  });
  it("keeps the approver check for teardown", async () => {
    const env = await rootScopeFile();
    const raw = JSON.parse(await readFile(env.ZENITH_LIVE_SCOPE_FILE, "utf8"));
    raw.approval.approvedBy = null;
    await writeFile(env.ZENITH_LIVE_SCOPE_FILE, JSON.stringify(raw));
    expect(() => requireProductionScope(plan(), 10, env, true, lapsed)).toThrow(/not been approved by a person/);
  });
});

describe("AWS CLI resume command, next-command.txt and checkpoint (G1/G2, offline)", () => {
  async function cli(fail?: (c: Call) => boolean) {
    const dir = await mkdtemp(path.join(os.tmpdir(), "aws-production-resume-")); directories.push(dir);
    const p = plan(), perm = permission(p);
    perm.approvedAt = new Date(Date.now() - 60_000).toISOString();
    perm.expiresAt = new Date(Date.now() + 60_000).toISOString();
    const permissionFile = path.join(dir, "permissions.json");
    await writeFile(permissionFile, JSON.stringify({ awsLive: perm }));
    const rootFile = await rootScopeFile();
    const root = JSON.parse(await readFile(rootFile.ZENITH_LIVE_SCOPE_FILE, "utf8"));
    root.approval.expiresAt = new Date(Date.now() + 60_000).toISOString();
    await writeFile(rootFile.ZENITH_LIVE_SCOPE_FILE, JSON.stringify(root));
    const env = { ZENITH_LIVE_AWS: "1", ZENITH_LIVE_AWS_BUDGET_USD: "10", ZENITH_LIVE_AWS_SESSION_FILE: path.join(dir, "session.json"), ZENITH_LIVE_BUDGET_FILE: path.join(dir, "run-budget.json"), ...rootFile };
    const argv = ["--account", settings.accountId, "--run-id", settings.runId, "--db-security-group", settings.dbSecurityGroup, "--permissions", permissionFile, "--out", dir];
    const model = modeled(p, fail), runDir = path.join(dir, settings.runId), seen: boolean[] = [];
    // Nothing reaches AWS until the on-disk recovery command, journal and checkpoint exist.
    const transport: Transport = { send(c, input, signal) {
      if (!seen.length) seen.push(["journal.json", "next-command.txt", "checkpoint.json"].every(f => existsSync(path.join(runDir, f))));
      return model.transport.send(c, input, signal);
    } };
    const out: string[] = [];
    const code = await runProductionCli(argv, env, { out: s => out.push(s), err: s => out.push(s) }, { source: () => perm.sourceCommit, transport: async () => transport });
    return { code, seen, runDir, permissionFile, packet: JSON.parse(out.join("\n")) as { nextCommand: string | null } };
  }

  it("builds a copy-paste resume command with quoted paths and every required env assignment", () => {
    expect(resumeCommand({ cwd: "/work/my repo", budgetUsd: 6.45, scopeFile: "/s/scope.json", sessionFile: "/s/it's.json", permissionsFile: "/p/permissions.json", journalFile: "/j/journal.json" }))
      .toBe("cd '/work/my repo' && ZENITH_LIVE_AWS=1 ZENITH_LIVE_AWS_BUDGET_USD=6.45 ZENITH_LIVE_SCOPE_FILE='/s/scope.json' ZENITH_LIVE_AWS_SESSION_FILE='/s/it'\\''s.json' npx tsx scripts/acceptance/aws-live.ts --permissions '/p/permissions.json' --cleanup '/j/journal.json'");
  });
  it("writes the command, journal and checkpoint before the first AWS call; a closed run leaves no resume command", async () => {
    const run = await cli();
    expect(run.code).toBe(3); expect(run.seen).toEqual([true]);
    expect(run.packet.nextCommand).toBeNull();
    expect(await readFile(path.join(run.runDir, "next-command.txt"), "utf8")).toContain("Journal closed");
    const checkpoint = JSON.parse(await readFile(path.join(run.runDir, "checkpoint.json"), "utf8"));
    expect(checkpoint).toMatchObject({ format: "zenith.run-checkpoint.v1", harness: "aws-live", runId: settings.runId, unattendedClaims: false, nextCommands: [] });
    expect(checkpoint.steps).toMatchObject([{ id: "run", status: "done" }]);
    expect(checkpoint.decisions[0].text).toContain(`plan=${plan().sha256}`);
    expect(checkpoint.decisions[0].text).toContain(`commit=${"a".repeat(40)}`);
    expect(checkpoint.decisions[0].text).toContain("budgetUsd=10");
  });
  it("leaves a runnable command on disk, in next-command.txt and the checkpoint, when cleanup stays open", async () => {
    const run = await cli(c => c.id === "lambda-delete");
    expect(run.code).toBe(1);
    const command = run.packet.nextCommand!;
    for (const required of ["ZENITH_LIVE_AWS=1", "ZENITH_LIVE_AWS_BUDGET_USD=10", "ZENITH_LIVE_SCOPE_FILE='", "ZENITH_LIVE_AWS_SESSION_FILE='", `--permissions '${run.permissionFile}'`, `--cleanup '${path.join(run.runDir, "journal.json")}'`]) {
      expect(command).toContain(required);
    }
    expect(await readFile(path.join(run.runDir, "next-command.txt"), "utf8")).toBe(`${command}\n`);
    const checkpoint = JSON.parse(await readFile(path.join(run.runDir, "checkpoint.json"), "utf8"));
    expect(checkpoint.steps).toMatchObject([{ id: "run", status: "failed" }]);
    expect(checkpoint.nextCommands).toEqual([command]);
    expect(checkpoint.unattendedClaims).toBe(false);
  });
});
