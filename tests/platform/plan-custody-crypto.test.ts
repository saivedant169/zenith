/** PROD-DUR-05: worker identity-bound custody wrap. Pure; keys are generated at run time. */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { refusalTrace } from "@/lib/platform/plan-artifacts";
import { planCustodyCryptoFromEnv, WORKER_IDENTITY, type CustodyBinding } from "@/lib/platform/plan-custody-crypto";

const hex = (): string => randomBytes(32).toString("hex");
const binding = (over: Partial<CustodyBinding> = {}): CustodyBinding => ({
  workspaceId: "ws_a", operationId: "op_1", sourceOperationId: "op_1", manifestDigest: "a".repeat(64),
  workerIdentity: "worker-a", fenceToken: 3, expiresAt: "2030-01-01T00:00:00.000Z", ...over,
});
const env = () => ({ ZENITH_PLAN_ARTIFACT_KEY: hex(), ZENITH_SECRET_KEY: hex() });

describe("custody wrap is bound to the presenting worker identity", () => {
  it("opens for the exact binding and no other", () => {
    const crypto = planCustodyCryptoFromEnv(env());
    const wrap = crypto.wrap(binding());
    expect(crypto.opens(binding(), wrap)).toBe(true);
    for (const change of [
      { workerIdentity: "worker-b" }, { workspaceId: "ws_b" }, { operationId: "op_2" }, { sourceOperationId: "op_2" },
      { manifestDigest: "b".repeat(64) }, { fenceToken: 4 }, { expiresAt: "2031-01-01T00:00:00.000Z" },
    ] satisfies Partial<CustodyBinding>[]) expect(crypto.opens(binding(change), wrap), JSON.stringify(change)).toBe(false);
  });
  it("rejects altered wrap parts and a different key", () => {
    const e = env(), crypto = planCustodyCryptoFromEnv(e), wrap = crypto.wrap(binding());
    const flip = (value: string) => (value[0] === "A" ? "B" : "A") + value.slice(1);
    expect(crypto.opens(binding(), { ...wrap, ciphertext: flip(wrap.ciphertext) })).toBe(false);
    expect(crypto.opens(binding(), { ...wrap, authTag: flip(wrap.authTag) })).toBe(false);
    expect(crypto.opens(binding(), { ...wrap, iv: flip(wrap.iv) })).toBe(false);
    expect(crypto.opens(binding(), { ...wrap, tokenDigest: "c".repeat(64) })).toBe(false);
    expect(planCustodyCryptoFromEnv(env()).opens(binding(), wrap)).toBe(false);
  });
  it("wraps are unique per call and never expose the token", () => {
    const crypto = planCustodyCryptoFromEnv(env());
    const a = crypto.wrap(binding()), b = crypto.wrap(binding());
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.tokenDigest).not.toBe(b.tokenDigest);
    expect(a.ciphertext.length).toBeLessThanOrEqual(256);
    expect(a.iv).toHaveLength(16);
    expect(a.authTag).toHaveLength(24);
  });
  it("keeps opening grants across a plan artifact key rotation", () => {
    const first = hex(), vault = hex();
    const before = planCustodyCryptoFromEnv({ ZENITH_PLAN_ARTIFACT_KEY: first, ZENITH_SECRET_KEY: vault });
    const wrap = before.wrap(binding());
    const after = planCustodyCryptoFromEnv({ ZENITH_PLAN_ARTIFACT_KEY: hex(), ZENITH_PLAN_ARTIFACT_PREVIOUS_KEYS: JSON.stringify([first]), ZENITH_SECRET_KEY: vault });
    expect(after.opens(binding(), wrap)).toBe(true);
    expect(planCustodyCryptoFromEnv({ ZENITH_PLAN_ARTIFACT_KEY: hex(), ZENITH_SECRET_KEY: vault }).opens(binding(), wrap)).toBe(false);
  });
  it("refuses unusable keys and invalid identities without echoing them", () => {
    const key = hex();
    expect(() => planCustodyCryptoFromEnv({})).toThrow("Plan artifact keys are unavailable or invalid.");
    expect(() => planCustodyCryptoFromEnv({ ZENITH_PLAN_ARTIFACT_KEY: key, ZENITH_SECRET_KEY: key })).toThrow("Plan artifact keys are unavailable or invalid.");
    const crypto = planCustodyCryptoFromEnv(env());
    expect(() => crypto.wrap(binding({ workerIdentity: "bad worker!" }))).toThrow();
    expect(crypto.opens(binding({ workerIdentity: "bad worker!" }), crypto.wrap(binding()))).toBe(false);
    expect(WORKER_IDENTITY.test("zenith-pkg-arm64-0123456789ab")).toBe(true);
    expect(WORKER_IDENTITY.test("a:b")).toBe(false);
  });
});

describe("plan custody refusal trace", () => {
  it("keeps class, code and frames but never the message", () => {
    const e = Object.assign(new Error("value-abc-123"), { name: "PlanArtifactError", code: "plan_artifact_unavailable" });
    e.stack = "PlanArtifactError: value-abc-123\n    at refuse (/app/dist/execution/worker.cjs:1234:11)\n    at lockOwner (/app/dist/execution/worker.cjs:1300:5)";
    const trace = refusalTrace("publish", e);
    expect(trace).toBe("[zenith-diagnostic] plan custody publish refused: PlanArtifactError/plan_artifact_unavailable refuse @worker.cjs:1234 < lockOwner @worker.cjs:1300");
    expect(trace).not.toContain("value-abc-123");
    expect(refusalTrace("publish", "not an error")).toBe("[zenith-diagnostic] plan custody publish refused: ?/? ");
  });
});
