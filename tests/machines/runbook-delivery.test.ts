/** Contract join over memory and real SQL stores: signing/broker authority; controlled registry, no real agent. */
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createBroker } from "@/lib/capabilities/platform";
import { generateSigningJwk, LocalJwkSigner } from "@/lib/credentials/signing";
import { MemoryRunbookStore } from "@/lib/machines/runbooks/memory-store";
import { createPlatformRunbookStore } from "@/lib/controlplane/db/repos/machine-runbooks";
import type { PlatformMachine } from "@/lib/controlplane/db/repos/machines";
import { createRunbookService, stepOperationId, verifyAuditChain } from "@/lib/machines/runbooks";
import type { MachineRequest } from "@/lib/machines/types";
import { createRunbookStepGrant } from "@/lib/runbooks/delivery";
import { runbookProposalInput } from "@/lib/runbooks/semantics";
import { runbookOf } from "@/lib/execution/semantics/collect";
import { allowDecision, closeSharedPgliteAfterAll, makeHarness, requireApproval, scriptedEngine, sharedDatabase, STORE_KINDS, type StoreKind } from "../capabilities/support";
import type { PolicyDecision } from "@/lib/policy/types";

closeSharedPgliteAfterAll();
afterEach(() => vi.restoreAllMocks());

async function fixture(kind: StoreKind, decide: () => PolicyDecision = () => allowDecision()) {
  const h = await makeHarness({ kind, engine: scriptedEngine("runbook-contract", decide) });
  const broker = createBroker(h.deps);
  const store = kind === "memory" ? new MemoryRunbookStore() : createPlatformRunbookStore(h.db!);
  const key = await generateSigningJwk("EdDSA");
  const signer = LocalJwkSigner.fromJwk("runbook-contract", key.privateJwk, { alg: "EdDSA" });
  const now = () => h.deps.clock.now();
  const service = createRunbookService({ store, signer, verificationKeys: async () => [signer.publicJwk()], authorize: async () => true, now });
  const principal = { kind: "user" as const, id: "alice", name: "Alice" };
  const version = await service.publish({ workspaceId: h.ids.wsA, runbookId: "inspect", definition: { schemaVersion: 1, name: "Inspect", steps: [{ id: "inspect", title: "Inspect", operation: "machine.inspect", args: {} }] }, principal });
  const target = { transport: "zenithd" as const, targetId: "mach-contract", environmentId: h.ids.envASbx, resourceId: h.ids.resAWebSbx };
  const requested = await service.requestRun({ workspaceId: h.ids.wsA, runbookId: "inspect", targets: [target], maxRunDurationSec: 60, maxParallelTargets: 1, principal });
  const run = (await store.claimRun(h.ids.wsA, requested.id, now(), 120_000))!;
  const step = version.definition.steps[0];
  const req: MachineRequest = { operationId: stepOperationId(run.id, 0, step.id), target: { workspaceId: h.ids.wsA, ...target }, operation: step.operation, args: step.args, timeoutSec: step.timeoutSec, maxOutputBytes: step.maxOutputBytes };
  const ctx = { run, targetIndex: 0, stepId: step.id, signal: new AbortController().signal };
  const machine = { id: target.targetId, workspaceId: h.ids.wsA, environmentId: target.environmentId, address: "service/web", transport: "zenithd", status: "active", stale: false, capabilities: ["machine.inspect"] } as PlatformMachine;
  const lookup = vi.fn(async () => machine);
  const grant = createRunbookStepGrant({ store, broker, verificationKeys: async () => [signer.publicJwk()], machine: lookup, resource: async () => ({ workspaceId: h.ids.wsA, environmentId: target.environmentId, address: "service/web" }), now });
  return { h, broker, store, service, version, req, ctx, machine, lookup, grant };
}

describe.each(STORE_KINDS)("registered runbook step authority [%s]", kind => {
  // Admit the genuine schema in setup; cold migration work is not a step-authorization operation.
  beforeAll(async () => { if (kind !== "memory") await sharedDatabase(kind); }, 60_000);
  it("emits the signed reference and joins the broker operation into the append-only audit", async () => {
    const f = await fixture(kind);
    const grant = await f.grant(f.req, f.ctx);
    const op = (await f.broker.deps.store.getOperation(f.h.ids.wsA, grant.claims.op))!;
    expect(runbookOf(op.proposal.input)).toEqual({ runbookId: "inspect", version: 1, definitionDigest: f.version.definitionDigest });
    expect(op.proposal.input).toMatchObject({ runbookStep: { runId: f.ctx.run.id, target: f.req.target, bindingDigest: f.ctx.run.bindingDigest } });
    expect(grant.claims.aud).toBe(`machine:${f.machine.id}`);
    await grant.settle("succeeded", {});
    expect((await f.broker.deps.store.getOperation(f.h.ids.wsA, grant.claims.op))?.status).toBe("succeeded");
    const audit = await f.store.listAudit(f.h.ids.wsA, `run:${f.ctx.run.id}`);
    expect(verifyAuditChain(audit)).toBe(true);
    expect(audit.find(a => a.event === "run.step.authorized")?.detail).toMatchObject({ operationId: grant.claims.op, stepOperationId: f.req.operationId, definitionDigest: f.version.definitionDigest });
  });

  it("presents the independent run approval as the step's human decision when policy requires one", async () => {
    const f = await fixture(kind, () => requireApproval(1, "editor", true));
    const id = `rba_${randomUUID()}`;
    const approve = (approverId: string) => f.store.insertApproval({ id, workspaceId: f.h.ids.wsA, bindingDigest: f.ctx.run.bindingDigest,
      requestedBy: f.ctx.run.requestedBy, approverId, expiresAt: new Date(f.h.deps.clock.now().getTime() + 3_600_000).toISOString(), createdAt: f.h.deps.clock.now().toISOString() });
    await expect(f.grant(f.req, f.ctx)).rejects.toMatchObject({ code: "approval_required" });
    await approve("user:bob");
    const grant = await f.grant({ ...f.req }, f.ctx);
    const events = await f.broker.deps.store.listEvents(f.h.ids.wsA, { operationId: grant.claims.op });
    expect(events.find((e: any) => e.data?.kind === "runbook_approval_applied")?.data).toMatchObject({ runbookApprovalId: id, bindingDigest: f.ctx.run.bindingDigest });
    expect(events.find((e: any) => e.type === "operation.approved")).toBeTruthy();
  });

  it.each([
    ["a non-person", "integration:int-rw", () => requireApproval(1, "editor", true), "invalid_state"],
    ["one of several required approvers", "user:bob", () => requireApproval(2, "editor", false), "reapproval_required"],
    ["an under-privileged approver", "user:bob", () => requireApproval(1, "admin", false), "approver_role_insufficient"],
  ] as const)("refuses a run approval from %s for a step that needs a human decision", async (_label, approverId, decide, code) => {
    const f = await fixture(kind, decide);
    await f.store.insertApproval({ id: `rba_${randomUUID()}`, workspaceId: f.h.ids.wsA, bindingDigest: f.ctx.run.bindingDigest, requestedBy: f.ctx.run.requestedBy, approverId,
      expiresAt: new Date(f.h.deps.clock.now().getTime() + 3_600_000).toISOString(), createdAt: f.h.deps.clock.now().toISOString() });
    await expect(f.grant(f.req, f.ctx)).rejects.toMatchObject({ code });
  });

  it.each(["args", "target", "operationId", "timeout"] as const)("refuses changed %s before proposing or dispatching", async field => {
    const f = await fixture(kind);
    const propose = vi.spyOn(f.broker, "propose");
    const changed = { ...f.req, ...(field === "args" ? { args: { unexpected: true } } : field === "target" ? { target: { ...f.req.target, resourceId: f.h.ids.resBWeb } } : field === "operationId" ? { operationId: "foreign-step" } : { timeoutSec: f.req.timeoutSec + 1 }) };
    await expect(f.grant(changed, f.ctx)).rejects.toMatchObject({ code: "invalid_binding" });
    expect(propose).not.toHaveBeenCalled();
  });

  it.each(["revoked", "stale", "foreign", "environment", "capability"] as const)("refuses a %s machine", async state => {
    const f = await fixture(kind);
    Object.assign(f.machine, state === "revoked" ? { status: "revoked" } : state === "stale" ? { stale: true } : state === "foreign" ? { workspaceId: f.h.ids.wsB } : state === "environment" ? { environmentId: f.h.ids.envBProd } : { capabilities: [] });
    await expect(f.grant(f.req, f.ctx)).rejects.toMatchObject({ code: "invalid_binding" });
  });

  it("rechecks cancellation after asynchronous broker policy work", async () => {
    const f = await fixture(kind);
    const original = f.broker.propose.bind(f.broker);
    vi.spyOn(f.broker, "propose").mockImplementation(async (...args) => {
      const proposed = await original(...args);
      await f.service.cancelRun({ workspaceId: f.h.ids.wsA, runId: f.ctx.run.id, principal: f.ctx.run.requester, reason: "stop" });
      return proposed;
    });
    const begin = vi.spyOn(f.broker, "beginExecution");
    await expect(f.grant(f.req, f.ctx)).rejects.toMatchObject({ code: "invalid_binding" });
    expect(begin).not.toHaveBeenCalled();
  });

  it("an audit outage refuses delivery before grant consumption", async () => {
    const f = await fixture(kind);
    vi.spyOn(f.store, "appendAudit").mockRejectedValue(new Error("controlled outage"));
    const begin = vi.spyOn(f.broker, "beginExecution");
    await expect(f.grant(f.req, f.ctx)).rejects.toThrow("controlled outage");
    expect(begin).not.toHaveBeenCalled();
  });

  it("re-verifies the signed definition before every step", async () => {
    const f = await fixture(kind);
    vi.spyOn(f.store, "getVersion").mockResolvedValue({ ...f.version, definition: { ...f.version.definition, name: "changed" } });
    await expect(f.grant(f.req, f.ctx)).rejects.toMatchObject({ code: "signature_invalid" });
  });

  it("caller arguments cannot replace the emitted reference; changing the version changes semantics", () => {
    const version = { runbookId: "inspect", version: 1, definitionDigest: "a".repeat(64) };
    expect(runbookOf(runbookProposalInput({ runbook: { runbookId: "forged" } }, version))).toEqual(version);
    expect(runbookOf(runbookProposalInput({}, { ...version, version: 2 }))).not.toEqual(version);
  });
});
