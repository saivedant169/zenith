/**
 * OPS-05 offline: the key-rotation port with a fake browser driver, a fake runner stack, fake operator commands, in-memory AWS
 * answered only for planned calls through the real Guard, and a fake recorded state. No cloud, stack, PostgreSQL or Temporal is used.
 */
import { describe, expect, it } from "vitest";
import { buildPlan } from "../../scripts/acceptance/live/plan";
import { grantsFor, Guard } from "../../scripts/acceptance/live/guard";
import type { Call, Json, Plan } from "../../scripts/acceptance/live/contracts";
import { trustDocument } from "../../scripts/acceptance/live/product/mix-03";
import { ops05Manifest, ops05Port, ROTATED, type Custody } from "../../scripts/acceptance/live/product/ops-05";
import type { Deploy01Product } from "../../scripts/acceptance/live/product/deploy-01-driver";
import { privateMaterial, type Ops05Stack } from "../../scripts/acceptance/live/product/ops-05-stack";

const ACCOUNT = "123456789012", REGION = "ap-south-1", RUN = "zlive-202610300000-ab05";
const PRINCIPAL = `arn:aws:iam::${ACCOUNT}:role/ZenithLiveAcceptance`;
const OLD_EXT = "old-live-external-id", NEW_EXT = `zenith-${"c".repeat(32)}`;
const settings = { accountId: ACCOUNT, region: REGION, runId: RUN, durationMinutes: 50, dbSubnetGroup: "zenith-live-sandbox", dbSecurityGroup: "sg-12345678", workloadBoundaryArn: `arn:aws:iam::${ACCOUNT}:policy/ZenithLiveWorkloadBoundary`, scenario: "ops-05" as const };
const requirement = { id: "PROD-OPS-05", acceptance: [], fixtures: [], join: "" };
const COMMIT = "a".repeat(40);
const bucket = (n: number) => `arn:aws:s3:::ops05-0000ab05-${n}`;
const OLD_SECRET = "o".repeat(64), NEW_SECRET = "n".repeat(64);
const id = (purpose: string, generation: number) => `${purpose.replace(/\W/g, "")}${generation}`.padEnd(32, "0");

interface Opts { leak?: boolean; keepOld?: boolean; rewrapStatus?: string; oldUnavailable?: boolean; errorFinding?: boolean }

function harness(opts: Opts = {}) {
  const trust = { observe: trustDocument(PRINCIPAL, OLD_EXT), deploy: trustDocument(PRINCIPAL, OLD_EXT) };
  const events: string[] = [];
  let aws: string[] = [], destroyed = false, rotated = false, closed = false;
  const product: Deploy01Product = {
    createTenant: async () => ({ workspaceId: "ws1", projectId: "p1" }),
    createAwsConnection: async () => ({ connectionId: "c1", externalId: NEW_EXT }),
    verifyAws: async () => { events.push(`verify:${rotated}`); return { ok: true }; },
    createEnvironment: async () => ({ environmentId: "env1" }),
    setManifest: async (_t, m) => { events.push(`manifest:${(m.resources as unknown[]).length}:${(m.services as unknown[]).length}`); },
    setSecret: async (_t, input) => { events.push(`secret:${input.serviceId}:${input.key}`); },
    deploy: async () => { aws = rotated ? [bucket(1), bucket(2)] : [bucket(1)]; events.push(`deploy:${rotated}`); return { operationId: rotated ? "op2" : "op1", status: "succeeded" }; },
  };
  const temporal = (generation: number) => id("enc:temporal-payload", generation);
  const stack: Ops05Stack = {
    keys: () => ({ ZENITH_SECRET_KEY: rotated ? NEW_SECRET : OLD_SECRET }),
    secrets: () => [OLD_SECRET, ...(rotated ? [NEW_SECRET] : [])],
    rotate: async () => { events.push("rotate"); rotated = true; },
    history: async (operationId, label) => { events.push(`history:${operationId}:${label}`); return `/private/history-${label}.json`; },
    close: async () => { closed = true; },
  };
  const report = () => {
    const generation = rotated ? 2 : 1;
    return {
      purposes: Object.keys(ROTATED).map(purpose => ({ purpose, currentKeyId: id(purpose, generation) })),
      entries: Object.entries(ROTATED).flatMap(([purpose, role]) => [{ purpose, keyId: id(purpose, generation), role: "current" },
        ...(rotated && !(opts.keepOld === false && purpose === "enc:vault") ? [{ purpose, keyId: id(purpose, 1), role }] : [])]),
      violations: opts.errorFinding && rotated ? [{ severity: "error", code: "key_reused_across_purposes", purposes: ["enc:vault", "enc:results"] }] : [],
    };
  };
  const custody: Custody = async (args) => {
    events.push(`custody:${args[0]}`);
    const out = (value: unknown) => ({ code: 0, out: [JSON.stringify(value)], err: [] });
    if (args[0] === "sync") return out({ recorded: 9 });
    if (args[0] === "diagnose") return opts.leak && rotated ? { code: 0, out: [`${JSON.stringify(report())} ${NEW_SECRET}`], err: [] } : out(report());
    if (args[0] === "codec") {
      const first = args[2] === "/private/history-first.json";
      const status = !first ? "current_key" : rotated ? (opts.oldUnavailable ? "key_unavailable" : "decrypt_only_key") : "current_key";
      const byStatus = { legacy_plaintext: 1, current_key: 0, decrypt_only_key: 0, key_unavailable: 0, invalid_envelope: 0, [status]: 12 };
      return out({ total: 13, byStatus, byKeyId: { [first ? temporal(1) : temporal(2)]: 12 }, verified: { ok: status === "key_unavailable" ? 0 : 12, failed: status === "key_unavailable" ? 12 : 0 } });
    }
    if (args[0] === "rewrap") return { code: 0, out: [], err: ["The durable scheduler is current and is working the queue."] };
    return out({ id: "j1", workspaceId: "ws1", status: opts.rewrapStatus ?? "completed", inspected: 1, rewrapped: opts.rewrapStatus ? 0 : 1, unchanged: 0, batches: 1, errorCode: opts.rewrapStatus === "failed" ? "unreadable_row" : null });
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
    read: async () => ({ resources: [] }),
    destroy: async () => { destroyed = true; aws = []; return { destroyed: 2 }; },
  };
  const port = ops05Port({ ZENITH_LIVE_PRODUCT: "1" }, { product, stack, custody, sleep: async () => undefined, propagation: { attempts: 2, intervalMs: 0 }, rewrapMs: 0, state });
  return { events, trust, destroyed: () => destroyed, closed: () => closed, run: () => port.verify(requirement, { plan, commit: COMMIT, call }) };
}

describe("OPS-05 plan", () => {
  it("scopes ops-05 to PROD-OPS-05 with the bucket-only sandbox calls, on either lane", () => {
    const plan = buildPlan(settings);
    expect(plan.settings.scenario).toBe("ops-05");
    expect(plan.productCalls?.map(c => c.id)).toEqual(buildPlan({ ...settings, scenario: "ops-04" }).productCalls?.map(c => c.id));
    expect(buildPlan({ ...settings, lane: "live2" }).settings.lane).toBe("live2");
    expect((ops05Manifest(RUN, 2).resources as unknown[]).length).toBe(2);
    expect((ops05Manifest(RUN, 1, true).services as unknown[]).length).toBe(1);
  });
});

describe("OPS-05 key material scan", () => {
  it("scans plain keys, previous-key lists and private JWK members, never public keys or key ids", () => {
    expect(privateMaterial("ZENITH_SECRET_KEY", OLD_SECRET)).toEqual([OLD_SECRET]);
    expect(privateMaterial("ZENITH_VAULT_PREVIOUS_SECRET_KEYS", JSON.stringify([OLD_SECRET, NEW_SECRET]))).toEqual([OLD_SECRET, NEW_SECRET]);
    expect(privateMaterial("ZENITH_CONTROL_SIGNING_JWK", JSON.stringify({ kty: "OKP", crv: "Ed25519", x: "public", d: "private", kid: "control-1" }))).toEqual(["private"]);
    expect(privateMaterial("ZENITH_CONTROL_EXTRA_PUBLIC_JWKS", JSON.stringify([{ kty: "OKP", x: "public", kid: "control-0" }]))).toEqual([]);
  });
});

describe("OPS-05 port", () => {
  it("proves rotation with decrypt-only histories, then cleans up", async () => {
    const h = harness();
    const result = await h.run();
    expect(result.reason).toContain("OPS-05 key custody proven on AWS");
    expect(result.complete).toBe(true);
    expect(h.events.filter(e => !e.startsWith("custody:sync"))).toEqual([
      "verify:false", "manifest:1:1", "secret:web:ZENITH_OPS05_CANARY", "manifest:1:0", "deploy:false", "history:op1:first", "custody:codec", "custody:diagnose",
      "rotate", "custody:diagnose", "verify:true", "custody:codec", "manifest:2:0", "deploy:true", "history:op2:second", "custody:codec", "custody:rewrap", "custody:rewrap-status",
    ]);
    expect(h.destroyed()).toBe(true);
    expect(h.closed()).toBe(true);
    expect(h.trust.observe).toBe(trustDocument(PRINCIPAL, OLD_EXT));
  });

  it.each([
    [{ leak: true }, "diagnose after rotation: key-custody diagnose (after rotation) printed key material"],
    [{ keepOld: false }, "diagnose after rotation: enc:vault did not keep its old key decrypt-only"],
    [{ errorFinding: true }, "diagnose after rotation: the rotated keys have error findings (key_reused_across_purposes)"],
    [{ oldUnavailable: true }, "first history after rotation: the first deploy's history does not need exactly the now decrypt-only Temporal key"],
    [{ rewrapStatus: "failed" }, "vault re-wrap: the vault re-wrap did not complete (failed: unreadable_row)"],
  ] as [Opts, string][])("refuses %o and still cleans up", async (opts, reason) => {
    const h = harness(opts);
    const result = await h.run();
    expect(result.complete).toBe(false);
    expect(result.reason).toBe(`OPS-05 not proven at ${reason}`);
    expect(h.destroyed()).toBe(true);
    expect(h.trust.deploy).toBe(trustDocument(PRINCIPAL, OLD_EXT));
  });
});
