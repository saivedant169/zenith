/**
 * OPS-04 offline: the restore port with a fake browser driver, a fake runner stack, in-memory AWS answered only for planned
 * calls through the real Guard, and a fake recorded state. No cloud, stack, PostgreSQL or Temporal is used.
 */
import { describe, expect, it } from "vitest";
import { buildPlan } from "../../scripts/acceptance/live/plan";
import { grantsFor, Guard } from "../../scripts/acceptance/live/guard";
import type { Call, Json, Plan } from "../../scripts/acceptance/live/contracts";
import { trustDocument } from "../../scripts/acceptance/live/product/mix-03";
import { ops04Manifest, ops04Port } from "../../scripts/acceptance/live/product/ops-04";
import type { Deploy01Product } from "../../scripts/acceptance/live/product/deploy-01-driver";
import type { Ops04Stack } from "../../scripts/acceptance/live/product/ops-04-stack";
import type { RestoreReport } from "@/lib/ops/recovery/restore";

const ACCOUNT = "123456789012", REGION = "ap-south-1", RUN = "zlive-202610290000-ab04";
const PRINCIPAL = `arn:aws:iam::${ACCOUNT}:role/ZenithLiveAcceptance`;
const OLD_EXT = "old-live-external-id", NEW_EXT = `zenith-${"c".repeat(32)}`;
const settings = { accountId: ACCOUNT, region: REGION, runId: RUN, durationMinutes: 50, dbSubnetGroup: "zenith-live-sandbox", dbSecurityGroup: "sg-12345678", workloadBoundaryArn: `arn:aws:iam::${ACCOUNT}:policy/ZenithLiveWorkloadBoundary`, scenario: "ops-04" as const };
const requirement = { id: "PROD-OPS-04", acceptance: [], fixtures: [], join: "" };
const COMMIT = "a".repeat(40);
const BINDING = "b".repeat(64);
const bucket = (n: number) => `arn:aws:s3:::ops04-0000ab04-${n}`;

interface Opts { resumeRefused?: boolean; quietStatus?: string; extraBucket?: boolean; staleStatus?: number; restoreOk?: boolean; healthyAfterSeconds?: number; resumedStatus?: string; fencedApprovalOk?: boolean; restoredStatus?: string }

function harness(opts: Opts = {}) {
  const trust = { observe: trustDocument(PRINCIPAL, OLD_EXT), deploy: trustDocument(PRINCIPAL, OLD_EXT) };
  const events: string[] = [];
  let aws: string[] = [], destroyed = false, resumed = false, workerUp = true;
  const op = { status: "succeeded", round: 0 };
  const product: Deploy01Product = {
    createTenant: async () => ({ workspaceId: "ws1", projectId: "p1" }),
    createAwsConnection: async () => ({ connectionId: "c1", externalId: NEW_EXT }),
    verifyAws: async () => ({ ok: true }),
    createEnvironment: async () => ({ environmentId: "env1" }),
    setManifest: async (_t, m) => { events.push(`manifest:${(m.resources as unknown[]).length}`); },
    deploy: async () => { aws = [bucket(1)]; events.push("deploy"); return { operationId: "op1", status: "succeeded" }; },
    proposeDeploy: async () => { events.push(`propose:worker=${workerUp}`); op.status = "running"; return { operationId: "op2" }; },
    finishDeploy: async () => {
      events.push(`finish:resumed=${resumed}`);
      if (resumed && opts.extraBucket) aws = [bucket(1), bucket(2), bucket(3)];
      else aws = [bucket(1), bucket(2)];
      op.status = resumed && opts.resumedStatus ? opts.resumedStatus : "succeeded";
      return { operationId: "op2", status: op.status };
    },
    // The worker plans the dispatched deploy into its plan review.
    operationStatus: async () => { if (op.status === "running" && workerUp && !resumed) { op.status = "awaiting_approval"; op.round = 1; } return { ...op }; },
    tryApprove: async () => { events.push("try-approve"); return opts.fencedApprovalOk ? { ok: true } : { ok: false, refusal: "This approval belongs to an earlier recovery epoch." }; },
    recoveryItems: async () => ({ epoch: 7, items: [{ id: "item1", kind: "operation", ref: "op2", allowed: ["resume", "abandon"], bindingDigest: BINDING }] }),
    decideRecovery: async (_t, _id, input) => {
      if (input.bindingDigest !== BINDING) return { status: opts.staleStatus ?? 409 };
      if (opts.resumeRefused) return { status: 409, why: "conflict: The operation changed since it was reviewed" };
      resumed = true; op.status = "awaiting_approval"; return { status: 200, state: "resumed" };
    },
  };
  const at = (s: number) => new Date(Date.parse("2026-10-29T10:00:00Z") + s * 1000).toISOString();
  const report = {
    format: "zenith.recovery-report.v1", runId: "r", backupId: "b", manifestDigest: "d", ok: opts.restoreOk ?? true, epoch: 7, counts: null, replayed: false, continuation: null, needsPerson: [],
    steps: [{ id: "verify", status: opts.restoreOk === false ? "refused" : "ok", detail: opts.restoreOk === false ? "pg_restore failed (exit 1): schema \"auth\" does not exist at /home/runner/x/y" : "" }],
    measurement: { backupSnapshotAt: at(0), backupFinishedAt: at(30), restoreStartedAt: at(400), restoreFinishedAt: at(600), incidentAt: null, applicationHealthyAt: null, rpoSeconds: null, backupAgeAtRestoreStartSeconds: 400, restoreDurationSeconds: 200, rtoSeconds: null, targets: { rpoSeconds: null, rtoSeconds: null, status: "unset" }, verdict: "no_targets", caveats: [] },
  } as unknown as RestoreReport;
  let switched = false, closed = false;
  const stack: Ops04Stack = {
    stop: async (s) => { events.push(`stop:${s.join("+")}`); if (s.includes("execution-worker")) workerUp = false; },
    start: async (s) => { events.push(`start:${s}${switched ? ":restored" : ""}`); if (s === "execution-worker") workerUp = true; },
    backup: async () => { events.push("backup"); return { snapshotAt: at(0), epoch: 6 }; },
    restore: async () => { events.push("restore"); op.status = "awaiting_approval"; return report; },
    readback: async () => ({ status: opts.restoredStatus ?? "awaiting_approval", consumed: false, epoch: 6, current: 7 }),
    switchToRestored: async () => { switched = true; events.push("switch"); },
    close: async () => { closed = true; },
  };
  // The quiet window: what the restored stack did on its own.
  const sleep = async (ms: number) => { if (ms === 120_000 && opts.quietStatus) op.status = opts.quietStatus; };
  // Readings in order: the plan-review deadline, the loss time, then application health (held after that).
  const clockAt = [at(0), at(300), at(opts.healthyAfterSeconds ?? 700)];
  const now = () => new Date(clockAt.length > 1 ? clockAt.shift()! : clockAt[0]!);
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
      case "teardown01-iam-read-observe": return { Role: { AssumeRolePolicyDocument: encodeURIComponent(trust.observe) } };
      case "teardown01-iam-read-deploy": return { Role: { AssumeRolePolicyDocument: encodeURIComponent(trust.deploy) } };
      case "teardown01-iam-trust-observe": trust.observe = String(i.PolicyDocument); return {};
      case "teardown01-iam-trust-deploy": trust.deploy = String(i.PolicyDocument); return {};
      case "teardown01-sts-assume": return { Credentials: { AccessKeyId: "A", SecretAccessKey: "S", SessionToken: "T" } };
      case "teardown01-tag-read": return { ResourceTagMappingList: (destroyed ? [] : aws).map(ResourceARN => ({ ResourceARN })) };
      default: throw new Error(`unexpected ${c.id}`);
    }
  };
  const state = {
    read: async () => ({ resources: aws.map(() => ({ mode: "managed", type: "aws_s3_bucket", instances: [{}] })) }),
    destroy: async () => { destroyed = true; aws = []; return { destroyed: 2 }; },
  };
  const port = ops04Port({ ZENITH_LIVE_PRODUCT: "1" }, { product, stack, sleep, now, propagation: { attempts: 2, intervalMs: 0 }, state });
  return { events, trust, destroyed: () => destroyed, closed: () => closed, run: () => port.verify(requirement, { plan, commit: COMMIT, call }) };
}

describe("OPS-04 plan", () => {
  it("scopes ops-04 to PROD-OPS-04 with the bucket-only sandbox calls, on either lane", () => {
    const plan = buildPlan(settings);
    expect(plan.productCalls!.map(c => c.id)).toEqual(["teardown01-iam-read-observe", "teardown01-iam-read-deploy", "teardown01-iam-trust-observe", "teardown01-iam-trust-deploy", "teardown01-sts-assume", "teardown01-tag-read"]);
    expect(plan.estimate.usd).toBe(0.75);
    expect(buildPlan({ ...settings, lane: "live2" }).productCalls!.find(c => c.id === "teardown01-sts-assume")!.resource).toBe(`arn:aws:iam::${ACCOUNT}:role/ZenithDeployRole-live2`);
    expect(() => buildPlan({ ...settings, durationMinutes: 61 })).toThrow("5..60");
    expect((ops04Manifest(RUN, 2).resources as { name: string }[]).map(r => r.name)).toEqual(["ops04-000-ab04-1", "ops04-000-ab04-2"]);
  });
});

describe("OPS-04 port", () => {
  it("holds a planned deploy across the backup, restores, fences its approval, resumes it and proves AWS unchanged", async () => {
    const h = harness();
    const result = await h.run();
    expect(result.reason).toContain("OPS-04 restore proven on AWS");
    expect(result.complete).toBe(true);
    expect(result.reason).toContain("RPO 300 s");
    expect(result.reason).toContain("RTO 400 s");
    expect(h.events).toEqual([
      "manifest:1", "deploy", "manifest:2", "propose:worker=true", "stop:execution-worker", "backup", "start:execution-worker", "finish:resumed=false",
      "stop:api+execution-worker", "restore", "switch", "start:api:restored", "try-approve", "start:execution-worker:restored", "finish:resumed=true",
    ]);
    expect(h.destroyed()).toBe(true);
    expect(h.closed()).toBe(true);
    expect(h.trust).toEqual({ observe: trustDocument(PRINCIPAL, OLD_EXT), deploy: trustDocument(PRINCIPAL, OLD_EXT) });
  });

  it("refuses a resurrected approval, a changed AWS, an unrefused stale binding, a failed restore and a slow recovery", async () => {
    for (const [opts, why] of [
      [{ quietStatus: "succeeded" }, "moved on its own (operation succeeded)"],
      [{ fencedApprovalOk: true }, "accepted before a recovery decision"],
      [{ restoredStatus: "uncertain" }, "not a fenced plan review (operation uncertain)"],
      [{ extraBucket: true }, "the resumed deploy changed AWS"],
      [{ staleStatus: 200 }, "stale recovery binding was not refused"],
      [{ resumeRefused: true }, "the recovery resume was not accepted (HTTP 409; product: conflict: The operation changed since it was reviewed)"],
      [{ restoreOk: false }, "the restore did not complete (step verify: pg_restore failed (exit 1): schema \"auth\" does not exist at …path)"],
      [{ healthyAfterSeconds: 300 + 14_401 }, "not within the approved targets"],
      [{ resumedStatus: "failed" }, "the resumed deploy ended failed"],
    ] as [Opts, string][]) {
      const h = harness(opts);
      const result = await h.run();
      expect(result.complete).toBe(false);
      expect(result.reason).toContain(why);
      expect(h.destroyed()).toBe(true);
      expect(h.closed()).toBe(true);
    }
  });
});

describe("OPS-04 recovery failures", () => {
  it("names the recovery library's code and scrubbed message, never a URL or path", async () => {
    const { named } = await import("../../scripts/acceptance/live/product/ops-04-stack");
    const { RecoveryToolError } = await import("@/lib/ops/recovery/process");
    const failing = named("the backup", async () => { throw new RecoveryToolError("tool_failed", "pg_dump failed (exit 1): connection to postgres://[redacted] at /home/runner/x/y refused"); });
    await expect(failing).rejects.toThrow("the backup failed (tool_failed: pg_dump failed (exit 1): connection to …url at …path refused)");
    await expect(named("the restore", async () => { throw new TypeError("x".repeat(30)); })).rejects.toThrow("the restore failed (TypeError: …)");
  });
});
