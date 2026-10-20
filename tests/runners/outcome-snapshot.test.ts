import { describe, expect, it } from "vitest";
import { snapshotOutcome } from "@/lib/runners/ports";
import { createAesResultSealer } from "@/lib/runners/seal";

describe("signed outcome snapshot", () => {
  const sealer = createAesResultSealer(new Uint8Array(32).fill(7), { keyId: "enc:results:v2" });
  const input = (sealed = sealer.seal("aad", { ok: true })) => ({
    workspaceId: "ws", agentId: "mac_1", jobId: "mreq_1", authenticatedPublicKey: "A".repeat(43), logicalDigest: "a".repeat(64), status: "succeeded" as const,
    sealed, result: { finishedAt: "2026-10-20T00:00:00.000Z", sealed },
  });

  it("accepts the key-ring sealer's named boxes and keeps the id-less shape receipts store", () => {
    const snap = snapshotOutcome(input());
    expect(Object.keys(snap.sealed).sort()).toEqual(["alg", "ct", "iv", "tag", "v"]);
    expect(sealer.open("aad", snap.sealed)).toEqual({ ok: true });
    expect(Object.keys(snap.result.sealed).sort()).toEqual(["alg", "ct", "iv", "tag", "v"]);
  });

  it.each([{ kid: "" }, { kid: "bad id" }, { kid: 7 }, { extra: "x" }])("refuses a malformed box %o", (extra) => {
    expect(() => snapshotOutcome(input({ ...sealer.seal("aad", 1), ...extra } as never))).toThrow("Invalid sealed agent outcome.");
  });
});
