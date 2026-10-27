/**
 * PROD-MIX-05 (owner decision, 2026-10-26): protected connectivity is required only across a cloud or account boundary.
 * Two partitions bound to the SAME connection share one trust boundary (that provider's IAM), so a dependency or typed
 * reference between them needs no declared endpoint. Every other pair stays required, and a declaration is always judged.
 * Pure rules over logical plans: no network, no cloud.
 */
import { describe, expect, it } from "vitest";
import type { ProviderConnection } from "@/lib/credentials/types";
import { digest } from "@/lib/controlplane/digest";
import { assessConnectivity, CONNECTIVITY_FORMAT, defaultProtectedEndpoints, requiredPairs, type ConnectivityDeclaration, type EdgeFacts, type PartitionNetwork } from "@/lib/execution/mixed/connectivity";
import { buildParentPlan, type BuildParentPlanInput, type DeclaredReference } from "@/lib/execution/mixed/parent-plan";
import type { ChildEnvironmentCandidate, PartitionPin } from "@/lib/execution/mixed/partitioner";
import { MixedPlanError, type MixedParentPlan } from "@/lib/execution/mixed/types";
import { finalizeGraph, GraphBuilder } from "@/lib/resources/expand-support";
import type { ResourceGraph } from "@/lib/resources/types";
import { connection, PARENT_ENV, PROJECT, WS } from "./_fixtures";

const HEX_A = "a".repeat(64);
const HEX_B = "b".repeat(64);
const ENV_A = "env-aws-1";
const ENV_B = "env-aws-2";
const ADDR_A = "service/a";
const ADDR_B = "service/b";

/** Two AWS functions in one region; b depends on a. A pin puts each into its own child environment. */
function awsPairGraph(): ResourceGraph {
  const b = new GraphBuilder(PARENT_ENV);
  b.add({ address: ADDR_A, kind: "function", place: { provider: "aws", region: "us-east-1" }, spec: { n: 1 }, origin: ["a"] });
  b.add({ address: ADDR_B, kind: "function", place: { provider: "aws", region: "us-east-1" }, spec: { n: 2 }, origin: ["b"], dependsOn: [ADDR_A] });
  return finalizeGraph(b, PARENT_ENV, digest("manifest-aws-pair"));
}

const PINS: PartitionPin[] = [{ address: ADDR_A, childEnvironmentId: ENV_A }, { address: ADDR_B, childEnvironmentId: ENV_B }];
const REFERENCE: DeclaredReference = {
  id: "ref-queue", producer: { address: ADDR_A, output: "queueArn", type: "resource_id" }, consumer: { address: ADDR_B, input: "queueArn", type: "resource_id" },
};

/** One AWS connection bound to two child environments: one trust boundary. */
function sameConnectionCandidates(): ChildEnvironmentCandidate[] {
  const aws = connection("aws");
  return [{ childEnvironmentId: ENV_A, connection: aws }, { childEnvironmentId: ENV_B, connection: aws }];
}

/** A second AWS connection in another account: same provider, different connection, different trust boundary. */
function otherAccountConnection(): ProviderConnection {
  const base = connection("aws", { id: "conn-aws-other" });
  const other = "210987654321";
  const config = { ...base.config, accountId: other, observeRoleArn: `arn:aws:iam::${other}:role/observe`, deployRoleArn: `arn:aws:iam::${other}:role/deploy` };
  return { ...base, config: config as ProviderConnection["config"] };
}

function awsInput(over: Partial<BuildParentPlanInput> = {}): BuildParentPlanInput {
  return { workspaceId: WS, projectId: PROJECT, parentEnvironmentId: PARENT_ENV, graph: awsPairGraph(), candidates: sameConnectionCandidates(), pins: PINS, ...over };
}

const partitionOf = (plan: MixedParentPlan, address: string): string => plan.children.find((c) => c.nodes.some((n) => n.address === address))!.partitionId;

describe("same connection: no declaration needed inside one trust boundary", () => {
  it("accepts an AWS to AWS dependency between two child environments of one connection without a declaration", () => {
    const plan = buildParentPlan(awsInput());
    expect(plan.children).toHaveLength(2);
    expect(new Set(plan.children.map((c) => c.authority.connectionId))).toEqual(new Set(["conn-aws"]));
    expect(plan.connectivity).toBeUndefined();
    expect(requiredPairs(plan)).toEqual([]);
    expect(assessConnectivity(plan, { format: CONNECTIVITY_FORMAT, networks: [], endpoints: [] }).problems).toEqual([]);
  });

  it("plans a connection read from the store (absent columns as undefined, a Date) exactly like the in-memory one", () => {
    const stored = { ...connection("aws"), revokedAt: undefined, verificationDetail: undefined, createdAt: new Date("2026-10-27T00:00:00.000Z") as unknown as string };
    const plan = buildParentPlan(awsInput({ references: [REFERENCE], candidates: [{ childEnvironmentId: ENV_A, connection: stored }, { childEnvironmentId: ENV_B, connection: stored }] }));
    const memory = buildParentPlan(awsInput({ references: [REFERENCE], candidates: [{ childEnvironmentId: ENV_A, connection: { ...connection("aws"), createdAt: "2026-10-27T00:00:00.000Z" } }, { childEnvironmentId: ENV_B, connection: { ...connection("aws"), createdAt: "2026-10-27T00:00:00.000Z" } }] }));
    expect(plan.parentDigest).toBe(memory.parentDigest);
  });

  it("accepts a typed reference between them without a declaration", () => {
    const plan = buildParentPlan(awsInput({ references: [REFERENCE] }));
    expect(plan.references).toHaveLength(1);
    expect(plan.references[0]!.producerPartitionId).toBe(partitionOf(plan, ADDR_A));
    expect(plan.references[0]!.consumerPartitionId).toBe(partitionOf(plan, ADDR_B));
    expect(requiredPairs(plan)).toEqual([]);
  });
});

describe("requiredPairs keeps every boundary-crossing pair", () => {
  it("requires the same-provider, different-connection pair (a second AWS account) without a declaration", () => {
    const plan = buildParentPlan(awsInput({ candidates: [{ childEnvironmentId: ENV_A, connection: connection("aws") }, { childEnvironmentId: ENV_B, connection: otherAccountConnection() }] }));
    expect(requiredPairs(plan)).toEqual([{ consumer: partitionOf(plan, ADDR_B), producer: partitionOf(plan, ADDR_A) }]);
    const missing = assessConnectivity(plan, { format: CONNECTIVITY_FORMAT, networks: [], endpoints: [] });
    expect(missing.ok).toBe(false);
    expect(missing.problems.map((p) => p.code)).toEqual(["missing_connectivity"]);
  });

  it("requires a typed reference across a different connection", () => {
    const plan = buildParentPlan(awsInput({ references: [REFERENCE], candidates: [{ childEnvironmentId: ENV_A, connection: connection("aws") }, { childEnvironmentId: ENV_B, connection: otherAccountConnection() }] }));
    expect(requiredPairs(plan)).toHaveLength(1);
  });

  it("keeps a cross-provider pair required (the multi-cloud default is unchanged)", () => {
    const b = new GraphBuilder(PARENT_ENV);
    b.add({ address: ADDR_A, kind: "function", place: { provider: "aws", region: "us-east-1" }, spec: { n: 1 }, origin: ["a"] });
    b.add({ address: ADDR_B, kind: "compute_instance", place: { provider: "gcp", region: "us-central1" }, spec: { machineType: "logical-compute" }, origin: ["b"], dependsOn: [ADDR_A] });
    const graph = finalizeGraph(b, PARENT_ENV, digest("manifest-cross-cloud"));
    const cross = buildParentPlan({ workspaceId: WS, projectId: PROJECT, parentEnvironmentId: PARENT_ENV, graph, candidates: [{ childEnvironmentId: ENV_A, connection: connection("aws") }, { childEnvironmentId: ENV_B, connection: connection("gcp") }] });
    expect(requiredPairs(cross)).toEqual([{ consumer: partitionOf(cross, ADDR_B), producer: partitionOf(cross, ADDR_A) }]);
  });

  it("never drops a pair whose partition the view does not know (fail closed)", () => {
    const plan = buildParentPlan(awsInput({ references: [REFERENCE] }));
    const view = {
      children: [{ partitionId: plan.children[0]!.partitionId, dependsOn: [], authority: plan.children[0]!.authority, nodes: [] }],
      references: [{ producerPartitionId: "ghost", consumerPartitionId: plan.children[0]!.partitionId }],
    };
    expect(requiredPairs(view)).toEqual([{ consumer: plan.children[0]!.partitionId, producer: "ghost" }]);
  });
});

describe("unplaced partitions fail closed: a missing or empty id never proves a shared boundary", () => {
  type View = Parameters<typeof requiredPairs>[0];
  const pairView = (a: { provider?: unknown; connectionId?: unknown }, b: { provider?: unknown; connectionId?: unknown }): View => ({
    children: [
      { partitionId: "p1", dependsOn: ["p2"], authority: a, nodes: [] },
      { partitionId: "p2", dependsOn: [], authority: b, nodes: [] },
    ],
    references: [],
  } as unknown as View);

  it("keeps a pair required when both connection ids are missing, even on the same provider", () => {
    expect(requiredPairs(pairView({ provider: "aws" }, { provider: "aws" }))).toEqual([{ consumer: "p1", producer: "p2" }]);
  });

  it("keeps a pair required when only one connection id is missing", () => {
    expect(requiredPairs(pairView({ provider: "aws", connectionId: "conn-aws" }, { provider: "aws" }))).toEqual([{ consumer: "p1", producer: "p2" }]);
    expect(requiredPairs(pairView({ provider: "aws" }, { provider: "aws", connectionId: "conn-aws" }))).toEqual([{ consumer: "p1", producer: "p2" }]);
  });

  it("keeps a pair required when the connection ids are empty strings, even if equal", () => {
    expect(requiredPairs(pairView({ provider: "aws", connectionId: "" }, { provider: "aws", connectionId: "" }))).toEqual([{ consumer: "p1", producer: "p2" }]);
  });

  it("keeps a pair required when the providers are missing or empty, even with the same connection id", () => {
    expect(requiredPairs(pairView({ connectionId: "conn-x" }, { connectionId: "conn-x" }))).toEqual([{ consumer: "p1", producer: "p2" }]);
    expect(requiredPairs(pairView({ provider: "", connectionId: "conn-x" }, { provider: "", connectionId: "conn-x" }))).toEqual([{ consumer: "p1", producer: "p2" }]);
  });

  it("still excuses a pair only when both ids are non-empty and equal and both providers match", () => {
    expect(requiredPairs(pairView({ provider: "aws", connectionId: "conn-x" }, { provider: "aws", connectionId: "conn-x" }))).toEqual([]);
  });
});

describe("a declaration is still judged in full, even inside one boundary", () => {
  const sameNetworks = (plan: MixedParentPlan): PartitionNetwork[] => plan.children.map((c, i) => ({ partitionId: c.partitionId, cidrs: [`10.${40 + i}.0.0/16`], egress: [`52.2.2.${i + 1}`] }));
  const sameFacts = (plan: MixedParentPlan): EdgeFacts[] => [{
    consumerPartitionId: partitionOf(plan, ADDR_B), producerPartitionId: partitionOf(plan, ADDR_A), host: "a.mixed.example.com", port: 443, dnsTargets: ["52.2.2.10"],
    serverSpkiSha256: HEX_A, clientCaDigest: HEX_B, clientCertSubject: "CN=b", clientKeyRef: "vault:ws/env/k", clientCertRef: "vault:ws/env/c",
  }];

  it("accepts a well-formed declaration for a same-connection pair and binds its digest", () => {
    const base = buildParentPlan(awsInput());
    const declaration = defaultProtectedEndpoints(base, sameNetworks(base), sameFacts(base));
    const declared = buildParentPlan(awsInput({ connectivity: declaration }));
    expect(declared.connectivity!.digest).toBe(assessConnectivity(base, declaration).digest);
    expect(declared.parentPlanId).not.toBe(base.parentPlanId);
  });

  it("refuses an unsafe declaration for a same-connection pair and names the first problem", () => {
    const base = buildParentPlan(awsInput());
    const declaration: ConnectivityDeclaration = defaultProtectedEndpoints(base, sameNetworks(base), sameFacts(base));
    declaration.endpoints[0]!.allowlist = ["0.0.0.0/0"];
    let failure: unknown;
    try { buildParentPlan(awsInput({ connectivity: declaration })); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(MixedPlanError);
    expect((failure as MixedPlanError).code).toBe("plan_refused");
    expect((failure as MixedPlanError).detail).toMatchObject({ code: "allowlist_wildcard" });
  });
});
