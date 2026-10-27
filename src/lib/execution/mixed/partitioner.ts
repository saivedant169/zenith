/**
 * Partition a resource graph by provider, account, region and state backend, and
 * bind every partition to one explicitly authorized connection (PROD-MIX-01).
 *
 * Pure: it receives connections that the caller already loaded from the platform
 * store (`repos.connections.get`, workspace-scoped) and decides nothing about
 * credentials. What it refuses, and why that matters:
 *
 *  - a node whose (provider, region) matches no bound connection: the graph stays
 *    non-executable. The existing cross-provider refusal in `findGraphProblems`
 *    is lifted only through `admitMixedGraph` (admission.ts), which requires this
 *    result for EVERY node, never for some.
 *  - two connections that could both host a node and no explicit pin: Zenith does
 *    not guess which account receives a resource.
 *  - a connection that is not verified, was revoked or belongs to another
 *    workspace. Verification is read from the stored record, never asserted by a
 *    caller.
 *  - a connection that no node uses (an authorization nobody asked for).
 *  - a state backend that cannot lock or encrypt (`assertBackendAdmissible`).
 */
import { digest } from "@/lib/controlplane/digest";
import type { ProviderConnection } from "@/lib/credentials/types";
import type { PartitionBinding } from "@/lib/execution/mixed-partitions";
import type { ResourceGraph } from "@/lib/resources/types";
import { assertBackendAdmissible } from "@/lib/tofu/backend-capabilities";
import { backendForConnection } from "@/lib/tofu/backends";
import { MixedPlanError, type MixedProviderName } from "./types";

/** One child environment and the platform connection it executes through. */
export interface ChildEnvironmentCandidate {
  childEnvironmentId: string;
  connection: ProviderConnection;
}

export interface PartitionPin {
  address: string;
  childEnvironmentId: string;
}

export interface PartitionAssignmentResult {
  bindings: PartitionBinding[];
  assignments: { address: string; bindingId: string }[];
  /** binding id -> the child environment that owns that partition's state */
  childEnvironmentOf: ReadonlyMap<string, string>;
}

const MIXED_PROVIDERS: readonly string[] = ["aws", "gcp", "azure", "oci"];
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function accountOf(connection: ProviderConnection): { provider: MixedProviderName; accountId: string; region: string } {
  const config = connection.config;
  switch (config.provider) {
    case "aws": return { provider: "aws", accountId: config.accountId, region: config.region };
    case "gcp": return { provider: "gcp", accountId: config.projectId, region: config.region };
    case "azure": return { provider: "azure", accountId: config.subscriptionId, region: config.region };
    case "oci": return { provider: "oci", accountId: config.tenancyOcid, region: config.region };
    default: throw new MixedPlanError("connection_unverified", "This connection's provider cannot take part in a mixed plan.");
  }
}

/** Stable binding id: the same connection + child environment always yields the same id. */
export function bindingIdFor(connectionId: string, childEnvironmentId: string): string {
  return `bnd_${digest({ connectionId, childEnvironmentId }).slice(0, 24)}`;
}

/** Verified-connection gate. A stored status of `verified` and no revocation, in this workspace, is the only pass. */
export function assertConnectionAuthorized(connection: ProviderConnection, workspaceId: string): void {
  if (connection.workspaceId !== workspaceId) throw new MixedPlanError("connection_foreign", "A connection does not belong to this workspace.");
  if (connection.status !== "verified" || connection.revokedAt !== undefined) {
    throw new MixedPlanError("connection_unverified", "Every partition needs a verified, unrevoked connection; one is not.", { connectionId: connection.id, status: connection.status });
  }
}

export function bindingFor(candidate: ChildEnvironmentCandidate, workspaceId: string): PartitionBinding {
  if (!ID.test(candidate.childEnvironmentId)) throw new MixedPlanError("invalid_input", "A child environment id is malformed.");
  assertConnectionAuthorized(candidate.connection, workspaceId);
  const { provider, accountId, region } = accountOf(candidate.connection);
  let state: ReturnType<typeof backendForConnection>;
  try {
    state = backendForConnection(candidate.connection, { workspaceId, environmentId: candidate.childEnvironmentId });
    assertBackendAdmissible(state.backend);
  } catch (error) {
    throw new MixedPlanError("backend_refused", `A partition's state backend is refused: ${error instanceof Error ? error.message.slice(0, 200) : "invalid"}`, { provider });
  }
  if (state.backend.kind !== "s3" && state.backend.kind !== "gcs" && state.backend.kind !== "azurerm") {
    throw new MixedPlanError("backend_refused", "A partition needs a durable remote state backend.", { provider });
  }
  return {
    id: bindingIdFor(candidate.connection.id, candidate.childEnvironmentId),
    // The planner admits only plain JSON. A stored connection carries absent columns as undefined keys (and may carry Dates);
    // the JSON copy drops them, so a connection read from the store plans exactly like the same connection built in memory.
    connection: JSON.parse(JSON.stringify(candidate.connection)) as ProviderConnection, accountId, region,
    backend: state.backend, stateKey: state.stateKey, environmentId: candidate.childEnvironmentId,
  };
}

/**
 * Assign every graph node to exactly one bound child. Provider and region come
 * from the node itself; the account is the connection's. Explicit pins resolve
 * only a real ambiguity; a pin to a child that cannot host the node is refused.
 */
export function assignPartitions(input: {
  workspaceId: string;
  graph: Pick<ResourceGraph, "nodes">;
  candidates: readonly ChildEnvironmentCandidate[];
  pins?: readonly PartitionPin[];
}): PartitionAssignmentResult {
  const { workspaceId, graph, candidates } = input;
  if (!candidates.length) throw new MixedPlanError("unbound_partition", "A mixed plan needs at least one bound child environment.");
  const seenEnvironments = new Set<string>();
  const bindings: PartitionBinding[] = [];
  const childEnvironmentOf = new Map<string, string>();
  for (const candidate of candidates) {
    if (seenEnvironments.has(candidate.childEnvironmentId)) throw new MixedPlanError("invalid_input", "A child environment may be bound once per plan.");
    seenEnvironments.add(candidate.childEnvironmentId);
    const binding = bindingFor(candidate, workspaceId);
    bindings.push(binding);
    childEnvironmentOf.set(binding.id, candidate.childEnvironmentId);
  }
  const pins = new Map<string, string>();
  for (const pin of input.pins ?? []) {
    if (pins.has(pin.address)) throw new MixedPlanError("invalid_input", "A node is pinned twice.");
    pins.set(pin.address, pin.childEnvironmentId);
  }
  const byEnvironment = new Map(bindings.map((binding) => [binding.environmentId!, binding]));
  const assignments: { address: string; bindingId: string }[] = [];
  const used = new Set<string>();
  const unbound = new Set<string>();
  for (const node of [...graph.nodes].sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0))) {
    if (!MIXED_PROVIDERS.includes(node.provider)) {
      throw new MixedPlanError("unbound_partition", `A node is placed on ${node.provider}, which cannot take part in a mixed plan.`, { address: node.address });
    }
    const hosts = bindings.filter((binding) => accountOf(binding.connection).provider === node.provider && binding.region === node.region);
    const pinned = pins.get(node.address);
    let chosen: PartitionBinding | undefined;
    if (pinned !== undefined) {
      chosen = byEnvironment.get(pinned);
      if (!chosen || !hosts.includes(chosen)) throw new MixedPlanError("child_mismatch", "A pin names a child environment that cannot host this node.", { address: node.address });
    } else if (hosts.length === 1) chosen = hosts[0];
    else if (hosts.length > 1) throw new MixedPlanError("ambiguous_partition", "More than one bound child can host a node; pin it explicitly.", { address: node.address, candidates: hosts.length });
    if (!chosen) { unbound.add(`${node.provider}/${node.region}`); continue; }
    assignments.push({ address: node.address, bindingId: chosen.id });
    used.add(chosen.id);
  }
  if (unbound.size) {
    throw new MixedPlanError("unbound_partition", `No verified connection is bound for: ${[...unbound].sort().join(", ")}. The graph stays non-executable.`, { missing: unbound.size });
  }
  const unused = bindings.filter((binding) => !used.has(binding.id));
  if (unused.length) throw new MixedPlanError("child_mismatch", "A bound child environment hosts no node of this graph.", { unused: unused.length });
  for (const pin of pins.keys()) if (!graph.nodes.some((node) => node.address === pin)) throw new MixedPlanError("child_mismatch", "A pin names an address that is not in the graph.");
  return { bindings, assignments, childEnvironmentOf };
}
