/** Real PGlite connection repositories; verification transport is explicitly fake. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlatformDbHandle } from "@/lib/controlplane/db";
import type { AwsConnectionConfig } from "@/lib/credentials/types";
import { tempDataDir } from "../_support/data-dir";
tempDataDir("zenith-bridge-connections-", { fast: true });
const { ctx, seed } = await import("./support");
const { db, q, readAudit } = await import("@/lib/db/store");
const { runAction } = await import("@/lib/actions/core");
const { ensureEngine } = await import("@/lib/engine/engine");
const { openPlatformDb, repos } = await import("@/lib/controlplane/db");
const { setBridgeDepsForTests } = await import("@/lib/bridge/deps");
const { isExternalId } = await import("@/lib/credentials/aws/arn");
await import("@/lib/actions/defs");
const input = { accountId: "123456789012", region: "us-east-1", observeRoleArn: "arn:aws:iam::123456789012:role/ZenithObserve", deployRoleArn: "arn:aws:iam::123456789012:role/ZenithDeploy" };
const exec = async (action: string, value: unknown = input, actorId = ctx.actor.id) => (await runAction(action, { ...ctx, actor: { ...ctx.actor, id: actorId } }, value, { mode: "execute" })).result!;
const plan = async (value: unknown = input) => (await runAction("connection.createAws", ctx, value, { mode: "plan" })).plan!;
let sql: PlatformDbHandle;
const verify = vi.fn(async () => ({ ok: true, detail: "Assumed the observe role in account 123456789012." }));
beforeAll(async () => { sql = await openPlatformDb({ kind: "pglite" }); }, 60_000);
afterAll(async () => { await sql?.close(); });
beforeEach(() => {
  seed(); ensureEngine(); vi.clearAllMocks();
  verify.mockResolvedValue({ ok: true, detail: "Assumed the observe role in account 123456789012." });
  vi.stubEnv("ZENITH_OIDC_ISSUER", "https://bridge.example.com/api/oidc");
  setBridgeDepsForTests({ connectionSql: async () => sql, credentialBroker: async (resolve) => ({ verifyConnection: async (id, opts) => { expect((await resolve(id))?.workspaceId).toBe(opts.workspaceId); return verify(); } }) });
});
afterEach(() => { setBridgeDepsForTests(null); vi.unstubAllEnvs(); });

describe("strict validation", () => {
  it.each([
    { observeRoleArn: "not-an-arn" }, { deployRoleArn: "arn:aws:iam::000000000000:role/foreign" },
    { region: "moon-1" }, { accountId: "12345678901" }, { accessKeyId: "CANARY" }, { secretAccessKey: "CANARY" },
    { externalId: "caller-supplied" }, { sessionDurationSec: 899 }, { sessionDurationSec: 3601 }, { stateBucket: "bad..bucket" },
    { permissionsBoundaryArn: "arn:aws:iam::000000000000:policy/foreign" }, { stateKmsKeyArn: "invalid" }, { codeBuildRoleArn: "not-an-arn" },
    { bootstrapNameSuffix: "team-a" }, { bootstrapNameSuffix: "-" }, { bootstrapNameSuffix: "-Team-a" }, { bootstrapNameSuffix: "-team/a" }, { bootstrapNameSuffix: "-team-a\n" }, { bootstrapNameSuffix: `-${"a".repeat(20)}` },
    { observeRoleArn: "arn:aws-cn:iam::123456789012:role/Observe" }, { deployRoleArn: "arn:aws-us-gov:iam::123456789012:role/Deploy" },
    { codeBuildRoleArn: "arn:aws-cn:iam::123456789012:role/build" }, { codeBuildRoleArn: "arn:aws:iam::210987654321:role/build" },
    { secretWriterRoleArn: "not-an-arn" }, { secretWriterRoleArn: "arn:aws:iam::210987654321:role/ZenithSecretWriterRole" },
    { secretWriterRoleArn: "arn:aws:iam::123456789012:role/ZenithDeploy" }, { secretWriterRoleArn: "arn:aws:iam::123456789012:role/ZenithObserve" },
    { stateKmsKeyArn: "arn:aws-cn:kms:cn-north-1:123456789012:key/abcd" }, { stateKmsKeyArn: "arn:aws-us-gov:kms:us-gov-west-1:123456789012:key/abcd" },
    { stateKmsKeyArn: "arn:aws:kms:us-east-1:210987654321:key/abcd" }, { stateKmsKeyArn: "arn:aws:kms:us-west-2:123456789012:key/abcd" },
  ])("rejects invalid input %j before any write", async (bad) => {
    const r = await exec("connection.createAws", { ...input, ...bad }); expect(r.ok).toBe(false); expect(r.summary).toBe("Invalid input."); expect(JSON.stringify(r)).not.toContain("CANARY"); expect(db().connections).toHaveLength(1);
  });
});
it("plan names bootstrap path, issuer host, permission limits and honest placeholder", async () => {
  const p = await plan(); expect(p.blocked).toBeUndefined();
  const prose = p.details.join(" "); expect(prose).toContain("deploy/aws/zenith-connection.cfn.yaml"); expect(prose).toContain("deploy/aws/tofu-module"); expect(prose).toContain("bridge.example.com/api/oidc"); expect(prose).toContain(`zenith:ws:${ctx.workspaceId}:conn:<connection-id>`); expect(prose).toContain("right after creation"); expect(prose).toContain("cannot read secret values"); expect(prose).toContain("No live verification");
});
it("creates linked records with exactly the same id, pending verification and real subject", async () => {
  const r = await exec("connection.createAws"); expect(r.ok).toBe(true);
  const data = r.data as { connectionId: string; subject: string };
  const conn = q.connection(data.connectionId)!; const platform = await repos.connections.get(sql, ctx.workspaceId, data.connectionId);
  expect(conn).toMatchObject({ provider: "aws", status: "connecting", platformConnectionId: data.connectionId });
  expect(platform).toMatchObject({ id: data.connectionId, legacyConnectionId: data.connectionId, status: "pending_verification", config: { mode: "oidc_web_identity", accountId: input.accountId, bootstrapNameSuffix: "" } });
  expect(data.subject).toBe(`zenith:ws:${ctx.workspaceId}:conn:${data.connectionId}`); expect(verify).not.toHaveBeenCalled();
});
it("saves the bootstrap's distinct secret writer role on the connection", async () => {
  const secretWriterRoleArn = "arn:aws:iam::123456789012:role/ZenithSecretWriterRole";
  const result = await exec("connection.createAws", { ...input, secretWriterRoleArn });
  expect(result.ok).toBe(true);
  const { connectionId } = result.data as { connectionId: string };
  expect((await repos.connections.get(sql, ctx.workspaceId, connectionId))?.config).toMatchObject({ secretWriterRoleArn });
});
it.each(["-team-a", `-${"a".repeat(19)}`])("round trips bootstrap suffix %j through the saved connection", async (bootstrapNameSuffix) => {
  const result = await exec("connection.createAws", { ...input, bootstrapNameSuffix });
  expect(result.ok).toBe(true);
  const { connectionId } = result.data as { connectionId: string };
  expect(await repos.connections.get(sql, ctx.workspaceId, connectionId)).toMatchObject({ config: { bootstrapNameSuffix } });
});
it("assume-role generates distinct valid ExternalIds and names ZenithPrincipalArn", async () => {
  const a = await exec("connection.createAws", { ...input, mode: "aws_assume_role" }); const b = await exec("connection.createAws", { ...input, mode: "aws_assume_role" });
  const data = a.data as { connectionId: string; externalId: string; requiredTemplateParameter: string };
  expect(isExternalId(data.externalId)).toBe(true); expect(data.externalId).toMatch(/^zenith-[a-f0-9]{32}$/); expect(data.externalId).not.toBe((b.data as typeof data).externalId); expect(data.requiredTemplateParameter).toBe("ZenithPrincipalArn");
  const platform = await repos.connections.get(sql, ctx.workspaceId, data.connectionId); expect((platform!.config as AwsConnectionConfig).externalId).toBe(data.externalId);
});
it("OIDC issuer missing blocks plan and execute, assume-role remains possible", async () => {
  vi.stubEnv("ZENITH_OIDC_ISSUER", ""); expect((await plan()).blocked).toContain("ZENITH_OIDC_ISSUER"); expect((await exec("connection.createAws")).ok).toBe(false);
  expect((await exec("connection.createAws", { ...input, mode: "aws_assume_role" })).ok).toBe(true);
});
it("an HTTP loopback issuer is unusable for live AWS trust", async () => {
  vi.stubEnv("ZENITH_OIDC_ISSUER", "http://127.0.0.1:3000/api/oidc"); expect((await plan()).blocked).toContain("public HTTPS");
});
it("editor cannot create and viewer cannot verify", async () => {
  expect((await exec("connection.createAws", input, "editor")).error).toContain("role_denied");
  expect((await exec("connection.verifyAws", { connectionId: "bridge-connection" }, "viewer")).error).toContain("role_denied");
});
it.each([true, false])("verification projects both records (ok=%s)", async (ok) => {
  const r = await exec("connection.createAws"); const { connectionId } = r.data as { connectionId: string };
  verify.mockResolvedValue({ ok, detail: ok ? "Observe identity verified." : "Trust was denied." });
  const verified = await exec("connection.verifyAws", { connectionId }, "editor"); expect(verified.ok).toBe(ok); expect(verify).toHaveBeenCalledTimes(1);
  expect(q.connection(connectionId)).toMatchObject({ status: ok ? "healthy" : "disconnected", lastCheckedAt: expect.any(String) });
  expect(await repos.connections.get(sql, ctx.workspaceId, connectionId)).toMatchObject({ status: ok ? "verified" : "failed", verificationDetail: ok ? "Observe identity verified." : "Trust was denied." });
});
it("foreign ids and revoked platform connections cannot verify", async () => {
  const r = await exec("connection.createAws"); const { connectionId } = r.data as { connectionId: string };
  q.connection(connectionId)!.workspaceId = "foreign";
  const foreign = await exec("connection.verifyAws", { connectionId }); const missing = await exec("connection.verifyAws", { connectionId: "missing" }); expect(foreign.error?.replace(connectionId, "missing")).toBe(missing.error); expect(foreign.error).toContain("does not exist"); expect(verify).not.toHaveBeenCalled();
  q.connection(connectionId)!.workspaceId = ctx.workspaceId; await repos.connections.revoke(sql, ctx.workspaceId, connectionId);
  expect((await exec("connection.verifyAws", { connectionId })).ok).toBe(false); expect(verify).not.toHaveBeenCalled();
});
it("platform resolver is tenant-scoped even for a corrupted legacy link", async () => {
  const foreign = await repos.connections.create(sql, { workspaceId: "other", createdBy: "other", config: { ...input, provider: "aws", mode: "oidc_web_identity" } });
  q.connection("bridge-connection")!.platformConnectionId = foreign.id;
  expect((await exec("connection.verifyAws", { connectionId: "bridge-connection" })).ok).toBe(false); expect(verify).not.toHaveBeenCalled();
});
it("transport errors expose no credential canary in results, records or audit", async () => {
  const r = await exec("connection.createAws"); const { connectionId } = r.data as { connectionId: string }; verify.mockRejectedValueOnce(new Error("CANARY-secret-session"));
  const result = await exec("connection.verifyAws", { connectionId }); expect(result.ok).toBe(false);
  expect(JSON.stringify({ result, conn: q.connection(connectionId), platform: await repos.connections.get(sql, ctx.workspaceId, connectionId), audit: readAudit() })).not.toContain("CANARY");
});
