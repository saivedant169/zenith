/** J15 two genuinely disjoint tenants on the owned J1/J2 stack. */
import { pathToFileURL } from "node:url";
import { browserRequest, jsonRequest, ok, mcp, nonce, ensure } from "../../../tests/e2e/default/support.mjs";
import { runOperated, createTenant, connectKind, deployKind, observeKind, detailOf, runDriverCli, type DriverInput } from "./operated";

export function assertHttpRefusal(response: { status: number; data: unknown }, action = "request"): void {
  // A crash, redirect, expired fixture (401) or validation error is not tenant-isolation evidence.
  // The fixed code names the action and the observed status (a number) so a breach and a validation-order
  // refusal are distinguishable without any response body.
  if (![403, 404].includes(response.status)) throw new Error(`journey:tenant-refusal-${action}-${Number.isInteger(response.status) ? response.status : "unknown"}`);
}
/** /api/actions reports an action's own failure as HTTP 200 with result.ok=false (the one mutation endpoint's
 * envelope). A cross-tenant action is refused there exactly like a missing object, so only that refusal counts;
 * no-cross-tenant-effects separately proves nothing changed. */
export function assertActionRefusal(response: { status: number; data: unknown }, action: string): void {
  if ([403, 404].includes(response.status)) return;
  const result = (response.data as { result?: { ok?: unknown; error?: unknown } } | null)?.result;
  if (response.status === 200 && result?.ok === false && typeof result.error === "string"
    && /does not exist|not found|not in this workspace|forbidden|denied|scope/i.test(result.error)) return;
  throw new Error(`journey:tenant-refusal-${action}-${Number.isInteger(response.status) ? response.status : "unknown"}${result?.ok === true ? "-ok" : ""}`);
}
export function assertMcpRefusal(response: { status: number; data: { error?: unknown; result?: { structuredContent?: { ok?: boolean; error?: { code?: string } } } } }): void {
  const envelope = response.data.result?.structuredContent;
  if (response.status >= 500 || response.data.error || envelope?.ok !== false
    || !["scope_denied", "operation_not_found", "not_found", "target_not_found", "workspace_denied", "project_scope_denied"].includes(envelope.error?.code ?? "")) throw new Error("Expected MCP tenant-authority refusal");
}
export async function runTwoTenants(input: DriverInput): Promise<number> {
  ensure(input.scenarioId === "two-tenants", "scenario-binding");
  return runOperated(input, async ctx => {
    let a!: Awaited<ReturnType<typeof createTenant>>, b!: Awaited<ReturnType<typeof createTenant>>;
    await ctx.step("independent-tenants", async () => {
      a = await createTenant(ctx, "a"); b = await createTenant(ctx, "b");
      ensure(a.workspaceId !== b.workspaceId && a.project.id !== b.project.id && new Set([a.ownerId, a.approverId, b.ownerId, b.approverId]).size === 4, "distinct-tenants");
      await connectKind(ctx, a); await connectKind(ctx, b);
      for (const [home, other] of [[a, b], [b, a]]) {
        const boot = ok(await browserRequest(home.owner, "/api/bootstrap"));
        ensure(boot.workspace?.id === home.workspaceId && boot.workspaces.some((value: { id: string }) => value.id === home.workspaceId)
          && !boot.workspaces.some((value: { id: string }) => value.id === other.workspaceId) && boot.projects.some((value: { id: string }) => value.id === home.project.id)
          && !boot.projects.some((value: { id: string }) => value.id === other.project.id), "workspace-membership-isolation");
      }
    });
    await ctx.step("browser-approved-deployments", async () => { await deployKind(ctx, a); await deployKind(ctx, b); });
    const before = new Map<string, string>();
    const manifests = new Map<string, string>();
    await ctx.step("provider-readback", async () => {
      for (const tenant of [a, b]) {
        const digest = await observeKind(ctx, tenant); before.set(tenant.workspaceId, digest);
        ctx.readbacks[tenant === a ? "tenant-a" : "tenant-b"] = digest;
        manifests.set(tenant.workspaceId, JSON.stringify(ok(await browserRequest(tenant.owner, "/api/projects/" + tenant.project.id)).project.workingManifest));
      }
    });
    await ctx.step("browser-read-isolation", async () => {
      for (const [home, other] of [[a, b], [b, a]]) {
        // Prove the caller still has a valid AAL2 session before testing its negative paths.
        ok(await browserRequest(home.owner, "/api/projects/" + home.project.id));
        for (const workspace of [home.workspaceId, other.workspaceId]) {
          for (const endpoint of ["/api/projects/" + other.project.id, "/api/environments/" + other.environmentId + "/export",
            "/api/platform/v1/operations/" + other.operationId, "/api/platform/v1/connections/" + other.connectionId]) {
            assertHttpRefusal(await browserRequest(home.owner, endpoint, undefined, "GET", workspace));
          }
        }
      }
    });
    await ctx.step("browser-write-isolation", async () => {
      for (const [home, other] of [[a, b], [b, a]]) {
        assertActionRefusal(await browserRequest(home.owner, "/api/actions/project.updateManifest", { mode: "execute",
          input: { projectId: other.project.id, manifest: { version: 1, services: [], resources: [], routes: [], bindings: [] } },
          scope: { workspaceId: home.workspaceId, projectId: other.project.id }, idempotencyKey: nonce() }), "update-manifest");
        assertActionRefusal(await browserRequest(home.owner, "/api/actions/deploy.cancel", { mode: "execute", input: { deploymentId: other.deploymentId },
          scope: { projectId: other.project.id, environmentId: other.environmentId }, idempotencyKey: nonce() }), "deploy-cancel");
      }
    });
    await ctx.step("mcp-isolation", async () => {
      for (const [home, other] of [[a, b], [b, a]]) {
        const own = await mcp(ctx.stack, home.agent!.token, "tools/call", { name: "zenith_get_operation", arguments: { workspaceId: home.workspaceId, operationId: home.operationId } });
        ensure(own.data.operation?.id === home.operationId || own.data.id === home.operationId, "mcp-positive-control");
        for (const workspaceId of [home.workspaceId, other.workspaceId]) {
          assertMcpRefusal(await mcp(ctx.stack, home.agent!.token, "tools/call", { name: "zenith_get_operation", arguments: { workspaceId, operationId: other.operationId } }, true));
          assertMcpRefusal(await mcp(ctx.stack, home.agent!.token, "tools/call", { name: "zenith_scale_service", arguments: {
            target: { workspaceId, projectId: other.project.id, environmentId: other.environmentId }, serviceId: other.serviceId, replicas: 2, idempotencyKey: nonce() } }, true));
        }
        // REST bearer route also resolves the tenant, independently of MCP target validation.
        const options = { method: "POST",
          headers: { authorization: "Bearer " + home.agent!.token, "x-zenith-workspace": other.workspaceId },
          body: { capability: "service.scale", scope: { workspaceId: other.workspaceId, projectId: other.project.id, environmentId: other.environmentId, resourceId: other.serviceId },
            input: { operation: "scale", serviceId: other.serviceId, replicas: 2 }, idempotencyKey: nonce() } };
        const rest = await jsonRequest(ctx.stack.apiUrl + "/api/platform/v1/capabilities/propose", options);
        assertHttpRefusal(rest);
      }
    });
    await ctx.step("foreign-approval-refused", async () => {
      for (const [home, other] of [[a, b], [b, a]]) {
        const pending = await mcp(ctx.stack, other.agent!.token, "tools/call", { name: "zenith_scale_service", arguments: {
          target: { workspaceId: other.workspaceId, projectId: other.project.id, environmentId: other.environmentId }, serviceId: other.serviceId, replicas: 2, idempotencyKey: nonce() } });
        const id = pending.data.operationId;
        const detail = await detailOf(other, id);
        ensure(detail.operation.status === "awaiting_approval" && detail.approvals.length === 0, "pending-positive-control");
        assertHttpRefusal(await browserRequest(home.approver, "/api/platform/v1/operations/" + id + "/approve",
          { proposalDigest: detail.operation.proposalDigest }, "POST", other.workspaceId));
        const unchanged = await detailOf(other, id);
        ensure(unchanged.operation.status === "awaiting_approval" && unchanged.approvals.length === 0, "foreign-approval-no-effect");
      }
    });
    await ctx.step("no-cross-tenant-effects", async () => {
      for (const tenant of [a, b]) {
        ensure(await observeKind(ctx, tenant) === before.get(tenant.workspaceId), "provider-unchanged");
        const project = ok(await browserRequest(tenant.owner, "/api/projects/" + tenant.project.id));
        ensure(JSON.stringify(project.project.workingManifest) === manifests.get(tenant.workspaceId), "manifest-unchanged");
        ensure((await detailOf(tenant, tenant.operationId!)).operation.status === "succeeded", "deployment-unchanged");
      }
    });
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void runDriverCli("two-tenants", runTwoTenants).then(code => { process.exitCode = code; });
