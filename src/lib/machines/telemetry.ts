/**
 * Machine health as scoped telemetry (PROD-OBS-02).
 *
 * `readMachineHealth` runs a read-only machine operation through the normal
 * `executeMachineOperation` authority path (grant, constraints, evidence) and
 * returns the result together with a `TelemetryEnvelope` that says which
 * transport answered, for which scope, when, and whether the answer is fresh,
 * unknown (the box could not be read) or inaccessible (the grant/session
 * refused). A refusal is a labeled result, never a silent gap and never
 * "healthy".
 */
import { createHash } from "node:crypto";
import type { CapabilityGrantClaims } from "@/lib/controlplane/types";
import { answeredProvenance, buildEnvelope, evidenceOf, failedProvenance, FRESHNESS_BUDGET_MS, type SourceProvenance, type TelemetryEnvelope } from "@/lib/observability/telemetry";
import { isMachineOperationError } from "./errors";
import { executeMachineOperation, type MachineExecutionContext } from "./service";
import type { MachineErrorCode, MachineOperation, MachineRequest, MachineResult, MachineTarget } from "./types";

/** Read-only operations that report machine or workload health. */
export const MACHINE_HEALTH_OPERATIONS: ReadonlySet<MachineOperation> = new Set(["machine.inspect", "service.status", "container.inspect", "system.metrics", "process.list"]);

const PROVIDER_OF: Record<MachineTarget["transport"], string> = {
  aws_ssm: "aws",
  kubernetes: "kubernetes",
  azure_run_command: "azure",
  gcp_os_management: "gcp",
  zenithd: "zenithd",
};

/** Refusals that mean "you may not read this", as opposed to "it could not be read". */
const REFUSED: ReadonlySet<MachineErrorCode> = new Set(["denied", "grant_mismatch"] as MachineErrorCode[]);

export interface MachineHealthRead {
  result?: MachineResult;
  error?: { code: string; message: string };
  telemetry: TelemetryEnvelope;
}

function sourceFor(target: MachineTarget): string {
  return `machines.${target.transport}`;
}

function scopeFor(target: MachineTarget, grant?: CapabilityGrantClaims) {
  return {
    workspaceId: target.workspaceId,
    ...(grant?.proj ? { projectId: grant.proj } : {}),
    environmentId: target.environmentId ?? "",
    ...(target.address ? { addresses: [target.address] } : {}),
  };
}

/** The scoped session of a machine read is its single-operation grant: a non-reversible fingerprint, never the JWS. */
function sessionFor(target: MachineTarget, grant: CapabilityGrantClaims) {
  const provider = PROVIDER_OF[target.transport];
  return { provider, transport: target.transport, expiresAt: new Date(grant.exp * 1000).toISOString(),
    ref: createHash("sha256").update([provider, grant.aud, grant.jti, grant.exp].join("|")).digest("hex").slice(0, 16) };
}

export function machineHealthTelemetry(input: { target: MachineTarget; observedAt: string; result?: MachineResult; error?: { code: string; message: string }; grant?: CapabilityGrantClaims }): TelemetryEnvelope {
  const { target, observedAt, result, error, grant } = input;
  const source = sourceFor(target);
  const provider = PROVIDER_OF[target.transport];
  let provenance: SourceProvenance;
  if (result && result.ok) {
    provenance = answeredProvenance({
      source,
      provider,
      simulated: result.simulated,
      timestamps: [result.finishedAt],
      observedAt,
      budgetMs: FRESHNESS_BUDGET_MS.health,
      ...(target.address ? { address: target.address } : {}),
      evidence: result.simulated ? { level: "simulated", basis: "simulated machine driver" } : { level: "contract", basis: `machine ${target.transport} transport contract tests; no live machine acceptance run` },
    });
  } else {
    const reason = result ? `the ${result.operation} operation did not succeed on the target` : `${error?.code ?? "error"}: ${error?.message ?? "machine health could not be read"}`;
    provenance = failedProvenance({
      source,
      provider,
      reason: result ? reason : error && REFUSED.has(error.code as MachineErrorCode) ? `access denied: ${reason}` : reason,
      observedAt,
      simulated: result?.simulated ?? false,
      ...(target.address ? { address: target.address } : {}),
      evidence: evidenceOf(source),
    });
    // a failed-but-returned operation reached the machine plane: it is unknown, never inaccessible by text accident
    if (result) provenance.state = "unknown";
  }
  return buildEnvelope({ signal: "health", scope: scopeFor(target, grant), ...(grant ? { session: sessionFor(target, grant) } : {}), observedAt, provenance: [provenance] });
}

/**
 * Read machine health. Only read-only health operations are accepted; anything
 * else is a programming error. Authorization failures are returned as an
 * `inaccessible`/`unknown` envelope; `uncertain` and `evidence_failed` cannot
 * happen on these read operations but are rethrown if they do (never hidden).
 */
export async function readMachineHealth(req: MachineRequest, ctx: MachineExecutionContext): Promise<MachineHealthRead> {
  if (!MACHINE_HEALTH_OPERATIONS.has(req.operation)) throw new Error(`${req.operation} is not a read-only machine health operation`);
  const now = ctx.now ?? (() => new Date());
  try {
    const result = await executeMachineOperation(req, ctx);
    return { result, telemetry: machineHealthTelemetry({ target: req.target, observedAt: now().toISOString(), result, grant: ctx.grant }) };
  } catch (e) {
    if (!isMachineOperationError(e) || e.code === "uncertain" || e.code === "evidence_failed" || e.code === "aborted") throw e;
    const error = { code: e.code, message: e.message };
    return { error, telemetry: machineHealthTelemetry({ target: req.target, observedAt: now().toISOString(), error, grant: ctx.grant }) };
  }
}
