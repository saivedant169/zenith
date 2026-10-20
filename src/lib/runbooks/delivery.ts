/** Signed runbook -> canonical broker -> registered machine. No alternate execution authority. */
import { digest } from "@/lib/controlplane/digest";
import type { Broker } from "@/lib/capabilities/platform";
import type { PublicJwk } from "@/lib/credentials/signing/types";
import type { PlatformResource } from "@/lib/controlplane/db/repos/resources";
import type { PlatformMachine } from "@/lib/controlplane/db/repos/machines";
import { classifyRunbook, machineTargetFor, RunbookError } from "@/lib/machines/runbooks/definition";
import { evaluateRunbookGate } from "@/lib/machines/runbooks/policy";
import { stepOperationId, type RunbookStepContext, type StepGrant } from "@/lib/machines/runbooks/runner";
import type { RunbookStore } from "@/lib/machines/runbooks/ports";
import { verifyRunbookVersion } from "@/lib/machines/runbooks/signing";
import type { MachineRequest } from "@/lib/machines/types";
import { runbookProposalInput } from "./semantics";

export function createRunbookStepGrant(deps: {
  store: RunbookStore;
  broker: Broker;
  verificationKeys(): Promise<readonly PublicJwk[]>;
  machine(workspaceId: string, id: string): Promise<PlatformMachine | null>;
  resource(workspaceId: string, id: string): Promise<Pick<PlatformResource, "workspaceId" | "environmentId" | "address"> | null>;
  now?: () => Date;
}): (request: MachineRequest, context: RunbookStepContext) => Promise<StepGrant> {
  return async (req, ctx) => {
    const now = deps.now ?? (() => new Date());
    const ws = ctx.run.workspaceId;
    const current = async () => {
      ctx.signal.throwIfAborted();
      const run = await deps.store.getRun(ws, ctx.run.id);
      // The lease can be renewed while authorization is in progress; all other run fields stay bound.
      if (!run || run.status !== "running" || run.cancelRequestedAt || !Number.isFinite(Date.parse(run.deadlineAt)) || Date.parse(run.deadlineAt) <= now().getTime() || digest({ ...run, leaseUntil: null }) !== digest({ ...ctx.run, leaseUntil: null }))
        throw new RunbookError("invalid_binding", "The run is cancelled, expired or its immutable binding changed.");
      return run;
    };
    const run = await current();
    const version = await deps.store.getVersion(ws, run.runbookId, run.version);
    if (!version || version.definitionDigest !== run.definitionDigest) throw new RunbookError("signature_invalid", "The signed runbook version is unavailable.");
    const signed = await verifyRunbookVersion({ workspaceId: ws, runbookId: run.runbookId, version: run.version, definition: version.definition, signature: version.signature }, await deps.verificationKeys());
    if (signed.dig !== version.definitionDigest) throw new RunbookError("signature_invalid", "The stored definition digest differs from its signature.");
    const step = version.definition.steps.find(s => s.id === ctx.stepId);
    const target = run.targets[ctx.targetIndex];
    if (!step || !target || digest(req) !== digest({ operationId: stepOperationId(run.id, ctx.targetIndex, step.id), target: machineTargetFor(ws, target), operation: step.operation, args: step.args, timeoutSec: step.timeoutSec, maxOutputBytes: step.maxOutputBytes }))
      throw new RunbookError("invalid_binding", "The step differs from its signed definition or approved target.");
    const assertApproval = async () => {
      const approval = await deps.store.findValidApproval(ws, run.bindingDigest, now());
      if (evaluateRunbookGate({ classification: classifyRunbook(version.definition), approval, requestedBy: run.requestedBy, now: now() }).outcome !== "allow")
        throw new RunbookError("approval_required", "The run approval is no longer valid.");
    };
    await assertApproval();
    const machine = await deps.machine(ws, req.target.targetId);
    if (!machine || machine.workspaceId !== ws || machine.transport !== "zenithd" || machine.status !== "active" || machine.stale || !machine.capabilities.includes(req.operation))
      throw new RunbookError("invalid_binding", "The registered machine is unavailable for this step.");
    if (req.target.environmentId !== machine.environmentId) throw new RunbookError("invalid_binding", "The machine environment binding differs from the approved target.");
    const resource = await deps.resource(ws, req.target.resourceId!);
    if (!resource || resource.workspaceId !== ws || resource.environmentId !== machine.environmentId || resource.address !== machine.address)
      throw new RunbookError("invalid_binding", "The registered machine does not bind the approved resource.");
    const input = { ...runbookProposalInput(req.args, version), runbookStep: { runId: run.id, stepId: step.id, targetIndex: ctx.targetIndex, target: req.target, bindingDigest: run.bindingDigest } };
    const proposed = await deps.broker.propose({ capability: req.operation, scope: { workspaceId: ws, ...(req.target.environmentId ? { environmentId: req.target.environmentId } : {}), resourceId: req.target.resourceId }, input,
      constraints: { maxTimeoutSec: req.timeoutSec, maxOutputBytes: req.maxOutputBytes }, reason: `runbook ${run.runbookId} v${run.version}, run ${run.id}`.slice(0, 500), idempotencyKey: req.operationId }, run.requester, { via: "workflow" });
    const operationId = proposed.operation.id;
    const operation = await deps.broker.deps.store.getOperation(ws, operationId);
    if (!operation || digest(operation.proposal.input) !== digest(input)) throw new RunbookError("invalid_binding", "The broker proposal does not bind the exact signed step.");
    // A replay after a crash finds the step already approved by this same path.
    if (proposed.decision.outcome === "require_approval" && operation.status !== "approved") {
      // The independent run approval, bound to this exact signed step and target, is the step's human decision.
      const approval = await deps.store.findValidApproval(ws, run.bindingDigest, now());
      if (!approval || approval.requestedBy !== run.requestedBy) throw new RunbookError("approval_required", "The run approval is no longer valid.");
      const applied = await deps.broker.approveRunbookStep({ workspaceId: ws, operationId, approval, expectedInputDigest: digest(input) });
      if (applied.operation.status !== "approved") throw new RunbookError("approval_required", "The capability broker did not accept the run approval for this step.");
    } else if (proposed.decision.outcome !== "allow" && proposed.decision.outcome !== "require_approval") throw new RunbookError("approval_required", "The capability broker did not allow this step.");
    await current();
    await assertApproval();
    // Append the join before dispatch. An audit outage refuses delivery.
    await deps.store.appendAudit(ws, `run:${run.id}`, "run.step.authorized", "system:runbook-runner", { target: ctx.targetIndex, step: step.id, stepOperationId: req.operationId, operationId, runbook: version.runbookId, version: version.version, definitionDigest: version.definitionDigest, binding: run.bindingDigest }, now());
    await current();
    await assertApproval();
    const begun = await deps.broker.beginExecution({ workspaceId: ws, operationId, holder: `runbook:${run.id}`, audience: `machine:${machine.id}`, leaseMs: (req.timeoutSec + 30) * 1000 });
    return { claims: begun.claims, jws: begun.grant, async settle(outcome, detail) {
      if (outcome === "uncertain") await deps.broker.markUncertain({ workspaceId: ws, operationId, reason: "The machine request's outcome cannot be proven; reconcile must observe it." });
      else await deps.broker.completeExecution({ workspaceId: ws, operationId, outcome, ...(detail.code ? { error: detail.code } : {}) });
    } };
  };
}
