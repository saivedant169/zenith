/**
 * PROD-LIFE-12: the ECS service compile asks the field-ownership registry
 * whether tofu may keep writing desired_count. A manifest-owned count keeps
 * today's output byte for byte; an attached autoscaler gets ignore_changes.
 */
import { describe, expect, it } from "vitest";
import type { ResourceNode } from "@/lib/resources/types";
import { ecsServiceDriver } from "@/lib/providers/aws/drivers/compute/ecs-service";
import { buildFixture, mkCompileContext } from "./fixtures";

type Body = Record<string, unknown>;
const compile = (autoscaling?: Record<string, unknown>) => {
  const fx = buildFixture({});
  const node = fx.byAddress.get("container_service/web")!;
  const next: ResourceNode = autoscaling ? { ...node, spec: { ...node.spec, autoscaling } } : node;
  fx.byAddress.set(node.address, next);
  const fragment = ecsServiceDriver.compile!(next, mkCompileContext(fx.byAddress));
  return (fragment.resource as Record<string, Record<string, Body>>).aws_ecs_service.container_service_web;
};

describe("aws_ecs_service lifecycle from field ownership", () => {
  it("emits no lifecycle block while the manifest owns desired_count", () => {
    expect(compile().lifecycle).toBeUndefined();
  });

  it("ignores desired_count when a separate autoscaling target node in the graph owns it", () => {
    const fx = buildFixture({});
    const node = fx.byAddress.get("container_service/web")!;
    const autoscaler = { ...node, address: "native/web-autoscaler", kind: "provider_native", nativeType: "aws:appautoscaling_target",
      spec: { config: { target: node.address } }, dependsOn: [node.address] } as unknown as ResourceNode;
    const nodes = [...fx.byAddress.values(), autoscaler];
    const fragment = ecsServiceDriver.compile!(node, mkCompileContext(fx.byAddress, { nodes: () => nodes }));
    expect((fragment.resource as Record<string, Record<string, Body>>).aws_ecs_service.container_service_web.lifecycle).toEqual({ ignore_changes: ["desired_count"] });
    // Without the graph the same node keeps writing desired_count: the graph is what carries the fact.
    expect(compile().lifecycle).toBeUndefined();
  });

  it("ignores desired_count once an autoscaler owns it", () => {
    expect(compile({ min: 1, max: 4 }).lifecycle).toEqual({ ignore_changes: ["desired_count"] });
  });
});
