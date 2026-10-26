/**
 * Public readback of a stored mixed plan's dependency references (PROD-MIX-03). Ids, addresses, value types and digests
 * only: never a value, a vault reference or a credential. A client reads these to issue one precise output
 * preauthorization (POST /api/platform/v1/mixed-output-preauthorizations) without guessing any digest.
 */
import type { MixedParentPlan } from "./types";

export interface ReferenceReadback {
  referenceId: string;
  producerPartitionId: string;
  consumerPartitionId: string;
  producerAddress: string | null;
  producerOutput: string | null;
  consumerAddress: string | null;
  consumerInput: string | null;
  valueType: string | null;
  /** The digest a consumer's preauthorization binds (`contractDigest`). */
  contractDigest: string;
  /** The producing and consuming child's immutable subplan digests (`producerSubplanDigest`, `consumerSubplanDigest`). */
  producerSubplanDigest: string | null;
  consumerSubplanDigest: string | null;
  state: "available" | "unavailable";
  unavailableReason: string | null;
}

/** One entry per planned reference, in plan order. Legacy references without a stored contract yield nulls, never guesses. */
export function referenceReadback(plan: MixedParentPlan): ReferenceReadback[] {
  const subplan = new Map(plan.children.map((child) => [child.partitionId, child.subplanDigest]));
  return plan.references.map((ref) => ({
    referenceId: ref.referenceId,
    producerPartitionId: ref.producerPartitionId,
    consumerPartitionId: ref.consumerPartitionId,
    producerAddress: ref.producerAddress ?? null,
    producerOutput: ref.producerOutput ?? null,
    consumerAddress: ref.consumerAddress ?? null,
    consumerInput: ref.consumerInput ?? null,
    valueType: ref.valueType ?? null,
    contractDigest: ref.contractDigest,
    producerSubplanDigest: subplan.get(ref.producerPartitionId) ?? null,
    consumerSubplanDigest: subplan.get(ref.consumerPartitionId) ?? null,
    state: ref.state,
    unavailableReason: ref.unavailableReason ?? null,
  }));
}
