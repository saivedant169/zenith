/** Default wiring and real store/queue contracts; all cloud responses are mocked. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { GetCommandInvocationCommand, ListCommandsCommand, SendCommandCommand, SSMClient } from "@aws-sdk/client-ssm";
import type { ConnectionConfig, CredentialBroker, CredentialRequest, ProviderConnection, ProviderSession, AzureSession, GcpSession } from "@/lib/credentials/types";
import type { CapabilityGrantClaims } from "@/lib/controlplane/types";
import type { ExecutionDeps, MachineExecutionPort } from "@/lib/execution/ports";
import { tempDataDir } from "../_support/data-dir";
import { awsSession, grantFor, requestFor, T0 } from "../machines/_helpers";
import { OUT } from "../machines/_ssm-output";

tempDataDir("zenith-machine-composition-", { fast: true });
const captured = vi.hoisted(() => ({ deps: undefined as ExecutionDeps | undefined }));
vi.mock("@/lib/execution", async (original) => {
  const execution = await original<typeof import("@/lib/execution")>();
  return { ...execution, createExecutionActivities: vi.fn((deps: ExecutionDeps) => { captured.deps = deps; return {}; }) };
});
const { openPlatformDb, repos } = await import("@/lib/controlplane/db");
const { composeExecutionActivities } = await import("@/lib/platform/execution");
const { createDefaultMachinePort } = await import("@/lib/machines/composition");
const { executeMachineOperation, createMachineDrivers, createMachineSessionProvider } = await import("@/lib/machines");
const { machineResultSealer, readMachineEvidenceBlob } = await import("@/lib/machines/persistence");
const { AZURE_WIRE_HEADER } = await import("@/lib/machines/transports/azure-scripts");
const { createPlatformRunnerStore } = await import("@/lib/runners/db/pg-store");
const { createPlane, issueGrant, registerFakeAgent, teardownPlane } = await import("../runners/_support");
const { POST: register } = await import("@/app/api/platform/v1/machines/register/route");
const { POST: poll } = await import("@/app/api/platform/v1/machines/[id]/poll/route");
const { POST: report } = await import("@/app/api/platform/v1/machines/[id]/jobs/[jti]/result/route");

const SECRET_KEY = "1".repeat(64);
const SUB = "11111111-2222-3333-4444-555555555555";
const VM = `/subscriptions/${SUB}/resourceGroups/app/providers/Microsoft.Compute/virtualMachines/host`;
const GCP_ID = "projects/demo-project/zones/us-central1-a/instances/host";
const ssm = mockClient(SSMClient);
let db: Awaited<ReturnType<typeof openPlatformDb>>;
let port: MachineExecutionPort;
beforeEach(async () => {
  db = await openPlatformDb({ kind: "pglite" });
  const { operation } = await repos.operations.create(db, { id: "op-1", workspaceId: "ws-1", principal: { kind: "user", id: "operator", name: "Mock operator" }, status: "approved", proposal: { capability: "machine.inspect", scope: { workspaceId: "ws-1", environmentId: "env-1", resourceId: "res-1" }, input: {}, summary: "Mocked machine operation", details: [], risk: "low" } });
  await repos.operations.claimForExecution(db, { workspaceId: operation.workspaceId, id: operation.id, expectedDigest: operation.proposalDigest, holder: "machine-contract" });
  composeExecutionActivities({ db, secretKey: SECRET_KEY, workerIdentity: "machine-contract", planDir: "unused" });
  port = captured.deps!.machines!;
  ssm.reset();
});
afterEach(async () => { ssm.reset(); teardownPlane(); vi.restoreAllMocks(); await db.close(); });

function broker(session: ProviderSession) {
  const requests: CredentialRequest[] = [];
  let active = false;
  const credentials: CredentialBroker = {
    async withSession(req, fn) { requests.push(req); active = true; try { return await fn(session); } finally { active = false; } },
    verifyConnection: vi.fn(),
  };
  return { credentials, requests, isActive: () => active };
}
function connection(provider: "aws" | "azure" | "gcp"): ProviderConnection {
  const config: ConnectionConfig = provider === "azure" ? { provider, mode: "oidc_web_identity", tenantId: SUB, subscriptionId: SUB, clientId: SUB, region: "eastus" } : provider === "gcp" ? { provider, mode: "oidc_web_identity", projectId: "demo-project", region: "us-central1", workloadIdentityProvider: "projects/123/locations/global/workloadIdentityPools/test/providers/test", observeServiceAccount: "zenith@demo-project.iam.gserviceaccount.com", deployServiceAccount: "zenith@demo-project.iam.gserviceaccount.com" } : { provider, mode: "aws_assume_role", accountId: "123456789012", region: "us-east-1", observeRoleArn: "arn:aws:iam::123456789012:role/observe", deployRoleArn: "arn:aws:iam::123456789012:role/deploy", externalId: "fixture" };
  return { id: "conn-1", workspaceId: "ws-1", status: "verified", config, createdAt: new Date(T0).toISOString(), createdBy: "operator" };
}
function run(req: ReturnType<typeof requestFor>, cloud: ReturnType<typeof broker>, provider: "aws" | "azure" | "gcp", constraints?: CapabilityGrantClaims["constraints"]) {
  return executeMachineOperation(req, {
    grant: grantFor(req.operation, { constraints }), evidence: port.evidence, signal: new AbortController().signal, now: () => new Date(T0),
    drivers: createMachineDrivers({ dispatcher: port.dispatcher, ssm: { sleep: async () => undefined }, azure: { sleep: async () => undefined } }),
    sessions: createMachineSessionProvider({ credentials: cloud.credentials, connection: connection(provider), grantJws: "synthetic-grant" }),
  });
}

describe("default machine composition", () => {
  it("supplies a machine port lazily and honors explicit overrides", () => {
    expect(port).toMatchObject({ latestObservation: expect.any(Function), boundMachine: expect.any(Function), evidence: { runOnce: expect.any(Function) }, dispatcher: { enqueue: expect.any(Function) } });
    const override = { ...port, latestObservation: vi.fn(async () => null) };
    composeExecutionActivities({ db, secretKey: SECRET_KEY, workerIdentity: "test", planDir: "unused", ports: { machines: override } });
    expect(captured.deps!.machines).toBe(override);
  });

  it("reads only tenant-scoped observations and reports unknown resources as null", async () => {
    const row = await repos.resources.upsertDesired(db, { workspaceId: "ws-1", environmentId: "env-1", node: { address: "compute_instance/web", kind: "compute_instance", provider: "aws", region: "us-east-1", nativeType: "aws:ec2_instance", ownership: "managed", spec: {}, specDigest: "a".repeat(64), dependsOn: [], origin: [], labels: {} } });
    const observation = { address: row.address, externalId: "i-0123456789abcdef0", presence: "present" as const, attributes: {}, observedAt: new Date(T0).toISOString(), source: "mock", simulated: false };
    await repos.observations.appendObservation(db, { workspaceId: "ws-1", resourceId: row.id, observation });
    expect(await port.latestObservation("ws-1", row.id)).toEqual(observation);
    expect(await port.latestObservation("foreign", row.id)).toBeNull();
    expect(await port.latestObservation("ws-1", "missing")).toBeNull();
  });

  it("runs AWS fixed documents inside the observe session and replays without another SDK call", async () => {
    ssm.on(ListCommandsCommand).resolves({ Commands: [] });
    ssm.on(SendCommandCommand).resolves({ Command: { CommandId: "command-mock" } });
    ssm.on(GetCommandInvocationCommand).resolves({ Status: "Success", ResponseCode: 0, StandardOutputContent: OUT.inspect });
    const cloud = broker(awsSession());
    const first = await run(requestFor("machine.inspect"), cloud, "aws");
    port = createDefaultMachinePort(db, SECRET_KEY); // process restart, same durable store
    expect(await run(requestFor("machine.inspect"), cloud, "aws")).toEqual(first);
    expect(first).toMatchObject({ ok: true, simulated: false, transport: "aws_ssm" });
    expect(ssm.commandCalls(SendCommandCommand)).toHaveLength(1);
    expect(cloud.requests).toHaveLength(1);
    expect(cloud.requests[0]).toMatchObject({ purpose: "observe", grant: { cap: "machine.inspect", ws: "ws-1", res: "res-1" } });
    expect(cloud.isActive()).toBe(false);
  });

  it("runs Azure mutations with deploy grants and persists only sealed redacted output", async () => {
    let command: Record<string, unknown> | undefined;
    const canary = "ghp_" + "x".repeat(36);
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      expect(cloud.isActive()).toBe(true);
      if (String(_url).split("?")[0].endsWith("/virtualMachines/host")) return Response.json({ location: "eastus", properties: { storageProfile: { osDisk: { osType: "Linux" } } } });
      if (init?.method === "PUT") { command = JSON.parse(String(init.body)); return Response.json({}, { status: 202 }); }
      if (!command) return Response.json({}, { status: 404 });
      const wire = AZURE_WIRE_HEADER + JSON.stringify({ stdout: Buffer.from(canary + " " + "ordinary output line\n".repeat(90)).toString("base64"), stderr: "", exitCode: 0, truncated: false, timedOut: false });
      return Response.json({ ...command, properties: { ...(command.properties as object), instanceView: { executionState: "Succeeded", exitCode: 0, output: wire } } });
    });
    const session: AzureSession = { provider: "azure", subscriptionId: SUB, region: "eastus", expiresAt: "2099-01-01T00:00:00Z", childProcessEnv: () => ({}), authorizedFetch: fetchImpl };
    const cloud = broker(session);
    const req = requestFor("machine.exec", { argv: ["echo", "fixture"], timeoutSec: 5 }, { transport: "azure_run_command", targetId: VM });
    const result = await run(req, cloud, "azure", { maxOutputBytes: 1024 });
    expect(result).toMatchObject({ ok: true, output: { truncated: true } });
    expect(Buffer.byteLength(result.output!.stdout) + Buffer.byteLength(result.output!.stderr)).toBeLessThanOrEqual(1024);
    expect(result.output!.stdout).not.toContain(canary);
    expect(cloud.requests[0]).toMatchObject({ purpose: "deploy", grant: { cap: "machine.exec" } });
    expect(await run(req, cloud, "azure", { maxOutputBytes: 1024 })).toEqual(result);
    expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1);
    const evidence = await repos.evidence.get(db, "ws-1", result.evidenceId!);
    expect(evidence?.blobRef).toMatch(/^machine-output:/);
    const artifact = await readMachineEvidenceBlob(db, machineResultSealer(SECRET_KEY), "ws-1", evidence!.blobRef!);
    expect(artifact).toContain("[REDACTED:github-token]");
    expect(artifact).not.toContain(canary);
    expect(await readMachineEvidenceBlob(db, machineResultSealer(SECRET_KEY), "foreign", evidence!.blobRef!)).toBeNull();
    const raw = await db.query("select response from platform.idempotency_keys where workspace_id = $1", ["ws-1"]);
    expect(JSON.stringify({ raw, evidence })).not.toContain(canary);
    expect(JSON.stringify({ raw, evidence })).not.toContain("ordinary output line");
  });

  it("uses GCP read-only cached inventory and refuses mutations before obtaining credentials", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      expect(cloud.isActive()).toBe(true);
      if (String(url).includes("compute.googleapis.com")) return Response.json({ id: "123456", name: "host", metadata: { secret: "excluded" } });
      return Response.json({ name: "projects/demo-project/locations/us-central1-a/instances/123456/inventory", updateTime: new Date(T0).toISOString(), osInfo: { hostname: "gcp-host", shortName: "ubuntu" }, items: { secret: "excluded" } });
    });
    const session: GcpSession = { provider: "gcp", projectId: "demo-project", region: "us-central1", expiresAt: "2099-01-01T00:00:00Z", childProcessEnv: () => ({}), authorizedFetch: fetchImpl };
    const cloud = broker(session);
    const req = requestFor("machine.inspect", {}, { transport: "gcp_os_management", targetId: GCP_ID });
    expect(await run(req, cloud, "gcp")).toMatchObject({ ok: true, data: { hostname: "gcp-host", inventory: { state: "available", observedAt: new Date(T0).toISOString() } } });
    expect(cloud.requests[0].purpose).toBe("observe");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await expect(run({ ...req, operation: "machine.service.restart", args: { unit: "nginx.service" } }, cloud, "gcp")).rejects.toMatchObject({ code: "unsupported_operation" });
    expect(cloud.requests).toHaveLength(1);
    expect(JSON.stringify(await repos.evidence.list(db, "ws-1"))).not.toContain("excluded");
  });

  it("resolves unique registered bindings and dispatches a signed zenithd request exactly once", async () => {
    const plane = await createPlane("real", {}, createPlatformRunnerStore(db));
    const agent = await registerFakeAgent(plane, register, { kind: "machine", workspaceId: "ws-1", capabilities: ["machine.inspect"], binding: { environmentId: "env-1", address: "compute_instance/web" } });
    expect(await port.boundMachine("ws-1", "env-1", "compute_instance/web")).toMatchObject({ id: agent.id, kind: "machine", stale: false });
    expect(await port.boundMachine("foreign", "env-1", "compute_instance/web")).toBeNull();
    expect(await port.boundMachine("ws-1", "foreign", "compute_instance/web")).toBeNull();
    const req = requestFor("machine.inspect", {}, { transport: "zenithd", targetId: agent.id });
    const claims = grantFor(req.operation, { aud: `machine:${agent.id}`, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 900 });
    const jws = await issueGrant(plane, claims);
    const credentials = { withSession: vi.fn(), verifyConnection: vi.fn() } as CredentialBroker;
    const execute = () => executeMachineOperation(req, { grant: claims, drivers: createMachineDrivers({ dispatcher: port.dispatcher }), sessions: createMachineSessionProvider({ credentials, grantJws: jws }), evidence: port.evidence, signal: new AbortController().signal });
    const pending = execute();
    let jobs: string[] = [];
    for (let i = 0; i < 100 && !jobs.length; i++) { jobs = (await agent.post(poll, "/poll", { max: 1, waitSec: 0 })).body.jobs as string[]; if (!jobs.length) await new Promise((resolve) => setTimeout(resolve, 5)); }
    expect(jobs).toHaveLength(1);
    const envelope = agent.decodeJob(jobs[0], agent.jobTyp());
    const id = String(envelope.claims.jti);
    expect(envelope.claims).toMatchObject({ grant: jws, operation: "machine.inspect", operationId: "op-1" });
    expect((await agent.post(report, `/jobs/${id}/result`, { status: "succeeded", result: { ok: true, operation: "machine.inspect", data: { hostname: "agent-host" } } }, {}, { jti: id })).status).toBe(200);
    const first = await pending;
    expect(first).toMatchObject({ ok: true, data: { hostname: "agent-host" }, transport: "zenithd" });
    expect(await execute()).toEqual(first);
    expect(await plane.store.machineRequests.listForOperation("ws-1", "op-1")).toHaveLength(1);
    expect(credentials.withSession).not.toHaveBeenCalled();
    expect(JSON.stringify(await repos.evidence.list(db, "ws-1"))).not.toContain(jws);
    const other = await registerFakeAgent(plane, register, { kind: "machine", workspaceId: "ws-1", binding: { environmentId: "env-1", address: "compute_instance/web" } });
    await expect(port.boundMachine("ws-1", "env-1", "compute_instance/web")).rejects.toMatchObject({ type: "StepFailed", nonRetryable: true });
    await plane.store.machines.revoke("ws-1", other.id);
    expect(await port.boundMachine("ws-1", "env-1", "compute_instance/web")).toMatchObject({ id: agent.id, status: "active" });
    // Every binding revoked: no ambiguity about the answer, which is a refusal of the revoked machine.
    await plane.store.machines.revoke("ws-1", agent.id);
    expect(await port.boundMachine("ws-1", "env-1", "compute_instance/web")).toMatchObject({ status: "revoked" });
  });
});
