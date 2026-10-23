/** Execution integration with fake transports: identity resolution, scoped grants and uncertainty. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApplicationFailure } from "@temporalio/activity";
import type { MachineExecutionPort, StoredResource } from "@/lib/execution/ports";
import { StepFailedError } from "@/lib/execution/errors";
import { MachineOperationError, type MachineOperation, type MachineRequest, type MachineTransport, type KubernetesMachineSession } from "@/lib/machines";
import type { AgentRecord } from "@/lib/runners/ports";
import type { AzureSession, CredentialRequest, GcpSession } from "@/lib/credentials/types";
import { MemoryEvidence } from "../machines/_helpers";
import { createWorld, NOW, type World } from "./fakes/world";
import { CANARY_GRANT, ENV, OP, WS } from "./fakes/fixtures";

const worlds: World[] = [];
const AZURE_VM = "/subscriptions/11111111-2222-3333-4444-555555555555/resourceGroups/app/providers/Microsoft.Compute/virtualMachines/host";
const GCP_VM = "projects/demo-project/zones/us-central1-a/instances/host";
afterEach(() => { worlds.splice(0).forEach((w) => w.dispose()); });

async function machineWorld(transport: MachineTransport, operation: MachineOperation = "machine.inspect", args: Record<string, unknown> = {}) {
  const w = createWorld({ op: { capability: operation, resourceId: "res-machine", status: "running", proposal: { capability: operation, scope: { workspaceId: WS, environmentId: ENV, resourceId: "res-machine" }, input: args, summary: "machine test", details: [], risk: "low" } } });
  worlds.push(w);
  const provider = transport === "kubernetes" ? "kubernetes" : transport === "azure_run_command" ? "azure" : transport === "gcp_os_management" ? "gcp" : "aws";
  const nativeType = provider === "kubernetes" ? "k8s:Pod" : provider === "azure" ? "azure:virtual_machine" : provider === "gcp" ? "gcp:compute_instance" : "aws:ec2_instance";
  const row: StoredResource = { id: "res-machine", workspaceId: WS, environmentId: ENV, address: "compute_instance/host", provider, nativeType, kind: "compute_instance", ownership: "managed", spec: {}, specDigest: "a".repeat(64), status: "active", dependsOn: [], origin: [], labels: {} };
  w.resources.rows.set(row.id, row);
  const evidence = new MemoryEvidence();
  const calls: { req: MachineRequest; session: unknown }[] = [];
  const binding: AgentRecord = { kind: "machine", id: "mac_fixture", workspaceId: WS, environmentId: ENV, address: row.address, status: "active", stale: false, name: "fake host", protocol: "zenith.machine/v1", publicKey: "public", capabilities: [operation], labels: {}, host: {}, registeredAt: NOW };
  const plane: MachineExecutionPort = {
    latestObservation: vi.fn(async () => ({ address: row.address, externalId: provider === "kubernetes" ? "app/pod-1" : provider === "azure" ? AZURE_VM : provider === "gcp" ? GCP_VM : "i-0123456789abcdef0", presence: "present" as const, attributes: {}, observedAt: NOW, source: "fake", simulated: false })),
    boundMachine: vi.fn(async () => transport === "zenithd" ? binding : null),
    evidence,
    drivers: { [transport]: { transport, supports: [operation], execute: async (req: MachineRequest, session: unknown) => {
      calls.push({ req, session });
      return { ok: true, operation, transport, data: operation === "file.read" ? { path: "/srv/test", content: "file-content-canary", encoding: "utf8", bytesRead: 19, truncated: false } : operation === "system.logs" ? { content: "log-line-canary", lines: 1, truncated: false } : operation === "network.dnsCheck" ? { name: "app.example", recordType: "A", resolved: true, answers: ["10.1.2.3"] } : {}, startedAt: NOW, finishedAt: NOW, simulated: false };
    } } },
    kubernetes: { resolveCredential: async () => "fake-kubernetes-token" },
  };
  w.deps.machines = plane;
  if (transport === "kubernetes") w.connections.connections[0].config = { provider: "kubernetes", mode: "kubeconfig_ref", server: "https://cluster.example", credentialRef: "vault:cluster", namespaces: ["app"] };
  const lease = await w.lease();
  return { w, row, plane, evidence, calls, lease, binding };
}

describe("machine capability activities", () => {
  it.each(["azure_run_command", "gcp_os_management"] as const)("resolves %s observations and uses the matching brokered session", async (transport) => {
    const { w, calls, lease } = await machineWorld(transport);
    const provider = transport === "azure_run_command" ? "azure" : "gcp";
    w.product.base.environment.provider = provider;
    w.connections.connections[0].config = provider === "azure"
      ? { provider, mode: "oidc_web_identity", tenantId: "tenant", subscriptionId: "11111111-2222-3333-4444-555555555555", clientId: "client", region: "eastus" }
      : { provider, mode: "oidc_web_identity", projectId: "demo-project", region: "us-central1", workloadIdentityProvider: "projects/123/locations/global/workloadIdentityPools/test/providers/test", observeServiceAccount: "observe@demo-project.iam.gserviceaccount.com", deployServiceAccount: "deploy@demo-project.iam.gserviceaccount.com" };
    const requests: CredentialRequest[] = [];
    const session: AzureSession | GcpSession = provider === "azure"
      ? { provider, subscriptionId: "11111111-2222-3333-4444-555555555555", region: "eastus", expiresAt: "2099-01-01T00:00:00Z", authorizedFetch: vi.fn(), childProcessEnv: () => ({}) }
      : { provider, projectId: "demo-project", region: "us-central1", expiresAt: "2099-01-01T00:00:00Z", authorizedFetch: vi.fn(), childProcessEnv: () => ({}) };
    w.deps.credentials = { verifyConnection: vi.fn(), async withSession(req, fn) { requests.push(req); return fn(session); } };
    expect(await w.activities.executeCapability({ operationId: OP, lease })).toEqual({ ok: true, summary: "machine.inspect succeeded" });
    expect(calls[0].req.target).toMatchObject({ transport, targetId: provider === "azure" ? AZURE_VM : GCP_VM });
    expect(calls[0].session).toBe(session);
    expect(requests[0]).toMatchObject({ purpose: "observe", grant: { cap: "machine.inspect", ws: WS, res: "res-machine" } });
  });
  it("uses an observed EC2 id with an observe broker session and resource-scoped grant", async () => {
    const { w, calls, plane, lease, row } = await machineWorld("aws_ssm");
    expect(await w.activities.executeCapability({ operationId: OP, lease })).toEqual({ ok: true, summary: "machine.inspect succeeded" });
    expect(calls[0].req.target).toMatchObject({ workspaceId: WS, environmentId: ENV, resourceId: row.id, targetId: "i-0123456789abcdef0", transport: "aws_ssm" });
    expect(plane.latestObservation).toHaveBeenCalledWith(WS, row.id);
    expect(w.credentials.sessions.at(-1)).toMatchObject({ purpose: "observe", capability: "machine.inspect", revoked: true });
    expect(w.broker.grants.at(-1)).toMatchObject({ audience: "worker", fence: { scope: lease.scope, fenceToken: lease.fenceToken } });
  });
  it("uses deploy purpose for a machine mutation and passes normalized arguments", async () => {
    const { w, calls, lease } = await machineWorld("aws_ssm", "machine.service.restart", { unit: "nginx.service" });
    await w.activities.executeCapability({ operationId: OP, lease });
    expect(calls[0].req.args).toEqual({ unit: "nginx.service" });
    expect(w.credentials.sessions.at(-1)).toMatchObject({ purpose: "deploy", capability: "machine.service.restart" });
    expect(w.events.ofType("resource.applied")).toHaveLength(1);
  });
  it("resolves a pod and carries the connection's namespace allowlist inside a scoped Kubernetes session", async () => {
    const { w, calls, lease, plane } = await machineWorld("kubernetes", "container.list");
    await w.activities.executeCapability({ operationId: OP, lease });
    expect(calls[0].req.target).toMatchObject({ transport: "kubernetes", targetId: "app/pod-1" });
    expect(calls[0].req.args).toEqual({ all: false, limit: 100 });
    const session = calls[0].session as KubernetesMachineSession;
    expect(session.namespaces).toEqual(["app"]);
    expect(() => session.kubeConfig()).toThrow(/ended/);
    expect(w.credentials.sessions).toHaveLength(0);
    expect(JSON.stringify(plane.evidence)).not.toContain("fake-kubernetes-token");
  });
  it("resolves a registered resource binding and forwards its machine-audience grant to zenithd", async () => {
    const { w, calls, lease, plane } = await machineWorld("zenithd");
    await w.activities.executeCapability({ operationId: OP, lease });
    expect(calls[0].req.target).toMatchObject({ transport: "zenithd", targetId: "mac_fixture" });
    expect(calls[0].session).toEqual({ grantJws: CANARY_GRANT });
    expect(w.broker.grants.at(-1)?.audience).toBe("machine:mac_fixture");
    expect(plane.latestObservation).not.toHaveBeenCalled();
    expect(w.credentials.sessions).toHaveLength(0);
    expect(w.stored()).not.toContain(CANARY_GRANT);
  });
  it.each(["file.read", "system.logs", "network.dnsCheck"] as const)("%s evidence excludes contents, log lines and DNS answers", async (op) => {
    const args = op === "file.read" ? { path: "/srv/test" } : op === "network.dnsCheck" ? { name: "app.example" } : {};
    const { w, evidence, lease } = await machineWorld("aws_ssm", op, args);
    const out = await w.activities.executeCapability({ operationId: OP, lease });
    expect(evidence.records).toHaveLength(1);
    const serialized = JSON.stringify({ out, records: evidence.records });
    for (const value of ["file-content-canary", "log-line-canary", "10.1.2.3", CANARY_GRANT]) expect(serialized).not.toContain(value);
  });
  it("records and finalizes uncertainty with a non-retryable failure", async () => {
    const { w, plane, lease, evidence } = await machineWorld("zenithd", "machine.service.restart", { unit: "nginx.service" });
    plane.drivers!.zenithd!.execute = async () => { throw new MachineOperationError("uncertain", "agent silent", { transportRef: "mreq_fixture" }); };
    const err = await w.activities.executeCapability({ operationId: OP, lease }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApplicationFailure);
    expect(err).toMatchObject({ type: "MachineUncertain", nonRetryable: true });
    expect((await w.ops.get(OP))?.status).toBe("uncertain");
    expect(evidence.records[0].summary).toMatchObject({ outcome: "uncertain", transportRef: "mreq_fixture" });
    expect(w.events.ofType("resource.applied")).toHaveLength(0);
  });
  it("a machine health read stores a scoped telemetry envelope through the real activity (PROD-OBS-02)", async () => {
    const { w, lease, row } = await machineWorld("aws_ssm", "service.status", { unit: "nginx.service" });
    await w.activities.executeCapability({ operationId: OP, lease });
    const [record] = w.evidence.ofKind("observation");
    expect(record!.summary).toMatchObject({ kind: "machine_health", capability: "service.status", address: row.address, telemetry: { schemaVersion: 1, signal: "health", scope: { workspaceId: WS, environmentId: ENV, addresses: [row.address] } } });
    const telemetry = (record!.summary as { telemetry: { state: string; provenance: { source: string; provider: string }[] } }).telemetry;
    expect(["fresh", "stale"]).toContain(telemetry.state);
    expect(telemetry.provenance[0]).toMatchObject({ source: "machines.aws_ssm", provider: "aws" });
    expect(JSON.stringify(record)).not.toContain(CANARY_GRANT);
  });
  it("a refused machine health read is stored as an inaccessible envelope and still refuses the operation", async () => {
    const { w, plane, lease } = await machineWorld("aws_ssm", "machine.inspect");
    plane.drivers!.aws_ssm!.execute = async () => { throw new MachineOperationError("denied", "not permitted"); };
    await expect(w.activities.executeCapability({ operationId: OP, lease })).rejects.toBeInstanceOf(StepFailedError);
    const [record] = w.evidence.ofKind("observation");
    expect((record!.summary as { telemetry: { state: string } }).telemetry.state).toBe("inaccessible");
  });
  it.each([
    ["revoked", { status: "revoked" as const }, "inaccessible", /access denied/],
    ["silent", { stale: true }, "unknown", /unavailable/],
  ])("a health read of a %s bound zenithd stores an explicit envelope, dispatches nothing and still refuses", async (_case, over, state, reason) => {
    const { w, plane, calls, lease, binding, row } = await machineWorld("zenithd", "system.metrics");
    plane.boundMachine = async () => ({ ...binding, ...over });
    await expect(w.activities.executeCapability({ operationId: OP, lease })).rejects.toBeInstanceOf(StepFailedError);
    const [record] = w.evidence.ofKind("observation");
    const telemetry = (record!.summary as { telemetry: { state: string; scope: unknown; provenance: { source: string; provider: string; state: string; reason?: string }[] } }).telemetry;
    expect(record!.summary).toMatchObject({ kind: "machine_health", capability: "system.metrics", address: row.address });
    expect(telemetry.state).toBe(state);
    expect(telemetry.scope).toEqual({ workspaceId: WS, environmentId: ENV, addresses: [row.address] });
    expect(telemetry.provenance[0]).toMatchObject({ source: "machines.zenithd", provider: "zenithd", state });
    expect(telemetry.provenance[0].reason).toMatch(reason);
    expect(calls).toHaveLength(0); expect(w.broker.grants).toHaveLength(0);
  });
  it("refuses unknown observations and foreign/stale machine bindings before execution", async () => {
    const { w, plane, calls, lease, binding } = await machineWorld("zenithd");
    for (const invalid of [{ ...binding, workspaceId: "foreign" }, { ...binding, environmentId: "foreign" }, { ...binding, stale: true }, { ...binding, status: "revoked" as const }]) {
      plane.boundMachine = async () => invalid;
      await expect(w.activities.executeCapability({ operationId: OP, lease })).rejects.toBeInstanceOf(StepFailedError);
    }
    plane.boundMachine = async () => null;
    plane.latestObservation = async () => null;
    await expect(w.activities.executeCapability({ operationId: OP, lease })).rejects.toThrow(/unknown/);
    expect(calls).toHaveLength(0);
    expect(w.broker.grants).toHaveLength(0);
  });
  it("a ledger outage cannot make an uncertain dispatch retryable", async () => {
    const { w, plane, lease } = await machineWorld("zenithd", "machine.service.restart", { unit: "nginx.service" });
    plane.drivers!.zenithd!.execute = async () => { throw new MachineOperationError("uncertain", "agent silent"); };
    w.ops.markUncertain = async () => { throw new Error("ledger unavailable"); };
    await expect(w.activities.executeCapability({ operationId: OP, lease })).rejects.toMatchObject({ type: "MachineUncertain", nonRetryable: true });
    expect(w.logs.at(-1)?.message).toBe("could not persist machine uncertainty");
  });
  it("sandbox execution opens no credentials and labels evidence as simulated", async () => {
    const { w, plane, lease, evidence } = await machineWorld("aws_ssm");
    w.product.base.environment.class = "sandbox";
    plane.drivers = undefined;
    expect(await w.activities.executeCapability({ operationId: OP, lease })).toMatchObject({ ok: true, summary: "machine.inspect succeeded (simulated)" });
    expect(evidence.records[0].simulated).toBe(true);
    expect(w.credentials.sessions).toHaveLength(0);
  });
  it("refuses foreign resources, referenced mutations and mismatched grants", async () => {
    const { w, calls, lease, row } = await machineWorld("aws_ssm", "machine.service.restart", { unit: "nginx.service" });
    row.ownership = "referenced";
    await expect(w.activities.executeCapability({ operationId: OP, lease })).rejects.toThrow(/is referenced/);
    row.ownership = "managed"; row.workspaceId = "foreign";
    await expect(w.activities.executeCapability({ operationId: OP, lease })).rejects.toThrow(/not found/);
    row.workspaceId = WS;
    const original = w.broker.issueGrant.bind(w.broker);
    w.broker.issueGrant = async (...a) => { const g = await original(...a); return { ...g, claims: { ...g.claims, res: "foreign-resource" } }; };
    await expect(w.activities.executeCapability({ operationId: OP, lease })).rejects.toThrow(/grant_mismatch/);
    expect(calls).toHaveLength(0);
  });
});
