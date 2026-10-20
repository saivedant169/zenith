/** Real broker claims and single-use approvals; explicit modeled product commits and durable starts. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { argsFor, approve, denyDecision, ids, makeHarness, proposeDeploy, requireApproval, target, user } from "./support";

beforeEach(async () => {
  // Each case owns its admission bucket; defaults and within-case limits stay real.
  (await import("@/lib/ops/runtime")).setOpsRuntimeForTests(undefined);
});

describe("approved execution", () => {
  it("refuses awaiting approval without claiming or starting", async () => {
    const h = await makeHarness(() => requireApproval());
    const p = await proposeDeploy(h);
    expect((await h.invoke("zenith_execute_approved_operation", argsFor("zenith_execute_approved_operation", p.id, p.digest))).error?.code).toBe("approval_required");
    expect(h.beginExecution).not.toHaveBeenCalled(); expect(h.starts.deploy).toHaveLength(0);
  });
  it("refuses denied and mismatched digests", async () => {
    const h = await makeHarness();
    const p = await proposeDeploy(h);
    const original = h.getOperationDetail;
    const detail = await h.broker.getOperationDetail({ workspaceId: ids.ws, operationId: p.id, principal: h.principal.principal });
    detail.operation.status = "denied"; original.mockResolvedValue(detail);
    expect((await h.invoke("zenith_execute_approved_operation", argsFor("zenith_execute_approved_operation", p.id, p.digest))).error?.code).toBe("invalid_state");
    expect((await h.invoke("zenith_execute_approved_operation", argsFor("zenith_execute_approved_operation", p.id))).error?.code).toBe("digest_mismatch");
    expect(h.beginExecution).not.toHaveBeenCalled(); expect(h.starts.deploy).toHaveLength(0);
  });
  it("refuses an expired operation", async () => {
    const h = await makeHarness(); const p = await proposeDeploy(h); h.clock.advance(25 * 3600_000);
    const result = await h.invoke("zenith_execute_approved_operation", argsFor("zenith_execute_approved_operation", p.id, p.digest));
    expect(result.error?.code).toBe("operation_expired"); expect(h.starts.deploy).toHaveLength(0);
  });
  it("refuses plans, human proposals and another human's integration", async () => {
    const h = await makeHarness();
    const plan = await h.invoke("zenith_plan_change", argsFor("zenith_plan_change"));
    expect((await h.invoke("zenith_execute_approved_operation", argsFor("zenith_execute_approved_operation", plan.data.operationId as string, plan.data.proposalDigest as string))).error?.code).toBe("not_executable");
    h.world.integrations.set(`${ids.ws}|int-alice`, { subject: "alice", scopes: ["read", "write"], projectIds: [ids.project], environmentIds: [ids.env] });
    for (const principal of [user("alice"), { kind: "integration" as const, id: "int-alice", name: "agent", integrationId: "int-alice", onBehalfOf: "alice" }]) {
      const op = await h.broker.propose({ capability: "deployment.deploy", scope: target, input: { operation: "deploy", revisionId: ids.revision, build: false } }, principal);
      const result = await h.invoke("zenith_execute_approved_operation", argsFor("zenith_execute_approved_operation", op.operation.id, op.operation.proposalDigest));
      expect(result.error?.code).toBe("not_found");
    }
    expect(h.beginExecution).not.toHaveBeenCalled();
  });
  it("starts a policy-approved machine health read through the day-two workflow", async () => {
    const h = await makeHarness();
    const op = await h.broker.propose({ capability: "system.metrics", scope: { ...target, resourceId: ids.service }, input: {} }, h.principal.principal);
    expect(op.operation.status).toBe("approved");
    const result = await h.invoke("zenith_execute_approved_operation", argsFor("zenith_execute_approved_operation", op.operation.id, op.operation.proposalDigest));
    expect(result.ok).toBe(true); expect(h.beginExecution).toHaveBeenCalledTimes(1); expect(h.starts.dayTwo).toHaveLength(1);
  });
  it("an engine outage leaves approvals unconsumed", async () => {
    const h = await makeHarness(() => requireApproval()); const p = await proposeDeploy(h); await approve(h, p.id, p.digest);
    h.ports.workflows.available = vi.fn(async () => ({ available: false, reason: "Test engine down." }));
    const result = await h.invoke("zenith_execute_approved_operation", argsFor("zenith_execute_approved_operation", p.id, p.digest));
    expect(result.error?.code).toBe("execution_unavailable"); expect(h.beginExecution).not.toHaveBeenCalled();
    const detail = await h.broker.getOperationDetail({ workspaceId: ids.ws, operationId: p.id, principal: h.principal.principal });
    expect(detail.operation.status).toBe("approved"); expect(detail.approvals[0].consumed).toBe(false);
  });
  it("queued operations are claimed and consume approval before starting", async () => {
    const h = await makeHarness(() => requireApproval()); const p = await proposeDeploy(h); await approve(h, p.id, p.digest);
    const detail = await h.broker.getOperationDetail({ workspaceId: ids.ws, operationId: p.id, principal: h.principal.principal });
    // The facade's queued view is injected; the real store still has the
    // approved record, and verifies/consumes its real approval in the claim.
    detail.operation.status = "queued"; h.getOperationDetail.mockResolvedValue(detail);
    const result = await h.invoke("zenith_execute_approved_operation", argsFor("zenith_execute_approved_operation", p.id, p.digest));
    expect(result.ok).toBe(true); expect(h.beginExecution).toHaveBeenCalledTimes(1);
    expect((await h.store.listApprovals(ids.ws, p.id))[0].consumedAt).toBeDefined();
    expect(h.trace.indexOf("beginExecution")).toBeLessThan(h.trace.indexOf("startDeploy"));
  });
  it("expired approvals cannot authorize execution", async () => {
    const h = await makeHarness(() => requireApproval()); const p = await proposeDeploy(h); await approve(h, p.id, p.digest); h.clock.advance(61 * 60_000);
    const result = await h.invoke("zenith_execute_approved_operation", argsFor("zenith_execute_approved_operation", p.id, p.digest));
    expect(result.error?.code).toBe("approval_required"); expect(h.starts.deploy).toHaveLength(0);
    expect((await h.store.listApprovals(ids.ws, p.id))[0].consumedAt).toBeUndefined();
  });
  it("an expired ledger status has the operation_expired code", async () => {
    const h = await makeHarness(); const p = await proposeDeploy(h); h.clock.advance(25 * 3600_000); await h.store.expireOperation({ workspaceId: ids.ws, id: p.id });
    expect((await h.invoke("zenith_execute_approved_operation", argsFor("zenith_execute_approved_operation", p.id, p.digest))).error?.code).toBe("operation_expired");
    expect(h.beginExecution).not.toHaveBeenCalled();
  });
  it("a malformed deployment proposal does not burn an approval", async () => {
    const h = await makeHarness();
    const op = await h.broker.propose({ capability: "deployment.deploy", scope: target, input: { operation: "deploy" } }, h.principal.principal);
    const result = await h.invoke("zenith_execute_approved_operation", argsFor("zenith_execute_approved_operation", op.operation.id, op.operation.proposalDigest));
    expect(result.error?.code).toBe("operation_input_invalid"); expect(h.beginExecution).not.toHaveBeenCalled();
  });
  it("claims with native workflow custody, consumes once and recovers only its retained intent", async () => {
    const h = await makeHarness(() => requireApproval()); const p = await proposeDeploy(h); await approve(h, p.id, p.digest);
    const args = argsFor("zenith_execute_approved_operation", p.id, p.digest);
    const first = await h.invoke("zenith_execute_approved_operation", args);
    const second = await h.invoke("zenith_execute_approved_operation", args);
    expect(first.ok).toBe(true); expect(second.ok).toBe(true);
    expect(first.data.workflow).toEqual(second.data.workflow);
    expect(first.data.startedNow).toBe(true); expect(second.data.startedNow).toBe(false);
    expect(h.trace.indexOf("beginExecution")).toBeLessThan(h.trace.indexOf("startDeploy"));
    expect(h.beginExecution).toHaveBeenCalledExactlyOnceWith({ workspaceId: ids.ws, operationId: p.id, holder: `workflow:${p.id}`, audience: "worker", leaseMs: 5 * 60_000 });
    expect(h.starts.deploy).toHaveLength(1); expect(h.ports.workflows.startDeploy).toHaveBeenCalledTimes(2);
    const claim = await h.beginExecution.mock.results[0].value;
    expect(JSON.stringify([first, second, h.starts.deploy])).not.toContain(claim.grant);
    expect((await h.store.listApprovals(ids.ws, p.id))[0].consumedAt).toBeDefined();
    expect(h.starts.deploy[0]).toMatchObject({ deploymentId: [...h.deployments.keys()][0], preApproved: true, connectionId: "conn-a" });
  });
  it("concurrent execute requests produce one claim and one effective workflow", async () => {
    const h = await makeHarness(() => requireApproval()); const p = await proposeDeploy(h); await approve(h, p.id, p.digest);
    const args = argsFor("zenith_execute_approved_operation", p.id, p.digest), start = h.ports.workflows.startDeploy;
    let entered!: () => void, release!: () => void;
    const held = new Promise<void>(resolve => { entered = resolve; }), resume = new Promise<void>(resolve => { release = resolve; });
    h.ports.workflows.startDeploy = vi.fn(async (...input: Parameters<typeof start>) => {
      // The native broker has claimed, but this modeled durable port has not
      // committed an intent yet. Recovery must not reconstruct that gap.
      if (input[1] === "new") { entered(); await resume; }
      return start(...input);
    });
    const winner = h.invoke("zenith_execute_approved_operation", args);
    let consumed: string | undefined;
    try {
      await Promise.race([held, winner.then(() => { throw new Error("Execution completed without the held pre-intent winner."); })]);
      consumed = (await h.store.listApprovals(ids.ws, p.id))[0].consumedAt; expect(consumed).toBeDefined();
      const losers = await Promise.all(Array.from({ length: 3 }, () => h.invoke("zenith_execute_approved_operation", args)));
      expect(losers.every(result => !result.ok && result.error?.code === "workflow_start_unconfirmed")).toBe(true);
      expect(h.workflowIntents.size).toBe(0); expect(h.starts.deploy).toHaveLength(0); expect(h.beginExecution).toHaveBeenCalledTimes(1);
    } finally { release(); await winner; }
    const first = await winner; expect(first.ok).toBe(true); expect(first.data.startedNow).toBe(true);
    const recovered = await h.invoke("zenith_execute_approved_operation", args);
    expect(recovered.ok).toBe(true); expect(recovered.data.startedNow).toBe(false); expect(recovered.data.workflow).toEqual(first.data.workflow);
    expect(h.workflowIntents.size).toBe(1); expect(h.workflowIntents.get(p.id)?.phase).toBe("acknowledged"); expect(h.workflowRefs.size).toBe(1);
    expect(h.beginExecution).toHaveBeenCalledTimes(1); expect(h.starts.deploy).toHaveLength(1);
    const approvals = await h.store.listApprovals(ids.ws, p.id); expect(approvals).toHaveLength(1); expect(approvals[0].consumedAt).toBe(consumed);
    expect(h.store.allEvents().filter((e) => e.type === "operation.started")).toHaveLength(1);
  });
  it("a lost claim without retained intent refuses recovery instead of inventing a start", async () => {
    const h = await makeHarness(); const p = await proposeDeploy(h), start = h.ports.workflows.startDeploy;
    h.ports.workflows.startDeploy = vi.fn().mockRejectedValueOnce(new Error("Modeled interruption before intent commit"));
    const args = argsFor("zenith_execute_approved_operation", p.id, p.digest);
    expect((await h.invoke("zenith_execute_approved_operation", args)).error?.code).toBe("workflow_start_unconfirmed");
    h.ports.workflows.startDeploy = start;
    expect((await h.invoke("zenith_execute_approved_operation", args)).error?.code).toBe("workflow_start_unconfirmed");
    expect(h.workflowIntents.size).toBe(0); expect(h.starts.deploy).toHaveLength(0); expect(h.beginExecution).toHaveBeenCalledTimes(1);
  });
  it("a lost start response recovers the same retained execution without a second modeled send", async () => {
    const h = await makeHarness(); const p = await proposeDeploy(h), start = h.ports.workflows.startDeploy;
    h.ports.workflows.startDeploy = vi.fn(async (input, mode) => { await start(input, mode); throw new Error("Modeled post-start ACK loss"); });
    const args = argsFor("zenith_execute_approved_operation", p.id, p.digest);
    expect((await h.invoke("zenith_execute_approved_operation", args)).error?.code).toBe("workflow_start_unconfirmed");
    h.ports.workflows.startDeploy = start;
    expect((await h.invoke("zenith_execute_approved_operation", args)).ok).toBe(true);
    expect(h.starts.deploy).toHaveLength(1); expect(h.beginExecution).toHaveBeenCalledTimes(1);
    expect(h.workflowIntents.get(p.id)?.phase).toBe("acknowledged");
  });
  it.each(["zenith_restart_service", "zenith_scale_service"] as const)("%s starts day-two work only when executed", async (name) => {
    const h = await makeHarness(); const proposal = await h.invoke(name, argsFor(name));
    expect(h.starts.dayTwo).toHaveLength(0);
    const result = await h.invoke("zenith_execute_approved_operation", argsFor("zenith_execute_approved_operation", proposal.data.operationId as string, proposal.data.proposalDigest as string));
    expect(result.ok).toBe(true); expect(h.starts.dayTwo).toHaveLength(1); expect(h.starts.deploy).toHaveLength(0);
  });
  it("rechecks changed policy before claiming", async () => {
    const h = await makeHarness(); const p = await proposeDeploy(h); h.setDecision(denyDecision);
    const result = await h.invoke("zenith_execute_approved_operation", argsFor("zenith_execute_approved_operation", p.id, p.digest));
    expect(result.error?.code).toBe("policy_denied"); expect(h.starts.deploy).toHaveLength(0);
  });
  it.each(["manifest", "environment", "connection", "missing association"])("current %s mismatch refuses before claiming", async change => {
    const h = await makeHarness(), p = await proposeDeploy(h);
    if (change === "manifest") h.revisions.get(ids.revision)!.manifest.services[0].replicas += 1;
    if (change === "environment") h.environments.get(ids.env)!.region = "us-west-2";
    if (change === "connection") h.environments.get(ids.env)!.connectionId = "other-connection";
    if (change === "missing association") h.deployments.clear();
    const result = await h.invoke("zenith_execute_approved_operation", argsFor("zenith_execute_approved_operation", p.id, p.digest));
    expect(result.ok).toBe(false); expect(h.beginExecution).not.toHaveBeenCalled(); expect(h.starts.deploy).toHaveLength(0);
  });
  it("a source change during the awaited native claim refuses dispatch after the claim", async () => {
    const h = await makeHarness(), p = await proposeDeploy(h), claim = h.beginExecution.getMockImplementation()!;
    h.beginExecution.mockImplementation(async (...args) => {
      const result = await claim(...args); h.revisions.get(ids.revision)!.manifest.services[0].replicas += 1; return result;
    });
    const result = await h.invoke("zenith_execute_approved_operation", argsFor("zenith_execute_approved_operation", p.id, p.digest));
    expect(result.error?.code).toBe("deployment_source_changed"); expect(h.beginExecution).toHaveBeenCalledTimes(1);
    expect(h.starts.deploy).toHaveLength(0); expect(h.workflowIntents.size).toBe(0);
  });
  it("an approved legacy deploy input never invents a synthetic deployment identity", async () => {
    const h = await makeHarness();
    const native = await h.broker.propose({ capability: "deployment.deploy", scope: target,
      input: { operation: "deploy", revisionId: ids.revision, build: false } }, h.principal.principal);
    const result = await h.invoke("zenith_execute_approved_operation", argsFor("zenith_execute_approved_operation", native.operation.id, native.operation.proposalDigest));
    expect(result.error?.code).toBe("operation_input_invalid"); expect(h.beginExecution).not.toHaveBeenCalled(); expect(h.deployments.size).toBe(0);
  });
  it.each(["succeeded", "failed", "uncertain"] as const)("a terminal %s retry never starts again", async (status) => {
    const h = await makeHarness(); const p = await proposeDeploy(h);
    await h.broker.beginExecution({ workspaceId: ids.ws, operationId: p.id, holder: "worker", audience: "worker" });
    await h.broker.completeExecution({ workspaceId: ids.ws, operationId: p.id, outcome: status });
    h.beginExecution.mockClear();
    const result = await h.invoke("zenith_execute_approved_operation", argsFor("zenith_execute_approved_operation", p.id, p.digest));
    expect(result.data).toMatchObject({ status, startedNow: false }); expect(result.data).not.toHaveProperty("workflow");
    expect(h.beginExecution).not.toHaveBeenCalled(); expect(h.starts.deploy).toHaveLength(0);
  });
});
