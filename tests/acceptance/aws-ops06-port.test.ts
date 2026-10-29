/**
 * OPS-06 offline: the DEPLOY-01 port in ops-06 mode (one secret env key, state check, persistence scan) and the canary scan.
 * Fake browser driver, in-memory AWS answered only for planned calls through the real Guard, fake state and probe.
 */
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildPlan } from "../../scripts/acceptance/live/plan";
import { grantsFor, Guard } from "../../scripts/acceptance/live/guard";
import type { Call, Json, Plan } from "../../scripts/acceptance/live/contracts";
import { trustDocument } from "../../scripts/acceptance/live/product/mix-03";
import { DEPLOY01_IMAGES, deploy01Port, OPS06_SECRET_KEY, ops06DefinitionReadsSecret } from "../../scripts/acceptance/live/product/deploy-01";
import type { Deploy01Product } from "../../scripts/acceptance/live/product/deploy-01-driver";
import { placeOf, scanForCanary, type CanaryScan } from "../../scripts/acceptance/live/product/canary-scan";

const ACCOUNT = "123456789012", REGION = "ap-south-1", RUN = "zlive-202610290000-ab06";
const PRINCIPAL = `arn:aws:iam::${ACCOUNT}:role/ZenithLiveAcceptance`;
const OLD_EXT = "old-live-external-id", NEW_EXT = `zenith-${"c".repeat(32)}`;
const CANARY = `zops06${"f".repeat(32)}`;
const SECRET_ARN = `arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:zenith/env1/web-zenith-ops06-canary-ab12cd34-AbCdEf`;
const DNS = "zenith-web-123.ap-south-1.elb.amazonaws.com";
const settings = { accountId: ACCOUNT, region: REGION, runId: RUN, durationMinutes: 45, dbSubnetGroup: "zenith-live-sandbox", dbSecurityGroup: "sg-12345678", workloadBoundaryArn: `arn:aws:iam::${ACCOUNT}:policy/ZenithLiveWorkloadBoundary`, scenario: "ops-06" as const };
const requirement = { id: "PROD-OPS-06", acceptance: [], fixtures: [], join: "" };
const COMMIT = "a".repeat(40);
const definition = (extra: Record<string, unknown> = {}) => JSON.stringify([{ image: DEPLOY01_IMAGES.v1, secrets: [{ name: OPS06_SECRET_KEY, valueFrom: SECRET_ARN }], environment: [], ...extra }]);

function harness(opts: { definitions?: string; stateExtra?: string; scan?: CanaryScan; secretPath?: boolean } = {}) {
  const trust = { observe: trustDocument(PRINCIPAL, OLD_EXT), deploy: trustDocument(PRINCIPAL, OLD_EXT), writer: trustDocument(PRINCIPAL, OLD_EXT) };
  const connections: Record<string, unknown>[] = [];
  const secrets: { serviceId: string; key: string; secretValue: string }[] = [];
  let destroyed = false;
  const product: Deploy01Product = {
    createTenant: async () => ({ workspaceId: "ws1", projectId: "p1" }),
    createAwsConnection: async (_t, input) => { connections.push(input); return { connectionId: "c1", externalId: NEW_EXT }; },
    verifyAws: async () => ({ ok: true }),
    createEnvironment: async () => ({ environmentId: "env1" }),
    setManifest: async () => undefined,
    ...(opts.secretPath === false ? {} : { setSecret: async (_t: unknown, input: { serviceId: string; key: string; secretValue: string }) => { secrets.push(input); } }),
    deploy: async () => ({ operationId: "op", status: "succeeded" }),
  };
  const plan: Plan = buildPlan(settings);
  const permission = {
    schema: 1 as const, decision: "DEC-CLOUD" as const, approvedBy: "owner-test", approvedAt: "2020-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z",
    accountId: ACCOUNT, region: REGION, runId: RUN, planSha256: plan.sha256, sourceCommit: COMMIT, maxUsd: plan.estimate.usd, maxMinutes: plan.settings.durationMinutes, grants: grantsFor(plan),
  };
  const guard = new Guard(plan, permission, plan.estimate.usd);
  const call = async (c: Call, input?: Record<string, Json>) => {
    guard.consume(c);
    const i = input ?? c.input;
    switch (c.id) {
      case "deploy01-iam-read-observe": return { Role: { AssumeRolePolicyDocument: encodeURIComponent(trust.observe) } };
      case "deploy01-iam-read-deploy": return { Role: { AssumeRolePolicyDocument: encodeURIComponent(trust.deploy) } };
      case "deploy01-iam-trust-observe": trust.observe = String(i.PolicyDocument); return {};
      case "deploy01-iam-trust-deploy": trust.deploy = String(i.PolicyDocument); return {};
      case "deploy01-iam-read-writer": return { Role: { AssumeRolePolicyDocument: encodeURIComponent(trust.writer) } };
      case "deploy01-iam-trust-writer": trust.writer = String(i.PolicyDocument); return {};
      case "deploy01-sts-assume": return { Credentials: { AccessKeyId: "A", SecretAccessKey: "S", SessionToken: "T" } };
      case "deploy01-tag-read": return { ResourceTagMappingList: [] };
      default: throw new Error(`unexpected ${c.id}`);
    }
  };
  const scanned: string[] = [];
  const state = {
    read: async () => ({ note: opts.stateExtra ?? "", resources: [
      { type: "aws_ecs_task_definition", instances: [{ attributes: { container_definitions: opts.definitions ?? definition() } }] },
      { type: "aws_lb", instances: [{ attributes: { dns_name: DNS } }] },
    ] }),
    destroy: async () => { destroyed = true; return { destroyed: 20, destroyedArns: [], destroyedIds: [] }; },
  };
  const port = deploy01Port({ ZENITH_LIVE_PRODUCT: "1" }, {
    product, sleep: async () => undefined, propagation: { attempts: 2, intervalMs: 0 }, probe: async () => 200, state,
    canary: () => CANARY, scan: async (c) => { scanned.push(c); return opts.scan ?? { control: true, leaks: {} }; },
  });
  return { trust, connections, secrets, scanned, destroyed: () => destroyed, run: () => port.verify(requirement, { plan, commit: COMMIT, call }) };
}

describe("OPS-06 plan", () => {
  it("scopes ops-06 to PROD-OPS-06 with the DEPLOY-01 sandbox calls and runs on either lane", () => {
    const plan = buildPlan(settings);
    expect(plan.productCalls!.map(c => c.id)).toEqual(["deploy01-iam-read-observe", "deploy01-iam-read-deploy", "deploy01-iam-trust-observe", "deploy01-iam-trust-deploy", "deploy01-iam-read-writer", "deploy01-iam-trust-writer", "deploy01-sts-assume", "deploy01-tag-read"]);
    expect(plan.productCalls!.find(c => c.id === "deploy01-iam-trust-writer")!.resource).toBe(`arn:aws:iam::${ACCOUNT}:role/ZenithSecretWriterRole-live`);
    // DEPLOY-01 itself never touches the writer role.
    expect(buildPlan({ ...settings, scenario: "deploy-01" }).productCalls!.some(c => c.id.includes("writer"))).toBe(false);
    expect(buildPlan({ ...settings, lane: "live2" }).productCalls!.find(c => c.id === "deploy01-sts-assume")!.resource).toBe(`arn:aws:iam::${ACCOUNT}:role/ZenithDeployRole-live2`);
    expect(() => buildPlan({ ...settings, durationMinutes: 61 })).toThrow("5..60");
  });
});

describe("OPS-06 port", () => {
  it("sets the canary only through system.setSecret, checks the recorded state, scans and cleans up", async () => {
    const h = harness();
    const result = await h.run();
    expect(result.complete).toBe(true);
    expect(result.reason).toContain("OPS-06 proven on AWS");
    expect(result.reason).not.toContain(CANARY);
    expect(h.secrets).toEqual([{ serviceId: "web", key: OPS06_SECRET_KEY, secretValue: CANARY }]);
    expect(h.scanned).toEqual([CANARY]);
    expect(h.destroyed()).toBe(true);
    expect(h.trust).toEqual({ observe: trustDocument(PRINCIPAL, OLD_EXT), deploy: trustDocument(PRINCIPAL, OLD_EXT), writer: trustDocument(PRINCIPAL, OLD_EXT) });
    expect(h.connections[0]).toMatchObject({ secretWriterRoleArn: `arn:aws:iam::${ACCOUNT}:role/ZenithSecretWriterRole-live` });
  });

  it("refuses a value in the recorded state, a plaintext env copy, a blind scan or any leak, and still cleans up", async () => {
    for (const [opts, why] of [
      [{ stateExtra: `x${CANARY}x` }, "state holds the secret value"],
      [{ definitions: definition({ environment: [{ name: OPS06_SECRET_KEY, value: "x" }] }) }, "does not read ZENITH_OPS06_CANARY"],
      [{ scan: { control: false, leaks: {} } }, "did not find its own control file"],
      [{ scan: { control: true, leaks: { "container logs": 2 } } }, "found in runner persistence (container logs: 2)"],
      [{ secretPath: false }, "no secret path"],
    ] as const) {
      const h = harness(opts);
      const result = await h.run();
      expect(result.complete).toBe(false);
      expect(result.reason).toContain(why);
      expect(result.reason).not.toContain(CANARY);
      expect(h.destroyed()).toBe(true);
    }
  });

  it("accepts only a Zenith Secrets Manager reference in the task definition", () => {
    expect(ops06DefinitionReadsSecret(definition(), CANARY, ACCOUNT, REGION)).toBe(true);
    expect(ops06DefinitionReadsSecret(JSON.stringify([{ secrets: [{ name: OPS06_SECRET_KEY, valueFrom: `arn:aws:ssm:${REGION}:${ACCOUNT}:parameter/x` }] }]), CANARY, ACCOUNT, REGION)).toBe(false);
    expect(ops06DefinitionReadsSecret(definition({ command: [CANARY] }), CANARY, ACCOUNT, REGION)).toBe(false);
    expect(ops06DefinitionReadsSecret("not json", CANARY, ACCOUNT, REGION)).toBe(false);
  });
});

describe("OPS-06 canary scan", () => {
  const grep = (argv: string[]) => new Promise<{ code: number | null; stdout: Buffer }>((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), { stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.on("error", reject);
    child.on("close", code => resolve({ code, stdout: Buffer.concat(chunks) }));
  });

  it("never passes the canary on the command line and classifies hits by place", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ops06-root-"));
    const seen: string[][] = [];
    const result = await scanForCanary(CANARY, { roots: [root], controlDir: path.join(root, "control"), run: async (argv) => {
      seen.push(argv);
      return { code: 0, stdout: Buffer.from(`${path.join(root, "control", "control.bin")}\0${path.join(root, "data", "x")}\0`) };
    } });
    expect(JSON.stringify(seen)).not.toContain(CANARY);
    expect(result).toEqual({ control: true, leaks: { "root 1": 1 } });
    expect(placeOf("/var/lib/docker/containers/abc/abc-json.log", [])).toBe("container logs");
    expect(placeOf("/var/lib/docker/volumes/v/_data/base/1", [])).toBe("docker volumes");
  });

  it("refuses an unreadable or unfinished scan, a bad canary and a control outside the roots", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ops06-root-"));
    const opts = { roots: [root], controlDir: path.join(root, "control") };
    await expect(scanForCanary(CANARY, { ...opts, run: async () => ({ code: 2, stdout: Buffer.alloc(0) }) })).rejects.toThrow("could not read every file");
    await expect(scanForCanary(CANARY, { ...opts, run: async () => ({ code: null, stdout: Buffer.alloc(0) }) })).rejects.toThrow("did not finish");
    await expect(scanForCanary("short", opts)).rejects.toThrow("24-128");
    await expect(scanForCanary(CANARY, { ...opts, controlDir: "/elsewhere" })).rejects.toThrow("outside every scan root");
  });

  // GNU grep only: BSD grep reads -Z as decompression.
  it.runIf(process.platform === "linux")("finds the control and a planted copy with the real grep, and nothing in a clean tree", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ops06-real-"));
    await mkdir(path.join(root, "data"), { recursive: true });
    await writeFile(path.join(root, "data", "clean.bin"), Buffer.from([0, 1, 2, 3]));
    const clean = await scanForCanary(CANARY, { roots: [root], controlDir: path.join(root, "control"), run: grep });
    expect(clean).toEqual({ control: true, leaks: {} });
    await writeFile(path.join(root, "data", "leak.bin"), Buffer.concat([Buffer.from([0, 255]), Buffer.from(CANARY), Buffer.from([0])]));
    const leaked = await scanForCanary(CANARY, { roots: [root], controlDir: path.join(root, "control"), run: grep });
    expect(leaked).toEqual({ control: true, leaks: { "root 1": 1 } });
  });
});
