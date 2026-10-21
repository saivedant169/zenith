/**
 * Conflict detection: a writer targeting a field owned by someone else is
 * refused, or needs an explicit, approved ownership transfer.
 *
 * Two enforcement points share `evaluateWrite`:
 *   - proposal time: `checkNativeOperation` (service.scale, deployment.deploy,
 *     drift.repair, ...) against the owner of the fields the operation writes;
 *   - plan time: `checkPlanFieldOwnership` over a normalized OpenTofu plan,
 *     where the writer is always IaC.
 *
 * Verdicts:
 *   allowed            the writer owns the field (or is seeding a new object)
 *   transfer_required  another owner holds it; an approved transfer to the
 *                      writer would make this legal. The request carries the
 *                      exact digest an approval must bind.
 *   refused            nobody may write it (provider-managed), or the writer is
 *                      the field's base owner while a transfer has moved it away.
 */
import type { NormalizedPlan, PlanResourceChange } from "@/lib/tofu/types";
import type { ResourceNode } from "@/lib/resources/types";
import { factsForNode } from "./facts";
import { normalizePath } from "./paths";
import { defaultFieldOwnershipRegistry, transferRequest, type FieldOwnershipRegistry } from "./registry";
import type { FieldConflict, FieldWrite, OwnershipFacts, OwnershipTransfer, WriterKind } from "./types";

export class FieldOwnershipConflictError extends Error {
  readonly code = "field_ownership_conflict";
  constructor(readonly conflicts: readonly FieldConflict[]) {
    super(
      `Refusing: ${conflicts.length} write(s) target fields owned by another writer. ` +
        conflicts
          .slice(0, 5)
          .map((c) => c.message)
          .join(" ")
    );
    this.name = "FieldOwnershipConflictError";
  }
}

export interface EnforcementOptions {
  registry?: FieldOwnershipRegistry;
  transfers?: readonly OwnershipTransfer[];
  now?: Date;
}

const clean = (s: string): string => s.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 200);

/** The resolve options a caller's `EnforcementOptions` imply (no undefined-valued keys). */
function resolveOpts(opts: EnforcementOptions): { transfers?: readonly OwnershipTransfer[]; now?: Date } {
  return { ...(opts.transfers ? { transfers: opts.transfers } : {}), ...(opts.now ? { now: opts.now } : {}) };
}

export function evaluateWrite(write: FieldWrite, opts: EnforcementOptions = {}): FieldConflict {
  const registry = opts.registry ?? defaultFieldOwnershipRegistry;
  const resolution = registry.resolve(
    { resourceType: write.resourceType, path: write.path, address: write.address, ...(write.facts ? { facts: write.facts } : {}) },
    resolveOpts(opts)
  );
  const where = `${clean(write.address)} ${normalizePath(clean(write.path))}`;
  const who = write.via ? `${write.writer} (${clean(write.via)})` : write.writer;

  if (resolution.owner === write.writer) {
    return { verdict: "allowed", write, resolution, message: `${where} is owned by ${resolution.owner}; ${who} may write it.` };
  }
  if (write.writer === "iac" && (write.action === "create" || write.action === "replace")) {
    return { verdict: "allowed", seed: true, write, resolution, message: `${where} is owned by ${resolution.owner}; ${write.action} only seeds its initial value.` };
  }
  if (resolution.owner === "provider-managed") {
    return { verdict: "refused", write, resolution, message: `${where} is provider-managed; no writer may change it (${resolution.reason})` };
  }
  if (write.writer === resolution.baseOwner) {
    return {
      verdict: "refused",
      write,
      resolution,
      message: `${where} was moved to ${resolution.owner} by approval ${resolution.transferId ?? "?"}; ${who} must not write it until that transfer is revoked or expires.`,
    };
  }
  const transfer = transferRequest({ address: write.address, resourceType: write.resourceType, path: write.path, from: resolution.baseOwner, to: write.writer });
  return {
    verdict: "transfer_required",
    write,
    resolution,
    transfer,
    message: `${where} is owned by ${resolution.owner}, not ${who}. An approved ownership transfer (${transfer.from} to ${transfer.to}, digest ${transfer.digest.slice(0, 12)}) is required.`,
  };
}

export const blocking = (c: FieldConflict): boolean => c.verdict !== "allowed";

/* ------------------------------ native operations -------------------------- */

export interface NativeOperationWrite {
  path: string;
  writer: WriterKind;
  /** Only checked when this top-level input field is being changed. */
  inputField?: string;
}

/**
 * The fields each capability writes. Operations absent here write no owned
 * field (restart, reads). Extend by passing `table` to the check functions.
 */
export const NATIVE_OPERATION_WRITES: Readonly<Record<string, readonly NativeOperationWrite[]>> = {
  "service.scale": [{ path: "replicas", writer: "native-op", inputField: "replicas" }, { path: "size", writer: "native-op", inputField: "size" }],
  "deployment.deploy": [{ path: "artifact.image", writer: "native-op" }],
  "deployment.rollback": [{ path: "artifact.image", writer: "native-op" }],
};

/** Whether a capability's writes are judged by field ownership: the native table plus drift.repair (an IaC reapply). */
export const writesOwnedFields = (capability: string): boolean => capability === "drift.repair" || NATIVE_OPERATION_WRITES[capability] !== undefined;

/** Fields a `drift.repair` re-applies, as IaC writes (reapply_desired_state). */
export const driftRepairWrites = (attributes: readonly string[]): NativeOperationWrite[] => attributes.map((path) => ({ path, writer: "iac" as const }));

/** A reapply_desired_state proposal names the attributes it re-applies (see EcsReplicaRepairInput). */
const repairInputAttributes = (input: Readonly<Record<string, unknown>> | undefined): string[] =>
  Array.isArray(input?.attributes) ? input.attributes.filter((a): a is string => typeof a === "string") : [];

export interface NativeOperationCheck extends EnforcementOptions {
  capability: string;
  node: Pick<ResourceNode, "address" | "nativeType" | "spec">;
  /** extra facts (e.g. from `factsByAddress(graph)`); merged over the node's own */
  facts?: OwnershipFacts;
  /** for `drift.repair`: the attributes the repair re-applies */
  repairAttributes?: readonly string[];
  input?: Readonly<Record<string, unknown>>;
  table?: Readonly<Record<string, readonly NativeOperationWrite[]>>;
}

export function checkNativeOperation(check: NativeOperationCheck): FieldConflict[] {
  const writes: readonly NativeOperationWrite[] =
    check.capability === "drift.repair" ? driftRepairWrites(check.repairAttributes ?? repairInputAttributes(check.input)) : ((check.table ?? NATIVE_OPERATION_WRITES)[check.capability] ?? []);
  const facts = { ...factsForNode(check.node), ...(check.facts ?? {}) };
  const typedScaleInput = check.input && (Object.hasOwn(check.input, "replicas") || Object.hasOwn(check.input, "size"));
  return writes.filter(w => !w.inputField || (typedScaleInput ? Object.hasOwn(check.input!, w.inputField) : w.inputField === "replicas")).map((w) =>
    evaluateWrite({ address: check.node.address, resourceType: check.node.nativeType, path: w.path, writer: w.writer, via: check.capability, facts }, check)
  );
}

/** Throws `FieldOwnershipConflictError` unless every field the operation writes is its writer's to write. */
export function assertNativeOperationAllowed(check: NativeOperationCheck): FieldConflict[] {
  const all = checkNativeOperation(check);
  const bad = all.filter(blocking);
  if (bad.length > 0) throw new FieldOwnershipConflictError(bad);
  return all;
}

/* ------------------------------------ plans -------------------------------- */

const WRITING: ReadonlySet<PlanResourceChange["action"]> = new Set(["create", "update", "replace"]);

export interface PlanOwnershipOptions extends EnforcementOptions {
  /** facts per node address; absent addresses use the node's own spec */
  factsByAddress?: ReadonlyMap<string, OwnershipFacts>;
}

/** IaC writes implied by a plan, judged against field ownership. All verdicts are returned; filter with `blocking`. */
export function checkPlanFieldOwnership(
  plan: Pick<NormalizedPlan, "resourceChanges">,
  nodes: readonly Pick<ResourceNode, "address" | "spec">[],
  opts: PlanOwnershipOptions = {}
): FieldConflict[] {
  const byAddress = new Map(nodes.map((n) => [n.address, n]));
  const out: FieldConflict[] = [];
  for (const change of plan.resourceChanges) {
    if (!WRITING.has(change.action)) continue;
    const address = change.nodeAddress ?? change.address;
    const node = byAddress.get(address);
    const facts = opts.factsByAddress?.get(address) ?? (node ? factsForNode(node) : undefined);
    for (const c of change.changes) {
      out.push(
        evaluateWrite(
          { address, resourceType: change.type, path: c.path, writer: "iac", action: change.action as "create" | "update" | "replace", via: change.address, ...(facts ? { facts } : {}) },
          opts
        )
      );
    }
  }
  return out;
}

export function assertPlanFieldOwnership(
  plan: Pick<NormalizedPlan, "resourceChanges">,
  nodes: readonly Pick<ResourceNode, "address" | "spec">[],
  opts: PlanOwnershipOptions = {}
): void {
  const bad = checkPlanFieldOwnership(plan, nodes, opts).filter(blocking);
  if (bad.length > 0) throw new FieldOwnershipConflictError(bad);
}
