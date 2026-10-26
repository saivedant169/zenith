/**
 * GET /api/platform/v1/mixed/plans/:id
 *
 * The stored parent plan: each child's partition (provider, account, region, state
 * backend digest, connection identity digest, environment), its dependency order,
 * its stable resource addresses, its current execution state and, once it ran, its
 * durable receipt, and every dependency reference with the contract digest its consumer approval binds. Digests and ids
 * only; read-only.
 */
import { authorizeEnvironment, publicData } from "@/app/(product)/platform/_lib/read-models";
import { notFound } from "@/lib/capabilities/errors";
import * as plans from "@/lib/controlplane/db/repos/mixed-parent-plans";
import { referenceReadback } from "@/lib/execution/mixed/readback";
import { mixedDeps } from "@/lib/execution/mixed/runtime";
import { platformRoute } from "../../../_lib/http";
import { guarded } from "../../../_lib/mixed";
import { callerOf } from "../../../_lib/principal";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ID = /^[A-Za-z0-9_.:-]{1,128}$/;

export const GET = platformRoute<{ id: string }>(async (req, { id }) => {
  const caller = await callerOf(req);
  if (!ID.test(id)) throw notFound();
  const deps = await mixedDeps();
  const stored = await guarded(() => plans.getPlan(deps.sql, caller.workspaceId, id));
  if (!stored) throw notFound();
  await authorizeEnvironment({ workspaceId: caller.workspaceId, principal: caller.principal, surface: "rest" }, stored.plan.parentEnvironmentId, "infrastructure.observe");
  const [children, receipts] = await Promise.all([plans.listChildren(deps.sql, caller.workspaceId, id), plans.listReceipts(deps.sql, caller.workspaceId, id)]);
  return {
    body: publicData({
      parentPlanId: stored.plan.parentPlanId, status: stored.status, parentOperationId: stored.parentOperationId ?? null, parentEnvironmentId: stored.plan.parentEnvironmentId,
      parentDigest: stored.plan.parentDigest, desiredDigest: stored.plan.desiredDigest, childSetDigest: stored.plan.childSetDigest, executionOrder: stored.plan.executionOrder, teardownOrder: stored.plan.teardownOrder,
      // PROD-MIX-03: each reference's id, addresses, value type and the contract digest the consumer approval binds; digests and types only.
      references: referenceReadback(stored.plan),
      // PROD-MIX-05: what the approval bound, without vault references or identity digests; the live connectivity probe reads this.
      connectivity: stored.plan.connectivity ? {
        digest: stored.plan.connectivity.digest, vpnOptIn: stored.plan.connectivity.declaration.vpn?.optIn === true,
        endpoints: stored.plan.connectivity.declaration.endpoints.map((ep) => ({
          id: ep.id, producerPartitionId: ep.producerPartitionId, consumerPartitionId: ep.consumerPartitionId, dataClass: ep.dataClass, host: ep.host, port: ep.port,
          dnsTargets: ep.dns.expectedTargets, dnsTtlMaxSeconds: ep.dns.ttlMaxSeconds, tlsMinVersion: ep.tls.minVersion, serverNames: ep.tls.serverNames,
          serverSpkiSha256: ep.tls.serverSpkiSha256, clientCaDigest: ep.tls.clientCaDigest, allowlist: ep.allowlist,
        })),
      } : null,
      children: stored.plan.children.map((child) => {
        const row = children.find((candidate) => candidate.partitionId === child.partitionId);
        return {
          partitionId: child.partitionId, ordinal: child.ordinal, childEnvironmentId: child.childEnvironmentId, dependsOn: child.dependsOn, subplanDigest: child.subplanDigest,
          semanticsDigest: child.semanticsDigest, effectDigest: child.effectDigest, blockedByReferences: child.blockedByReferences,
          partition: { provider: child.authority.provider, accountId: child.authority.accountId, region: child.authority.region, backendKind: child.authority.backendKind,
            backendDigest: child.authority.backendDigest, connectionId: child.authority.connectionId, connectionIdentityDigest: child.authority.connectionIdentityDigest },
          nodes: child.nodes.map((node) => ({ stableAddress: node.stableAddress, address: node.address, kind: node.kind, specDigest: node.specDigest })),
          state: row?.state ?? "pending", childOperationId: row?.childOperationId ?? null, executableSemanticsDigest: row?.executableSemanticsDigest ?? null,
          receipt: receipts.find((receipt) => receipt.partitionId === child.partitionId) ?? null,
        };
      }),
    }),
  };
});
