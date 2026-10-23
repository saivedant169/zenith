/**
 * executeCapability — a day-two (or remediation) capability run natively.
 *
 * The operation names a catalog capability (`service.restart`, `service.scale`,
 * `database.snapshot`, …) and a target resource. This activity finds that
 * resource in the platform store, routes machine capabilities through the machine
 * plane and otherwise finds the driver operation registered under the
 * capability's name (`ResourceDriver.operations[capability]`) and runs it inside a
 * brokered session — deploy role for a mutating capability, observe role for a
 * read-only one — with the operation's own grant, the environment lease's fence in
 * the driver context, heartbeats and lease renewal.
 *
 * Refusals that happen BEFORE anything is touched are clean failures
 * (`StepFailedError`): unknown capability, no target, a target outside this
 * environment, a mutation aimed at a resource Zenith does not manage (referenced
 * and external resources are read, never changed), no driver or no such
 * operation. Once the driver operation starts, an exception is left plain: the
 * workflow finalizes `uncertain` because the call may have acted.
 *
 * The driver's result is bounded and recorded as evidence; `ok: false` is
 * returned, not thrown — the workflow turns it into a failed step. Machine grant
 * constraints are enforced by executeMachineOperation. For driver operations,
 * `constraints` (policy "restrict") are NOT enforced here: `NativeOperation`
 * receives only the operation's own input, so a constraint the driver does not
 * already apply is not applied. Stated as a limit, not hidden.
 */
import { capability as lookupCapability, isCapability } from "@/lib/capabilities/catalog";
import { digest } from "@/lib/controlplane/digest";
import type { NativeOperation } from "@/lib/drivers/types";
import type { PortableKind, ProviderKey, ResourceNode } from "@/lib/resources/types";
import type { ExecutionActivities } from "@/lib/workflows/types";
import { ApplicationFailure } from "@temporalio/activity";
import { MACHINE_OPERATIONS, createMachineDrivers, createMachineSessionProvider, executeMachineOperation, readMachineHealth, machineHealthTelemetry, MACHINE_HEALTH_OPERATIONS, MachineOperationError, DEFAULT_TIMEOUT_SEC, DEFAULT_MAX_OUTPUT_BYTES, parseAzureVmTargetId, parseGcpInstanceTargetId, type MachineOperation, type MachineTarget } from "@/lib/machines";
import { loadExecContext, resolveConnection, type ExecContext } from "./context";
import { assertLeaseFor } from "./desired";
import { StepFailedError } from "./errors";
import { withKeepAlive } from "./keepalive";
import type { StoredResource } from "./ports";
import type { Runtime } from "./runtime";
import { driverContext, purposeOf, withProviderSession } from "./session";
import { executePortabilityCapability, isPortabilityCapability } from "./portability";
import { safeText } from "./text";
import type { LeaseRef } from "@/lib/workflows/types";

const MAX_DATA_BYTES = 4_000;

const isMachineCapability = (name: string): name is MachineOperation => (MACHINE_OPERATIONS as readonly string[]).includes(name);

/** A bound machine that exists but cannot be used; health reads label it instead of failing silently. */
class UnavailableMachine extends StepFailedError {
  constructor(readonly target: MachineTarget, readonly healthCode: "denied" | "target_unreachable", reason: string) { super(reason); }
}

/** Resolve only registered bindings or observed ids; a missing identity stays unknown. */
async function machineTarget(rt: Runtime, ec: ExecContext, row: StoredResource): Promise<MachineTarget> {
  const plane = rt.d.machines!;
  const base = { workspaceId: ec.workspaceId, environmentId: ec.environmentId, resourceId: row.id, address: row.address };
  const machine = await plane.boundMachine(ec.workspaceId, ec.environmentId, row.address);
  if (machine) {
    if (machine.kind !== "machine" || machine.workspaceId !== ec.workspaceId || machine.environmentId !== ec.environmentId || machine.address !== row.address) {
      throw new StepFailedError("The bound machine is unavailable or does not belong to this resource.");
    }
    if (machine.status !== "active" || machine.stale) {
      const target: MachineTarget = { ...base, transport: "zenithd", targetId: machine.id };
      throw machine.status === "revoked"
        ? new UnavailableMachine(target, "denied", "The bound machine is revoked; the machine plane refused the request.")
        : new UnavailableMachine(target, "target_unreachable", "The bound machine is unavailable (inactive or silent); nothing was dispatched.");
    }
    return { ...base, transport: "zenithd", targetId: machine.id };
  }
  const observation = await plane.latestObservation(ec.workspaceId, row.id);
  if (!observation || observation.address !== row.address || observation.presence !== "present" || (observation.simulated && ec.product.environment.class !== "sandbox")) {
    throw new StepFailedError("The target has no present observation; its machine identity is unknown.");
  }
  if (row.provider === "aws" && ["aws:ec2_instance", "ec2_instance"].includes(row.nativeType) && /^(i|mi)-[a-f0-9]{8,17}$/.test(observation.externalId ?? "")) {
    return { ...base, transport: "aws_ssm", targetId: observation.externalId! };
  }
  if (row.provider === "azure" && ["azure:virtual_machine", "virtual_machine"].includes(row.nativeType) && parseAzureVmTargetId(observation.externalId ?? "")) {
    return { ...base, transport: "azure_run_command", targetId: observation.externalId! };
  }
  if (row.provider === "gcp" && ["gcp:compute_instance", "compute_instance"].includes(row.nativeType)) {
    const id = parseGcpInstanceTargetId(observation.externalId ?? "");
    if (id) return { ...base, transport: "gcp_os_management", targetId: id.path };
  }
  if (row.provider === "kubernetes") {
    // Only a Pod can be addressed for pod operations. A namespace can be
    // addressed for container.list; deployments are never guessed into pods.
    const id = observation.externalId;
    const podType = ["k8s:Pod", "Pod", "pod"].includes(row.nativeType);
    const namespaceType = ["k8s:Namespace", "Namespace", "namespace"].includes(row.nativeType);
    if (id && ((podType && /^[a-z0-9][a-z0-9-]{0,62}\/[a-z0-9][a-z0-9.-]{0,252}$/.test(id)) || (namespaceType && /^[a-z0-9][a-z0-9-]{0,62}$/.test(id)))) {
      return { ...base, transport: "kubernetes", targetId: id };
    }
  }
  throw new StepFailedError("No supported machine transport can resolve the observed resource identity.");
}

async function executeMachineCapability(rt: Runtime, ec: ExecContext, row: StoredResource, name: MachineOperation, lease: LeaseRef): Promise<{ ok: boolean; summary: string }> {
  const plane = rt.d.machines;
  if (!plane) throw new StepFailedError("This worker has no machine plane configured.");
  let target: MachineTarget;
  try { target = await machineTarget(rt, ec, row); }
  catch (error) {
    // PROD-OBS-02: a health read of a revoked or silent bound machine is an explicit inaccessible/unknown answer.
    if (error instanceof UnavailableMachine && MACHINE_HEALTH_OPERATIONS.has(name)) {
      const telemetry = machineHealthTelemetry({ target: error.target, observedAt: rt.now().toISOString(), error: { code: error.healthCode, message: error.message } });
      try {
        await rt.evidence(ec.scope, { kind: "observation", digest: digest({ op: ec.op.id, capability: name, address: row.address, state: telemetry.state }), summary: { kind: "machine_health", capability: name, address: row.address, telemetry }, simulated: false, key: `machine-health:${ec.op.id}` }, { critical: false });
      } catch {
        rt.log("warn", "machine health telemetry evidence could not be stored", { operationId: ec.op.id });
      }
    }
    throw error;
  }
  const connection = target.transport === "zenithd" ? undefined : await resolveConnection(rt, ec);
  const { claims, jws } = await rt.d.broker.issueGrant(ec.op.id, target.transport === "zenithd" ? `machine:${target.targetId}` : "worker", { scope: lease.scope, fenceToken: lease.fenceToken });
  const mutates = lookupCapability(name).mutates;
  const input = ec.op.proposal.input;
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new StepFailedError("Machine operation input must be an argument object.");
  const args = input as Record<string, unknown>;
  await rt.d.leases.assertFence(lease.scope, lease.fenceToken);
  if (mutates) await rt.emit(ec.scope, "resource.applying", `capability:${ec.op.id}`, { capability: name, address: row.address });
  try {
    // Read-only health operations go through readMachineHealth (same authority path) so every answer carries a scoped telemetry envelope (PROD-OBS-02).
    const healthRead = MACHINE_HEALTH_OPERATIONS.has(name);
    const request = { operationId: ec.op.id, operation: name, target, args, timeoutSec: typeof args.timeoutSec === "number" ? args.timeoutSec : DEFAULT_TIMEOUT_SEC, maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES };
    const result = await withKeepAlive(rt, { lease, detail: `execute ${name}`, operation: { workspaceId: ec.workspaceId, operationId: ec.op.id } }, async (signal) => {
      const exec = {
        grant: claims,
        drivers: plane.drivers ?? createMachineDrivers({ sandbox: ec.product.environment.class === "sandbox", dispatcher: plane.dispatcher }),
        sessions: createMachineSessionProvider({ credentials: rt.d.credentials, grantJws: jws, connection, kubernetes: plane.kubernetes, sandbox: ec.product.environment.class === "sandbox", signal, now: rt.now }),
        evidence: plane.evidence, signal, now: rt.now,
      };
      if (!healthRead) return executeMachineOperation(request, exec);
      const read = await readMachineHealth(request, exec);
      // The envelope names scope, transport, time and freshness; it carries no machine output.
      // A telemetry record is additive: failing to store it must not change the health answer or re-run the read.
      try {
        await rt.evidence(ec.scope, { kind: "observation", digest: digest({ op: ec.op.id, capability: name, address: row.address, state: read.telemetry.state }), summary: { kind: "machine_health", capability: name, address: row.address, telemetry: read.telemetry }, simulated: read.result?.simulated ?? false, key: `machine-health:${ec.op.id}` }, { critical: false });
      } catch {
        rt.log("warn", "machine health telemetry evidence could not be stored", { operationId: ec.op.id });
      }
      if (read.error) throw new MachineOperationError(read.error.code as ConstructorParameters<typeof MachineOperationError>[0], read.error.message);
      return read.result!;
    });
    await rt.d.leases.assertFence(lease.scope, lease.fenceToken);
    if (result.ok && mutates) await rt.emit(ec.scope, "resource.applied", `capability:${ec.op.id}`, { capability: name, address: row.address });
    // No machine data (contents, logs, DNS answers) travels into workflow history.
    return { ok: result.ok, summary: `${name} ${result.ok ? "succeeded" : "failed"}${result.simulated ? " (simulated)" : ""}` };
  } catch (err) {
    if (!(err instanceof MachineOperationError)) throw err;
    if (err.code === "uncertain" || err.code === "evidence_failed" || (mutates && ["transport_error", "aborted", "protocol_violation"].includes(err.code))) {
      try {
        await rt.d.ops.markUncertain({ workspaceId: ec.workspaceId, operationId: ec.op.id, reason: "The machine request's outcome cannot be proven; reconcile must observe it." });
      } catch {
        // A ledger outage must never turn uncertainty into a retryable dispatch.
        rt.log("error", "could not persist machine uncertainty", { operationId: ec.op.id });
      }
      throw ApplicationFailure.create({ message: "The machine request's outcome is uncertain; it must never be re-dispatched.", type: "MachineUncertain", nonRetryable: true });
    }
    throw new StepFailedError(`Machine operation refused (${err.code}).`);
  }
}

export function nodeFromStored(row: StoredResource, fallbackRegion: string): ResourceNode {
  return {
    address: row.address,
    kind: row.kind as PortableKind | "provider_native",
    provider: row.provider as ProviderKey,
    region: row.region ?? fallbackRegion,
    nativeType: row.nativeType,
    ownership: row.ownership,
    ...(row.externalId ? { externalRef: row.externalId } : {}),
    spec: row.spec,
    origin: row.origin,
    dependsOn: row.dependsOn,
    specDigest: row.specDigest,
    labels: row.labels,
  };
}

const boundedData = (data: Record<string, unknown> | undefined): { data?: Record<string, unknown>; dataTruncated?: true } => {
  if (!data) return {};
  const text = JSON.stringify(data);
  return text.length <= MAX_DATA_BYTES ? { data } : { dataTruncated: true };
};

export function createCapabilityActivities(rt: Runtime): Pick<ExecutionActivities, "executeCapability"> {
  return {
    async executeCapability({ operationId, lease }) {
      const ec = await loadExecContext(rt, operationId);
      assertLeaseFor(ec, lease);
      const name = ec.op.capability;
      if (!isCapability(name)) throw new StepFailedError(`"${safeText(name, 60)}" is not a capability this worker can execute.`);
      const def = lookupCapability(name);
      if (!ec.op.resourceId) throw new StepFailedError(`${name} names no target resource.`);

      const row = await rt.d.resources.get(ec.workspaceId, ec.op.resourceId);
      if (!row || row.workspaceId !== ec.workspaceId || row.environmentId !== ec.environmentId) throw new StepFailedError("The target resource was not found in this environment.");
      const node = nodeFromStored(row, ec.product.environment.region);
      // Portability capabilities carry their own ownership rules (export reads referenced services, adopt needs one): see ./portability.
      if (isPortabilityCapability(name)) return executePortabilityCapability(rt, ec, row, node, name, lease);
      if (def.mutates && node.ownership !== "managed") {
        throw new StepFailedError(`${node.address} is ${node.ownership}: Zenith reads it and never changes it, so ${name} cannot run on it.`);
      }
      if (isMachineCapability(name)) return executeMachineCapability(rt, ec, row, name, lease);
      const driver = rt.drivers(node.provider, node.nativeType);
      const operation: NativeOperation | undefined = driver?.operations?.[name];
      if (!driver || !operation) throw new StepFailedError(`No driver operation "${name}" exists for ${node.provider} ${node.nativeType}, so ${node.address} cannot ${def.title.toLowerCase()} natively.`);
      const connection = await resolveConnection(rt, ec);
      const input = ec.op.proposal.input !== null && typeof ec.op.proposal.input === "object" && !Array.isArray(ec.op.proposal.input) ? { ...(ec.op.proposal.input as Record<string, unknown>) } : {};

      await rt.d.leases.assertFence(lease.scope, lease.fenceToken);
      // "resource.applying" doubles as the marker that a mutating call was about to start (used to tell a cancelled-before-acting operation from an uncertain one).
      if (def.mutates) await rt.emit(ec.scope, "resource.applying", `capability:${ec.op.id}`, { capability: name, address: node.address });

      const result = await withKeepAlive(rt, { lease, detail: `execute ${name}`, operation: { workspaceId: ec.workspaceId, operationId: ec.op.id } }, (signal) =>
        withProviderSession(rt, ec, { purpose: purposeOf(name), fence: lease, connection }, (session) =>
          operation(driverContext(rt, ec, session, signal, { node, fence: lease }), node, input)
        )
      );
      await rt.d.leases.assertFence(lease.scope, lease.fenceToken);

      const summary = safeText(result.summary, 300);
      const body = {
        kind: "capability",
        capability: name,
        address: node.address,
        driver: driver.id,
        ok: result.ok,
        summary,
        requestIds: (result.requestIds ?? []).slice(0, 20).map((r) => safeText(r, 80)),
        ...boundedData(result.data),
      };
      await rt.evidence(ec.scope, { kind: "observation", digest: digest({ op: ec.op.id, capability: name, address: node.address, ok: result.ok, requestIds: body.requestIds }), summary: body, simulated: result.simulated, key: `capability:${ec.op.id}` }, { critical: true });
      if (result.ok && def.mutates) await rt.emit(ec.scope, "resource.applied", `capability:${ec.op.id}`, { capability: name, address: node.address });
      return { ok: result.ok, summary };
    },
  };
}
