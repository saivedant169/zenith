/**
 * PROD-DUR-05: cross-worker custody of encrypted plan artifacts on the real platform schema (PGlite always, PostgreSQL when
 * ZENITH_TEST_PLATFORM_PG_URL is set). Artifact rows are explicitly synthetic storage: the AEAD ciphertext and engine are
 * covered by the verified native handoff suites; these cases prove tenant, fence, expiry, integrity and identity gating
 * of the custody grants and the audit trail. Keys are generated at run time.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { digest } from "@/lib/controlplane/digest";
import * as repos from "@/lib/controlplane/db/repos";
import * as custody from "@/lib/controlplane/db/repos/plan-custody";
import type { ArtifactAccess } from "@/lib/controlplane/db/repos/plan-artifacts";
import { proposeOperation } from "@/lib/controlplane/operations";
import type { Sql } from "@/lib/controlplane/types";
import type { PlanArtifactsPort } from "@/lib/execution/ports";
import { planCustodyCryptoFromEnv } from "@/lib/platform/plan-custody-crypto";
import { withWorkerCustody } from "@/lib/platform/plan-custody";
import { LANES, newWorkspace, openLane, proposalFor, uid, user } from "./_support/harness";

const crypto = planCustodyCryptoFromEnv({ ZENITH_PLAN_ARTIFACT_KEY: randomBytes(32).toString("hex"), ZENITH_SECRET_KEY: randomBytes(32).toString("hex") });
const future = "2099-01-01T00:00:00.000Z", past = "2020-01-01T00:00:00.000Z";

describe.each(LANES)("plan custody grants [$name]", (lane) => {
  let ctx: Awaited<ReturnType<typeof openLane>>;
  let db: Sql;
  beforeAll(async () => { ctx = await openLane(lane); db = ctx.db; }, 60_000);
  afterAll(async () => { await ctx?.close(); });

  async function fixture(artifactExpiresAt = future, workspaceId = newWorkspace()) {
    const environmentId = uid("env");
    const { operation: op } = await proposeOperation(db, { workspaceId, principal: user(),
      proposal: proposalFor(workspaceId, { scope: { workspaceId, projectId: "proj_1", environmentId } }), status: "approved" });
    const lease = (await repos.leases.acquire(db, { scope: `env:${environmentId}`, holder: `workflow:${op.id}`, ttlMs: 600_000, workspaceId }))!;
    const bind = (fence: number) => db.query(`update platform.operations set status='running', lease_holder=$3, lease_scope=$4, fence_token=$5,
      lease_until=clock_timestamp()+interval '1 hour', expires_at=clock_timestamp()+interval '1 day' where workspace_id=$1 and id=$2`,
      [workspaceId, op.id, `workflow:${op.id}`, `env:${environmentId}`, fence]);
    await bind(lease.fenceToken);
    const planDigest = digest({ plan: op.id });
    const manifest = { workspaceId, operationId: op.id, projectId: "proj_1", environmentId, planDigest, privateCanary: "synthetic-manifest" };
    await db.query(`insert into platform.plan_artifacts (workspace_id,operation_id,manifest,manifest_digest,plan_digest,iv,auth_tag,ciphertext,expires_at)
      values ($1,$2,$3::text::jsonb,$4,$5,$6,$7,$8,$9::timestamptz)`,
      [workspaceId, op.id, JSON.stringify(manifest), digest(manifest), planDigest, "x".repeat(16), "x".repeat(24), "synthetic-encrypted-storage", artifactExpiresAt]);
    await db.query("insert into platform.plan_artifact_uses (workspace_id,operation_id) values ($1,$2)", [workspaceId, op.id]);
    const access = (fence = lease.fenceToken): ArtifactAccess => ({
      custody: { workspaceId, projectId: "proj_1", environmentId, operationId: op.id, proposalDigest: op.proposalDigest, inputDigest: op.inputDigest,
        expiresAt: op.expiresAt, sourceDigest: digest("source"), graphDigest: digest("graph") },
      planDigest, lease: { scope: `env:${environmentId}`, holder: lease.holder, fenceToken: fence } });
    return { workspaceId, environmentId, op, lease, access, bind, planDigest };
  }
  const reasons = (rows: Awaited<ReturnType<typeof custody.listReads>>, outcome: "allowed" | "refused") => rows.filter(r => r.outcome === outcome).map(r => r.reason);
  const refusal = async (promise: Promise<unknown>) => (await promise.then(() => undefined, (e: unknown) => e)) as custody.PlanCustodyError | undefined;

  it("admits a worker under the live fence and verifies on every later read, auditing each", async () => {
    const f = await fixture();
    await custody.admit(db, f.access(), "worker-a", crypto);
    await custody.verify(db, f.access(), "worker-a", crypto, "inspect_verified");
    await custody.verify(db, f.access(), "worker-a", crypto, "dispatch_verified");
    const reads = await custody.listReads(db, f.workspaceId, f.op.id);
    expect(reasons(reads, "allowed").sort()).toEqual(["admitted", "dispatch_verified", "inspect_verified"]);
    expect(reads.every(r => r.workerIdentity === "worker-a" && r.manifestDigest !== null)).toBe(true);
    // The grant stores a wrap, never plan bytes or the manifest.
    const grants = await db.query<Record<string, unknown>>("select * from platform.plan_custody_grants where workspace_id=$1", [f.workspaceId]);
    expect(JSON.stringify(grants)).not.toContain("synthetic");
  });

  it("is idempotent for the same identity and fence and independent per worker identity", async () => {
    const f = await fixture();
    await custody.admit(db, f.access(), "worker-a", crypto);
    await custody.admit(db, f.access(), "worker-a", crypto);
    await custody.admit(db, f.access(), "worker-b", crypto);
    const rows = await db.query("select worker_identity from platform.plan_custody_grants where workspace_id=$1 order by worker_identity", [f.workspaceId]);
    expect(rows.map(r => (r as { worker_identity: string }).worker_identity)).toEqual(["worker-a", "worker-b"]);
  });

  it("refuses a worker that was never admitted and records the refusal", async () => {
    const f = await fixture();
    await custody.admit(db, f.access(), "worker-a", crypto);
    const error = await refusal(custody.verify(db, f.access(), "worker-b", crypto, "inspect_verified"));
    expect(error).toBeInstanceOf(custody.PlanCustodyError);
    expect(error?.reason).toBe("grant_missing");
    expect(reasons(await custody.listReads(db, f.workspaceId, f.op.id), "refused")).toEqual(["grant_missing"]);
  });

  it("rejects a grant copied between workers, a tampered expiry and a tampered wrap", async () => {
    const f = await fixture();
    await custody.admit(db, f.access(), "worker-a", crypto);
    await custody.admit(db, f.access(), "worker-b", crypto);
    const copy = `update platform.plan_custody_grants b set token_digest=a.token_digest, wrap_iv=a.wrap_iv, wrap_tag=a.wrap_tag, wrap_ciphertext=a.wrap_ciphertext
      from platform.plan_custody_grants a where a.workspace_id=$1 and a.worker_identity='worker-a' and b.workspace_id=$1 and b.worker_identity='worker-b'`;
    await db.query(copy, [f.workspaceId]);
    expect((await refusal(custody.verify(db, f.access(), "worker-b", crypto, "inspect_verified")))?.reason).toBe("grant_integrity");
    await custody.verify(db, f.access(), "worker-a", crypto, "inspect_verified");
    await db.query("update platform.plan_custody_grants set expires_at=expires_at + interval '1 minute' where workspace_id=$1 and worker_identity='worker-a'", [f.workspaceId]);
    expect((await refusal(custody.verify(db, f.access(), "worker-a", crypto, "inspect_verified")))?.reason).toBe("grant_integrity");
    expect((await refusal(custody.admit(db, f.access(), "worker-a", crypto)))?.reason).toBe("grant_integrity");
  });

  it("revocation stops a worker permanently in that workspace and leaves others untouched", async () => {
    const f = await fixture();
    await custody.admit(db, f.access(), "worker-a", crypto);
    await custody.admit(db, f.access(), "worker-b", crypto);
    expect(await custody.revokeWorker(db, f.workspaceId, "worker-b")).toBe(1);
    expect((await refusal(custody.verify(db, f.access(), "worker-b", crypto, "dispatch_verified")))?.reason).toBe("worker_revoked");
    expect((await refusal(custody.admit(db, f.access(), "worker-b", crypto)))?.reason).toBe("worker_revoked");
    await custody.verify(db, f.access(), "worker-a", crypto, "inspect_verified");
    expect(await custody.revokeWorker(db, f.workspaceId, "bad worker!")).toBe(0);
  });

  it("an expired grant fails verification and is renewed only by a fresh admission under the live fence", async () => {
    const f = await fixture();
    await custody.admit(db, f.access(), "worker-a", crypto);
    const [artifact] = await db.query<{ manifest_digest: string }>("select manifest_digest from platform.plan_artifacts where workspace_id=$1 and operation_id=$2", [f.workspaceId, f.op.id]);
    // Re-wrap honestly for a past expiry so the row stays authentic but expired.
    const wrap = crypto.wrap({ workspaceId: f.workspaceId, operationId: f.op.id, sourceOperationId: f.op.id, manifestDigest: artifact.manifest_digest,
      workerIdentity: "worker-a", fenceToken: f.lease.fenceToken, expiresAt: past });
    await db.query(`update platform.plan_custody_grants set expires_at=$2::timestamptz, token_digest=$3, wrap_iv=$4, wrap_tag=$5, wrap_ciphertext=$6
      where workspace_id=$1 and worker_identity='worker-a'`, [f.workspaceId, past, wrap.tokenDigest, wrap.iv, wrap.authTag, wrap.ciphertext]);
    expect((await refusal(custody.verify(db, f.access(), "worker-a", crypto, "inspect_verified")))?.reason).toBe("grant_expired");
    await custody.admit(db, f.access(), "worker-a", crypto);
    await custody.verify(db, f.access(), "worker-a", crypto, "inspect_verified");
    const [renewed] = await db.query<{ live: boolean }>("select expires_at > clock_timestamp() as live from platform.plan_custody_grants where workspace_id=$1 and worker_identity='worker-a'", [f.workspaceId]);
    expect(renewed.live).toBe(true);
  });

  it("refuses an expired artifact, a foreign tenant and a lost fence", async () => {
    const expired = await fixture(past);
    expect((await refusal(custody.admit(db, expired.access(), "worker-a", crypto)))?.reason).toBe("artifact_expired");
    const a = await fixture(), b = await fixture();
    // Workspace B's operation presenting workspace A's plan digest finds no artifact in B.
    const crossed: ArtifactAccess = { ...b.access(), planDigest: a.planDigest };
    expect((await refusal(custody.admit(db, crossed, "worker-a", crypto)))?.reason).toBe("artifact_unavailable");
    // A fence that is not the live one.
    expect((await refusal(custody.admit(db, a.access(a.lease.fenceToken + 7), "worker-a", crypto)))?.reason).toBe("fence_lost");
    // Nothing from the failed attempts granted anything.
    expect(await db.query("select 1 from platform.plan_custody_grants where workspace_id=$1", [b.workspaceId])).toHaveLength(0);
  });

  it("a superseding fence revokes older grants and the old holder fails verification", async () => {
    const f = await fixture();
    await custody.admit(db, f.access(), "worker-a", crypto);
    const next = (await repos.leases.acquire(db, { scope: `env:${f.environmentId}`, holder: f.lease.holder, ttlMs: 600_000, workspaceId: f.workspaceId }))!;
    expect(next.fenceToken).toBeGreaterThan(f.lease.fenceToken);
    await f.bind(next.fenceToken);
    // Old fence: the operation no longer runs under it.
    expect((await refusal(custody.verify(db, f.access(f.lease.fenceToken), "worker-a", crypto, "dispatch_verified")))?.reason).toMatch(/operation_not_live|grant_missing/);
    await custody.admit(db, f.access(next.fenceToken), "worker-b", crypto);
    const states = await db.query<{ worker_identity: string; fence_token: number; revoke_reason: string | null }>(
      "select worker_identity, fence_token, revoke_reason from platform.plan_custody_grants where workspace_id=$1 order by fence_token", [f.workspaceId]);
    expect(states[0]).toMatchObject({ worker_identity: "worker-a", revoke_reason: "superseded_fence" });
    expect(states[1].revoke_reason).toBeNull();
  });

  it("two independent connections admitting the same worker and fence converge on exactly one grant", async () => {
    const f = await fixture();
    const results = await Promise.allSettled([custody.admit(ctx.db, f.access(), "worker-a", crypto), custody.admit(ctx.db2, f.access(), "worker-a", crypto)]);
    expect(results.map(r => r.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(await db.query("select 1 from platform.plan_custody_grants where workspace_id=$1 and worker_identity='worker-a' and revoked_at is null", [f.workspaceId])).toHaveLength(1);
    const reads = await custody.listReads(db, f.workspaceId, f.op.id);
    expect(reasons(reads, "allowed")).toEqual(["admitted", "admitted"]);
    expect(reasons(reads, "refused")).toEqual([]);
    await custody.verify(ctx.db2, f.access(), "worker-a", crypto, "inspect_verified");
  });

  it("when a superseding fence races a stale-fence admission from another connection exactly one live grant survives", async () => {
    const f = await fixture();
    const next = (await repos.leases.acquire(db, { scope: `env:${f.environmentId}`, holder: f.lease.holder, ttlMs: 600_000, workspaceId: f.workspaceId }))!;
    await f.bind(next.fenceToken);
    const [stale, current] = await Promise.allSettled([
      custody.admit(ctx.db, f.access(f.lease.fenceToken), "worker-a", crypto),
      custody.admit(ctx.db2, f.access(next.fenceToken), "worker-b", crypto),
    ]);
    expect(stale.status).toBe("rejected");
    expect(((stale as PromiseRejectedResult).reason as custody.PlanCustodyError).reason).toMatch(/fence_lost|operation_not_live/);
    expect(current.status).toBe("fulfilled");
    const live = await db.query<{ worker_identity: string; fence_token: number }>(
      "select worker_identity, fence_token from platform.plan_custody_grants where workspace_id=$1 and revoked_at is null", [f.workspaceId]);
    expect(live).toHaveLength(1);
    expect(live[0].worker_identity).toBe("worker-b");
    expect(Number(live[0].fence_token)).toBe(next.fenceToken);
  });

  it("receipts and probes are append-only", async () => {
    const f = await fixture();
    await custody.admit(db, f.access(), "worker-a", crypto);
    await expect(db.query("update platform.plan_custody_reads set reason='tampered' where workspace_id=$1", [f.workspaceId])).rejects.toThrow();
    await expect(db.query("delete from platform.plan_custody_reads where workspace_id=$1", [f.workspaceId])).rejects.toThrow();
  });

  it("the production wrapper admits before any read and re-verifies immediately before dispatch", async () => {
    const f = await fixture();
    const calls: string[] = [];
    let dispatched = 0;
    const inner: PlanArtifactsPort = {
      kind: "isolated-test",
      associate: async () => { calls.push("associate"); },
      publish: async () => { calls.push("publish"); },
      inspect: async (_i, fn) => { calls.push("inspect"); return fn({ manifest: {} as never }); },
      consume: async (_i, fn) => { calls.push("consume"); return fn({ manifest: {} as never }, async () => { dispatched++; }); },
    };
    const port = withWorkerCustody(inner, { db, workerIdentity: "worker-a", crypto });
    await port.inspect(f.access(), async () => undefined);
    expect(calls).toEqual(["inspect"]);
    expect(reasons(await custody.listReads(db, f.workspaceId, f.op.id), "allowed")).toContain("inspect_verified");
    // A revocation after admission but before the CAS stops the dispatch.
    await expect(port.consume(f.access(), async (_approved, dispatch) => {
      await custody.revokeWorker(db, f.workspaceId, "worker-a");
      await dispatch();
    })).rejects.toBeInstanceOf(custody.PlanCustodyError);
    expect(dispatched).toBe(0);
    // A revoked identity never reaches the wrapped port at all.
    calls.length = 0;
    await expect(port.inspect(f.access(), async () => undefined)).rejects.toBeInstanceOf(custody.PlanCustodyError);
    expect(calls).toEqual([]);
  });
});
