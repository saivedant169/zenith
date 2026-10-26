/**
 * PROD-MIX-03 readback: the mixed plan and run readback expose, per dependency reference, the id, producer and consumer
 * addresses, value type and the contract digest the consumer approval binds, plus the subplan digests a one-reference
 * preauthorization names. Digests and types only: no value, no vault reference, no credential.
 */
import { describe, expect, it } from "vitest";
import { digest } from "@/lib/controlplane/digest";
import { buildParentPlan, type BuildParentPlanInput, type DeclaredReference } from "@/lib/execution/mixed/parent-plan";
import { referenceReadback, type ReferenceReadback } from "@/lib/execution/mixed/readback";
import type { ChildEnvironmentCandidate, PartitionPin } from "@/lib/execution/mixed/partitioner";
import type { MixedParentPlan } from "@/lib/execution/mixed/types";
import { finalizeGraph, GraphBuilder } from "@/lib/resources/expand-support";
import { connection, PARENT_ENV, PROJECT, WS } from "./_fixtures";

const ADDR_A = "service/a";
const ADDR_B = "service/b";
const REFERENCE: DeclaredReference = {
  id: "ref-queue", producer: { address: ADDR_A, output: "queueArn", type: "resource_id" }, consumer: { address: ADDR_B, input: "queueArn", type: "resource_id" },
};

function plan(references: DeclaredReference[] = [REFERENCE]): MixedParentPlan {
  const b = new GraphBuilder(PARENT_ENV);
  b.add({ address: ADDR_A, kind: "function", place: { provider: "aws", region: "us-east-1" }, spec: { n: 1 }, origin: ["a"] });
  b.add({ address: ADDR_B, kind: "function", place: { provider: "aws", region: "us-east-1" }, spec: { n: 2 }, origin: ["b"], dependsOn: [ADDR_A] });
  const graph = finalizeGraph(b, PARENT_ENV, digest("manifest-readback"));
  const aws = connection("aws");
  const candidates: ChildEnvironmentCandidate[] = [{ childEnvironmentId: "env-aws-1", connection: aws }, { childEnvironmentId: "env-aws-2", connection: aws }];
  const pins: PartitionPin[] = [{ address: ADDR_A, childEnvironmentId: "env-aws-1" }, { address: ADDR_B, childEnvironmentId: "env-aws-2" }];
  const input: BuildParentPlanInput = { workspaceId: WS, projectId: PROJECT, parentEnvironmentId: PARENT_ENV, graph, candidates, pins, references };
  return buildParentPlan(input);
}

const subplanOf = (p: MixedParentPlan, address: string): string => p.children.find((c) => c.nodes.some((n) => n.address === address))!.subplanDigest;
const HEX = /^[a-f0-9]{64}$/;

describe("reference readback shape", () => {
  it("exposes each reference's id, addresses, value type and the contract digest the approval binds", () => {
    const p = plan();
    const [ref] = referenceReadback(p);
    expect(ref).toEqual<ReferenceReadback>({
      referenceId: "ref-queue",
      producerPartitionId: p.references[0]!.producerPartitionId,
      consumerPartitionId: p.references[0]!.consumerPartitionId,
      producerAddress: ADDR_A,
      producerOutput: "queueArn",
      consumerAddress: ADDR_B,
      consumerInput: "queueArn",
      valueType: "resource_id",
      contractDigest: p.references[0]!.contractDigest,
      producerSubplanDigest: subplanOf(p, ADDR_A),
      consumerSubplanDigest: subplanOf(p, ADDR_B),
      state: "unavailable",
      unavailableReason: "not_produced",
    });
  });

  it("the contract digest is the one a consumer preauthorization is checked against (id, scope, producer, consumer)", () => {
    const p = plan();
    const [ref] = referenceReadback(p);
    const recomputed = digest({ id: REFERENCE.id, scope: { workspaceId: WS, environmentId: PARENT_ENV }, producer: REFERENCE.producer, consumer: REFERENCE.consumer });
    expect(ref!.contractDigest).toBe(recomputed);
    expect(ref!.contractDigest).toMatch(HEX);
  });

  it("returns an empty inventory for a plan with no references", () => {
    expect(referenceReadback(plan([]))).toEqual([]);
  });

  it("carries digests and types only: no value, no vault reference, no key material", () => {
    const text = JSON.stringify(referenceReadback(plan()));
    expect(text).not.toMatch(/vault:/);
    expect(text).not.toMatch(/BEGIN [A-Z ]+KEY/);
    for (const entry of referenceReadback(plan())) {
      expect(Object.keys(entry).sort()).toEqual([
        "consumerAddress", "consumerInput", "consumerPartitionId", "consumerSubplanDigest", "contractDigest", "producerAddress", "producerOutput",
        "producerPartitionId", "producerSubplanDigest", "referenceId", "state", "unavailableReason", "valueType",
      ]);
      expect(entry.contractDigest).toMatch(HEX);
    }
  });

  it("a reference stored without its declared contract yields nulls, never a guess", () => {
    const p = plan();
    const legacy = structuredClone(p) as MixedParentPlan;
    const ref = legacy.references[0] as unknown as Record<string, unknown>;
    for (const key of ["producerAddress", "producerOutput", "consumerAddress", "consumerInput", "valueType"]) delete ref[key];
    const [entry] = referenceReadback(legacy);
    expect(entry).toMatchObject({ producerAddress: null, producerOutput: null, consumerAddress: null, consumerInput: null, valueType: null, contractDigest: p.references[0]!.contractDigest });
  });
});
