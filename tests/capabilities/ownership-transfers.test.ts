/**
 * PROD-LIFE-12: the default-on broker guard and persisted ownership transfers.
 * Needs the platform schema (PGlite lane here; set ZENITH_TEST_PLATFORM_PG_URL for Postgres as well).
 *
 *   conflict -> refused with the exact transfer digest
 *   requestOwnershipTransfer -> proposal names the exact transfer, human approval required
 *   approval (human, exact digest) -> durable, tenant-scoped transfer row
 *   next proposal -> allowed; revocation -> refused again
 */
import { describe, expect, it, vi } from "vitest";
import * as repos from "@/lib/controlplane/db/repos";
import type { BrokerProposal } from "@/lib/capabilities/types";
import type { Sql } from "@/lib/controlplane/types";
import { isBrokerError } from "@/lib/capabilities/errors";
import { checkNativeOperation, transferRequest } from "@/lib/ownership";
import { createExecutionBroker } from "@/lib/platform/broker";
import { approve, seedAwaitingApproval, uid } from "../controlplane/_support/harness";
import { STORE_KINDS, approveAs, closeSharedPgliteAfterAll, expectBrokerError, makeHarness, proposeOk, requestFor, user, type Harness } from "./support";

closeSharedPgliteAfterAll();

const ADDRESS = "container_service/web";

async function seedAutoscaledService(h: Harness): Promise<void> {
  await h.db!.query(
    `insert into platform.resources (id, workspace_id, environment_id, address, kind, provider, native_type, ownership, spec_digest, spec)
     values ($1,$2,$3,$4,'container_service','aws','aws:ecs_service','managed',$5,$6::text::jsonb)`,
    [h.ids.resAWebProd, h.ids.wsA, h.ids.envAProd, ADDRESS, "a".repeat(64), JSON.stringify({ replicas: 2, autoscaling: { min: 2, max: 8 } })]
  );
}

const scale = (h: Harness, extra: Record<string, unknown> = {}) => requestFor(h, "service.scale", "prod", { input: { replicas: 5, ...extra } });

describe.each(STORE_KINDS.filter((k) => k !== "memory"))("ownership transfers [%s]", (kind) => {
  it("refuses scaling an autoscaled service by default and names the transfer an approver would need", async () => {
    const h = await makeHarness({ kind });
    await seedAutoscaledService(h);
    const err = await expectBrokerError(h.broker.propose(scale(h), user("bob")), "conflict");
    expect(err.details).toMatchObject({ reason: "field_ownership_conflict", conflicts: [{ owner: "autoscaler", writer: "native-op", verdict: "transfer_required" }] });
  });

  it("persists a transfer only when a human approves the exact proposal that names it", async () => {
    const h = await makeHarness({ kind });
    await seedAutoscaledService(h);
    const op = await proposeOk(h, scale(h, { requestOwnershipTransfer: true }), user("bob"));
    expect(op.operation.status).toBe("awaiting_approval");
    // The public view omits internal broker metadata; the exact reviewed
    // transfers are held in the tenant-scoped immutable proposal row.
    const stored = await repos.operations.get(h.db!, h.ids.wsA, op.id);
    expect(stored?.proposalDigest).toBe(op.digest);
    expect(op.operation.proposal).not.toHaveProperty("broker");
    const transfers = (stored!.proposal as BrokerProposal).broker?.ownershipTransfers;
    expect(transfers).toHaveLength(1);
    expect(transfers![0]).toMatchObject({ from: "autoscaler", to: "native-op" });

    expect(await repos.ownershipTransfers.listActive(h.db!, h.ids.wsA, h.ids.envAProd)).toEqual([]);
    await approveAs(h, op.operation, "dave");
    const active = await repos.ownershipTransfers.listActive(h.db!, h.ids.wsA, h.ids.envAProd, ADDRESS);
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ address: ADDRESS, from: "autoscaler", to: "native-op", digest: transfers![0]!.digest });
    const approval = (await repos.approvals.listForOperation(h.db!, h.ids.wsA, op.id)).find(row => row.decision === "approve")!;
    const originalRows = await h.db!.query("select * from platform.ownership_transfers where workspace_id=$1 and operation_id=$2", [h.ids.wsA, op.id]);
    expect(await repos.ownershipTransfers.recordForApprovedOperation(h.db!, { workspaceId: h.ids.wsA, operationId: op.id, approvalId: approval.id })).toEqual(active);
    expect(await h.db!.query("select * from platform.ownership_transfers where workspace_id=$1 and operation_id=$2", [h.ids.wsA, op.id])).toEqual(originalRows);
    // a foreign workspace sees nothing and cannot revoke
    expect(await repos.ownershipTransfers.listActive(h.db!, "ws_other", h.ids.envAProd)).toEqual([]);
    expect(await repos.ownershipTransfers.revoke(h.db!, { workspaceId: "ws_other", transferDigest: active[0]!.digest, operationId: op.id, revokedBy: "x" })).toBe(false);

    // with the transfer on record the next scale proposal is no longer a conflict
    const next = await proposeOk(h, scale(h), user("bob"));
    expect(["awaiting_approval", "approved"]).toContain(next.operation.status);

    // revocation is one-way and restores the refusal
    expect(await repos.ownershipTransfers.revoke(h.db!, { workspaceId: h.ids.wsA, transferDigest: active[0]!.digest, operationId: op.id, revokedBy: "dave" })).toBe(true);
    expect(await repos.ownershipTransfers.revoke(h.db!, { workspaceId: h.ids.wsA, transferDigest: active[0]!.digest, operationId: op.id, revokedBy: "dave" })).toBe(false);
    await expect(repos.ownershipTransfers.recordForApprovedOperation(h.db!, { workspaceId: h.ids.wsA, operationId: op.id, approvalId: approval.id })).rejects.toMatchObject({ code: "conflict" });
    await expectBrokerError(h.broker.propose(scale(h), user("bob")), "conflict");
  });

  it("refuses an already-approved scale after its enabling autoscaler transfer is revoked, without claiming or issuing a grant", async () => {
    const h = await makeHarness({ kind });
    await seedAutoscaledService(h);
    const enabling = await proposeOk(h, scale(h, { requestOwnershipTransfer: true }), user("bob"));
    await approveAs(h, enabling.operation, "dave");
    const [transfer] = await repos.ownershipTransfers.listActive(h.db!, h.ids.wsA, h.ids.envAProd, ADDRESS);
    expect(transfer).toMatchObject({ from: "autoscaler", to: "native-op" });

    // Both proposals use the real store guard; no caller ownership context or policy override.
    const next = await proposeOk(h, scale(h), user("bob"));
    expect(next.operation.status).toBe("awaiting_approval");
    await approveAs(h, next.operation, "dave");
    expect((await h.store.getOperation(h.ids.wsA, next.id))?.status).toBe("approved");
    expect(await repos.ownershipTransfers.revoke(h.db!, {
      workspaceId: h.ids.wsA, transferDigest: transfer!.digest, operationId: enabling.id, revokedBy: "dave",
    })).toBe(true);

    const guard = await h.store.fieldOwnership!({
      workspaceId: h.ids.wsA, environmentId: h.ids.envAProd, resourceId: h.ids.resAWebProd,
    });
    expect(guard).toBeDefined();
    expect(guard!.lenientIacBaseline).toBe(true);
    expect(guard!.transfers).toEqual([]);
    expect(checkNativeOperation({
      capability: "service.scale", node: guard!.node, facts: guard!.facts, transfers: guard!.transfers, now: h.clock.now(),
    })).toMatchObject([{ verdict: "transfer_required", resolution: { owner: "autoscaler" } }]);
    const fresh = await expectBrokerError(h.broker.propose(scale(h), user("bob")), "conflict");
    expect(fresh.details).toMatchObject({ reason: "field_ownership_conflict", conflicts: [{ owner: "autoscaler" }] });

    const lease = await h.acquireLease(h.ids.envAProd);
    let outcome: "returned_grant" | "ownership_refused" | "other_error" = "other_error";
    try {
      await h.broker.beginExecution({
        workspaceId: h.ids.wsA, operationId: next.id, holder: "worker:ownership-regression", audience: "worker", lease,
      });
      outcome = "returned_grant";
    } catch (error) {
      if (isBrokerError(error) && error.code === "conflict" && error.details?.reason === "field_ownership_conflict") {
        outcome = "ownership_refused";
      }
    }
    // Only fixed labels/counts reach an assertion; a mistakenly returned bearer is never printed.
    const current = await h.store.getOperation(h.ids.wsA, next.id);
    const grants = await h.db!.query<{ count: number }>(
      "select count(*)::integer as count from platform.capability_grants where workspace_id=$1 and operation_id=$2",
      [h.ids.wsA, next.id],
    );
    const approvals = await h.store.listApprovals(h.ids.wsA, next.id);
    expect({ outcome, status: current?.status, grants: grants[0]!.count, consumedApprovals: approvals.filter(a => a.consumedAt).length })
      .toEqual({ outcome: "ownership_refused", status: "approved", grants: 0, consumedApprovals: 0 });
  });

  it("claims and issues a scale grant while the genuine approved autoscaler transfer remains active", async () => {
    const h = await makeHarness({ kind });
    await seedAutoscaledService(h);
    const enabling = await proposeOk(h, scale(h, { requestOwnershipTransfer: true }), user("bob"));
    await approveAs(h, enabling.operation, "dave");
    const next = await proposeOk(h, scale(h), user("bob"));
    await approveAs(h, next.operation, "dave");
    const lease = await h.acquireLease(h.ids.envAProd);
    const issued = await h.broker.beginExecution({ workspaceId: h.ids.wsA, operationId: next.id, holder: "worker:ownership-positive", audience: "worker", lease });
    expect(issued.claims.cap).toBe("service.scale");
    expect((await h.store.getOperation(h.ids.wsA, next.id))?.status).toBe("running");
    expect((await h.store.listApprovals(h.ids.wsA, next.id)).filter(row => row.consumedAt)).toHaveLength(1);
    expect((await h.db!.query<{ count: number }>("select count(*)::integer as count from platform.capability_grants where workspace_id=$1 and operation_id=$2", [h.ids.wsA, next.id]))[0]!.count).toBe(1);
  });

  it("refuses a finite expired transfer before claim and preserves its unconsumed approval", async () => {
    const h = await makeHarness({ kind });
    await seedAutoscaledService(h);
    // The production approval writer creates non-expiring receipts. This
    // finite original INSERT is an explicit SQL fixture tied to a real stored
    // human approval; it does not model a public expiry/configuration API.
    const seeded = await seedAwaitingApproval(h.db!, { workspaceId: h.ids.wsA, proposal: {
      capability: "service.scale", scope: { workspaceId: h.ids.wsA, projectId: h.ids.projA, environmentId: h.ids.envAProd, resourceId: h.ids.resAWebProd },
    } });
    const decision = await approve(h.db!, seeded, user("dave"));
    const request = transferRequest({ address: ADDRESS, resourceType: "aws:ecs_service", path: "replicas", from: "autoscaler", to: "native-op" });
    await h.db!.query(`insert into platform.ownership_transfers
      (id,workspace_id,project_id,environment_id,address,resource_type,field_path,from_owner,to_owner,transfer_digest,operation_id,approval_id,proposal_digest,approved_at,expires_at)
      select $1,o.workspace_id,o.project_id,o.environment_id,$2,$3,$4,$5,$6,$7,o.id,a.id,o.proposal_digest,a.created_at,clock_timestamp()-interval '1 second'
      from platform.operations o join platform.approvals a on a.workspace_id=o.workspace_id and a.operation_id=o.id
      where o.workspace_id=$8 and o.id=$9 and a.id=$10 and a.decision='approve' and a.approver->>'kind'='user' and a.proposal_digest=o.proposal_digest`,
      [uid("own"),request.address,request.resourceType,request.path,request.from,request.to,request.digest,h.ids.wsA,seeded.operation.id,decision.approval.id]);
    await expect(repos.operations.claimForExecution(h.db!, { workspaceId: h.ids.wsA, id: seeded.operation.id, expectedDigest: seeded.operation.proposalDigest, holder: "worker:expired-transfer" }))
      .rejects.toMatchObject({ code: "conflict", details: { reason: "field_ownership_conflict" } });
    expect((await h.store.getOperation(h.ids.wsA, seeded.operation.id))?.status).toBe("approved");
    expect((await h.store.listApprovals(h.ids.wsA, seeded.operation.id)).filter(row => row.consumedAt)).toHaveLength(0);
    expect(await h.db!.query("select jti from platform.capability_grants where workspace_id=$1 and operation_id=$2", [h.ids.wsA, seeded.operation.id])).toEqual([]);
  });

  it("does not insert or return a grant when the enabling transfer is revoked during real signing", async () => {
    const h = await makeHarness({ kind });
    await seedAutoscaledService(h);
    const enabling = await proposeOk(h, scale(h, { requestOwnershipTransfer: true }), user("bob"));
    await approveAs(h, enabling.operation, "dave");
    const [transfer] = await repos.ownershipTransfers.listActive(h.db!, h.ids.wsA, h.ids.envAProd, ADDRESS);
    const next = await proposeOk(h, scale(h), user("bob"));
    await approveAs(h, next.operation, "dave");
    const lease = await h.acquireLease(h.ids.envAProd);
    const sign = h.deps.signer.sign.bind(h.deps.signer);
    const spy = vi.spyOn(h.deps.signer, "sign").mockImplementation(async claims => {
      const signed = await sign(claims);
      expect(await repos.ownershipTransfers.revoke(h.db!, { workspaceId: h.ids.wsA, transferDigest: transfer!.digest, operationId: enabling.id, revokedBy: "dave" })).toBe(true);
      return signed;
    });
    try {
      await expectBrokerError(h.broker.beginExecution({ workspaceId: h.ids.wsA, operationId: next.id, holder: "worker:sign-wait", audience: "worker", lease }), "grant_issue_failed");
    } finally { spy.mockRestore(); }
    expect(await h.db!.query("select jti from platform.capability_grants where workspace_id=$1 and operation_id=$2", [h.ids.wsA, next.id])).toEqual([]);
    // The earlier claim occurred; the original failure path truthfully records
    // failure rather than pretending approvals or the claim were rolled back.
    expect((await h.store.getOperation(h.ids.wsA, next.id))?.status).toBe("failed");
    expect((await h.store.listApprovals(h.ids.wsA, next.id)).filter(row => row.consumedAt)).toHaveLength(1);
  });

  it("refuses a later worker mutation grant after revocation while retaining earlier grant history and read attenuation", async () => {
    const h = await makeHarness({ kind });
    await seedAutoscaledService(h);
    const enabling = await proposeOk(h, scale(h, { requestOwnershipTransfer: true }), user("bob"));
    await approveAs(h, enabling.operation, "dave");
    const [transfer] = await repos.ownershipTransfers.listActive(h.db!, h.ids.wsA, h.ids.envAProd, ADDRESS);
    const next = await proposeOk(h, scale(h), user("bob"));
    await approveAs(h, next.operation, "dave");
    const lease = await h.acquireLease(h.ids.envAProd);
    const earlier = await h.broker.beginExecution({ workspaceId: h.ids.wsA, operationId: next.id, holder: "worker:later-grant", audience: "worker", lease });
    expect(await repos.ownershipTransfers.revoke(h.db!, { workspaceId: h.ids.wsA, transferDigest: transfer!.digest, operationId: enabling.id, revokedBy: "dave" })).toBe(true);
    const worker = createExecutionBroker(h.db!, async () => h.broker);
    await expect(worker.issueGrant(next.id, "worker", lease)).rejects.toMatchObject({ code: "conflict", details: { reason: "field_ownership_conflict" } });
    await expect(h.store.insertGrant({ jti: uid("bypass"), workspaceId: h.ids.wsA, operationId: next.id, capability: "service.restart", audience: "worker", issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now()+60_000).toISOString() }))
      .rejects.toMatchObject({ code: "conflict", details: { reason: "field_ownership_conflict" } });
    // The earlier grant's row is retained as history, but revoking the enabling transfer
    // revokes it (migration 59): the autoscaler owns replicas again, so it must not be used.
    expect((await repos.grants.get(h.db!, h.ids.wsA, earlier.claims.jti))?.revokedAt).toEqual(expect.any(String));
    expect((await h.db!.query<{ count: number }>("select count(*)::integer as count from platform.capability_grants where workspace_id=$1 and operation_id=$2", [h.ids.wsA, next.id]))[0]!.count).toBe(1);
    const read = await worker.issueGrant(next.id, "worker", lease, { capability: "infrastructure.observe" });
    expect(read.claims.cap).toBe("infrastructure.observe");
    expect((await h.store.getOperation(h.ids.wsA, next.id))?.status).toBe("running");
  });

  it("rechecks ownership at later worker grant insertion after its real signer awaited revocation", async () => {
    const h = await makeHarness({ kind });
    await seedAutoscaledService(h);
    const enabling = await proposeOk(h, scale(h, { requestOwnershipTransfer: true }), user("bob"));
    await approveAs(h, enabling.operation, "dave");
    const [transfer] = await repos.ownershipTransfers.listActive(h.db!, h.ids.wsA, h.ids.envAProd, ADDRESS);
    const next = await proposeOk(h, scale(h), user("bob"));
    await approveAs(h, next.operation, "dave");
    const lease = await h.acquireLease(h.ids.envAProd);
    await h.broker.beginExecution({ workspaceId: h.ids.wsA, operationId: next.id, holder: "worker:worker-sign-wait", audience: "worker", lease });
    const worker = createExecutionBroker(h.db!, async () => h.broker);
    const sign = h.deps.signer.sign.bind(h.deps.signer);
    let revokedOnce = false;
    const spy = vi.spyOn(h.deps.signer, "sign").mockImplementation(async claims => {
      const signed = await sign(claims);
      // The existing product scope retries conflicts. Each genuine sign
      // still reaches native admission; one-way revoke succeeds only once.
      expect(await repos.ownershipTransfers.revoke(h.db!, { workspaceId: h.ids.wsA, transferDigest: transfer!.digest, operationId: enabling.id, revokedBy: "dave" })).toBe(!revokedOnce);
      revokedOnce = true;
      return signed;
    });
    try {
      await expect(worker.issueGrant(next.id, "worker", lease)).rejects.toMatchObject({ code: "conflict", details: { reason: "field_ownership_conflict" } });
      expect(revokedOnce).toBe(true);
    } finally { spy.mockRestore(); }
    expect((await h.db!.query<{ count: number }>("select count(*)::integer as count from platform.capability_grants where workspace_id=$1 and operation_id=$2", [h.ids.wsA, next.id]))[0]!.count).toBe(1);
    expect((await h.store.getOperation(h.ids.wsA, next.id))?.status).toBe("running");
    expect((await h.store.listApprovals(h.ids.wsA, next.id)).filter(row => row.consumedAt)).toHaveLength(1);
  });

  it("retains an autoscaler-to-IaC warning dependency that expires during claim admission", async () => {
    const h = await makeHarness({ kind });
    await seedAutoscaledService(h);
    // A finite original receipt is explicitly modeled; the stored human
    // approval, current guard, DB clock, consumption and claim SQL are real.
    const seeded = await seedAwaitingApproval(h.db!, { workspaceId:h.ids.wsA,proposal:{
      capability:"service.scale",scope:{workspaceId:h.ids.wsA,projectId:h.ids.projA,environmentId:h.ids.envAProd,resourceId:h.ids.resAWebProd},
    } });
    const decision = await approve(h.db!,seeded,user("dave"));
    const request = transferRequest({address:ADDRESS,resourceType:"aws:ecs_service",path:"replicas",from:"autoscaler",to:"iac"});
    const transferId=uid("own");
    await h.db!.query(`insert into platform.ownership_transfers
      (id,workspace_id,project_id,environment_id,address,resource_type,field_path,from_owner,to_owner,transfer_digest,operation_id,approval_id,proposal_digest,approved_at,expires_at)
      select $1,o.workspace_id,o.project_id,o.environment_id,$2,$3,$4,$5,$6,$7,o.id,a.id,o.proposal_digest,a.created_at,clock_timestamp()+interval '1 second'
      from platform.operations o join platform.approvals a on a.workspace_id=o.workspace_id and a.operation_id=o.id
      where o.workspace_id=$8 and o.id=$9 and a.id=$10 and a.decision='approve' and a.approver->>'kind'='user' and a.proposal_digest=o.proposal_digest`,
      [transferId,request.address,request.resourceType,request.path,request.from,request.to,request.digest,h.ids.wsA,seeded.operation.id,decision.approval.id]);
    const guard=await h.store.fieldOwnership!({workspaceId:h.ids.wsA,environmentId:h.ids.envAProd,resourceId:h.ids.resAWebProd});
    expect(checkNativeOperation({capability:"service.scale",node:guard!.node,facts:guard!.facts,transfers:guard!.transfers,now:new Date()}))
      .toMatchObject([{verdict:"transfer_required",resolution:{owner:"iac",baseOwner:"autoscaler",source:"transfer"}}]);
    const warning=await proposeOk(h,scale(h),user("bob"));
    expect(warning.operation.proposal.details?.some(detail=>detail.startsWith("Ownership note"))).toBe(true);
    let waited=false;
    const delayed=(tx:Sql):Sql=>({
      async query<T>(text:string,params?:readonly unknown[]):Promise<T[]> {
        if (text.startsWith("update platform.approvals set consumed_at")) {
          waited=true;
          const deadline=Date.now()+5_000;
          for (;;) {
            const [clock]=await tx.query<{expired:boolean}>("select expires_at<=clock_timestamp() as expired from platform.ownership_transfers where workspace_id=$1 and id=$2",[h.ids.wsA,transferId]);
            if (clock?.expired) break;
            if (Date.now()>=deadline) throw new Error("Finite transfer expiry was not observed.");
            await new Promise(done=>setTimeout(done,10));
          }
        }
        return tx.query<T>(text,params);
      },
      tx:fn=>tx.tx(inner=>fn(delayed(inner))),
    });
    // This controlled wait does not fake rows or locks; native peer/coordinator
    // waits for both transfer destinations are separately authored below.
    const port:Sql={query:<T>(text:string,params?:readonly unknown[])=>h.db!.query<T>(text,params),tx:fn=>h.db!.tx(tx=>fn(delayed(tx)))};
    let outcome:"admitted"|"ownership_refused"|"other_error"="other_error";
    try {
      await repos.operations.claimForExecution(port,{workspaceId:h.ids.wsA,id:seeded.operation.id,expectedDigest:seeded.operation.proposalDigest,holder:"worker:warning-expiry"});
      outcome="admitted";
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code==="conflict") outcome="ownership_refused";
    }
    expect(waited).toBe(true);
    expect({outcome,status:(await h.store.getOperation(h.ids.wsA,seeded.operation.id))?.status,consumed:(await h.store.listApprovals(h.ids.wsA,seeded.operation.id)).filter(row=>row.consumedAt).length})
      .toEqual({outcome:"ownership_refused",status:"approved",consumed:0});
    expect(await h.db!.query("select jti from platform.capability_grants where workspace_id=$1 and operation_id=$2",[h.ids.wsA,seeded.operation.id])).toEqual([]);
  });

  it("records nothing when the proposal is rejected, and rows cannot be deleted or rewritten", async () => {
    const h = await makeHarness({ kind });
    await seedAutoscaledService(h);
    const op = await proposeOk(h, scale(h, { requestOwnershipTransfer: true }), user("bob"));
    await h.broker.reject({ workspaceId: h.ids.wsA, operationId: op.id, proposalDigest: op.digest, approver: user("dave"), session: { method: "browser_session", subject: "dave", verifiedAtMs: Date.now() } });
    expect(await repos.ownershipTransfers.listActive(h.db!, h.ids.wsA, h.ids.envAProd)).toEqual([]);

    const approved = await proposeOk(h, scale(h, { requestOwnershipTransfer: true, again: true }), user("bob"));
    await approveAs(h, approved.operation, "dave");
    await expect(h.db!.query("delete from platform.ownership_transfers where workspace_id = $1", [h.ids.wsA])).rejects.toThrow();
    await expect(h.db!.query("update platform.ownership_transfers set to_owner = 'iac' where workspace_id = $1", [h.ids.wsA])).rejects.toThrow();
  });

  it("lets a native scale on a manifest-only field proceed with an approver-visible warning", async () => {
    const h = await makeHarness({ kind });
    await h.db!.query(
      `insert into platform.resources (id, workspace_id, environment_id, address, kind, provider, native_type, ownership, spec_digest, spec)
       values ($1,$2,$3,'vm/a','container_service','aws','aws_instance','managed',$4,'{}'::jsonb)`,
      [h.ids.resAWebProd, h.ids.wsA, h.ids.envAProd, "b".repeat(64)]
    );
    const ok = await proposeOk(h, scale(h), user("bob"));
    expect(ok.operation.proposal.details?.some((d) => d.startsWith("Ownership note"))).toBe(true);
  });
});
