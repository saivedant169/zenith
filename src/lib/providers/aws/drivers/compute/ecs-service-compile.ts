/**
 * `aws:ecs_service` compile: the ECS service around the shared task plumbing
 * (`ecs-task.ts`).
 *
 * The service is Fargate + awsvpc in the PRIVATE subnets with no public IP;
 * it is reachable only through the load balancer's security-group rule.
 *
 *   - `desired_count` is MANAGED by tofu (= `spec.replicas`). `service.scale`
 *     changes the running count immediately, and the next apply sets it back
 *     to the manifest's value unless the manifest is updated too: the manifest
 *     is the single source of truth for capacity, and a live-only override that
 *     silently survived applies would be undeclared state. The scale operation
 *     says so in its result.
 *   - `deployment_circuit_breaker { enable, rollback }`: a rollout whose tasks
 *     keep failing rolls back to the last steady task definition by itself.
 *   - min healthy 100 % / max 200 %: replacement tasks start before the old
 *     ones stop (capacity for one extra copy is needed during a rollout).
 *   - `wait_for_steady_state` false: the apply returns when the service is
 *     created/updated; the deploy workflow waits natively (DescribeServices)
 *     and reports rollout failures itself.
 *   - `enable_execute_command` false: no interactive shell into tasks
 *     (`container.exec` is an escape-hatch capability with its own gates).
 *   - `propagate_tags = SERVICE` so tasks carry the Zenith tags.
 *
 * When a load balancer routes to this node the service gets one
 * `load_balancer` block per routed container port, attached to the target
 * group the load balancer node published for this target (`ctx.ref(lb,
 * "target_group_arn:<this address>")`, one per port when several are routed).
 *
 * ORDERING LIMIT: ECS refuses CreateService for a target group that no
 * listener rule forwards to yet, and the listener rule lives in the load
 * balancer node's fragment, which this node can only reference through the
 * published target-group ARN. So on the FIRST apply the service depends on the
 * target group but not on its listener rule; OpenTofu creates them in
 * parallel and the provider's CreateService retries the "does not have an
 * associated load balancer" error until the rule exists (from the provider's
 * behaviour as recalled, NOT verified against an account). If that proves
 * wrong, the load balancer driver should publish a `rule_ready:<target>`
 * attribute for this node to gate on (handoff: integration notes).
 */
import type { CompileContext, TofuFragment } from "@/lib/drivers/types";
import type { ResourceNode } from "@/lib/resources/types";
import type { ContainerServiceSpec, LoadBalancerSpec } from "@/lib/resources/specs";
import { cloudName, nodeName, targetGroupAttribute, tfLabel } from "@/lib/providers/aws/drivers/shared";
import { compileNode, intField, specOf } from "./support/driver-util";
import { dependencies } from "./support/refs";
import { ComputeCompileError, Frag, attr, refOf, tagsFor } from "./support/tf";
import { emitTask } from "./ecs-task";
import { fargateSize } from "./support/fargate";
import { factsForNode, lifecycleIgnoreChanges } from "@/lib/ownership";
import { parseImageRef } from "./support/image";

const MAX_REPLICAS = 1000;

/** Container ports a load balancer routes to `node`, ascending and distinct. */
function routedPorts(ctx: CompileContext, node: ResourceNode, spec: ContainerServiceSpec): { lb: ResourceNode; ports: number[] } | undefined {
  const lbs = dependencies(ctx, node, "load_balancer");
  const routed = lbs
    .map((lb) => ({
      lb,
      ports: [
        ...new Set(
          ((lb.spec as Partial<LoadBalancerSpec>).routes ?? [])
            .filter((r) => r.target === node.address)
            .map((r) => {
              const port = r.port ?? spec.port;
              if (port === undefined) throw new ComputeCompileError("invalid_spec", `${node.address} is routed by ${lb.address} but declares no port.`);
              return port;
            })
        ),
      ].sort((a, b) => a - b),
    }))
    .filter((r) => r.ports.length > 0);
  if (routed.length > 1) throw new ComputeCompileError("unsupported", `${node.address} is routed by more than one load balancer (${routed.map((r) => r.lb.address).join(", ")}).`);
  return routed[0];
}

export function compileEcsService(node: ResourceNode, ctx: CompileContext): TofuFragment {
  return compileNode(node, () => {
    const spec = specOf<ContainerServiceSpec>(node);
    const replicas = intField(node, spec.replicas, "replicas", 1, 0, MAX_REPLICAS);
    const label = tfLabel(node.address);
    const b = new Frag(node.address);

    const routed = routedPorts(ctx, node, spec);
    const t = emitTask(b, node, ctx, spec, routed?.ports ?? []);

    const dependsOn = [...t.prerequisites];
    const loadBalancer: Record<string, unknown>[] = [];
    let healthGrace: number | undefined;
    if (routed) {
      const multiple = routed.ports.length > 1;
      for (const port of routed.ports) {
        loadBalancer.push({
          target_group_arn: refOf(ctx, routed.lb.address, targetGroupAttribute(node.address, multiple ? port : undefined)),
          container_name: t.name,
          container_port: port,
        });
      }
      healthGrace = 60;
    }

    const name = cloudName(ctx.namePrefix, nodeName(node.address), 255);
    const ownedLifecycle = lifecycleIgnoreChanges({ resourceType: "aws_ecs_service", address: node.address, facts: factsForNode(node, ctx.nodes ? { nodes: ctx.nodes() } : undefined) });
    const service = b.resource("aws_ecs_service", label, {
      name,
      cluster: attr(t.cluster, "arn"),
      task_definition: attr(t.taskDefinition, "arn"),
      desired_count: replicas,
      launch_type: "FARGATE",
      ...(spec.platformVersion ? { platform_version: spec.platformVersion } : {}),
      deployment_minimum_healthy_percent: 100,
      deployment_maximum_percent: 200,
      deployment_circuit_breaker: [{ enable: true, rollback: true }],
      enable_execute_command: false,
      enable_ecs_managed_tags: true,
      propagate_tags: "SERVICE",
      wait_for_steady_state: false,
      ...(healthGrace !== undefined ? { health_check_grace_period_seconds: healthGrace } : {}),
      // An attached autoscaler owns desired_count after create; tofu must not revert it (PROD-LIFE-12).
      ...(ownedLifecycle ? { lifecycle: ownedLifecycle } : {}),
      network_configuration: [{ subnets: t.subnets, security_groups: [t.securityGroup], assign_public_ip: false }],
      ...(loadBalancer.length ? { load_balancer: loadBalancer } : {}),
      depends_on: dependsOn,
      tags: tagsFor(ctx, node, name),
    });
    b.expose("arn", attr(service, "arn"));
    b.expose("name", attr(service, "name"));
    return b.build(service);
  });
}

/* --------------------------------- expected ------------------------------- */

/** Image the manifest pins, when it pins one; built images are not a desired attribute. */
export function pinnedImage(spec: ContainerServiceSpec): string | undefined {
  return spec.artifact?.type === "image" ? parseImageRef(spec.artifact.ref).ref : undefined;
}

export function expectedEcsService(node: ResourceNode): Record<string, unknown> {
  const spec = specOf<ContainerServiceSpec>(node);
  const size = fargateSize(spec.vcpu, spec.memoryMb);
  const image = pinnedImage(spec);
  return {
    replicas: spec.replicas,
    cpu: size.cpu,
    memoryMb: size.memoryMb,
    launchType: "FARGATE",
    assignPublicIp: false,
    ...(spec.port !== undefined ? { port: spec.port } : {}),
    ...(image !== undefined ? { image } : {}),
  };
}
