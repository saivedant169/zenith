import { describe, expect, it, vi } from "vitest";
import { machineHealthTelemetry, readMachineHealth, type MachineDriver } from "@/lib/machines";
import { createZenithdMachineDriver } from "@/lib/machines/transports/zenithd";
import { DispatchError } from "@/lib/runners/dispatch";
import { grantFor, MemoryEvidence, okResult, requestFor, sessions, T0 } from "./_helpers";

const NOW = () => new Date(T0 + 1000);
const ctx = (driver: MachineDriver, grant = grantFor("service.status")) => ({
  grant,
  drivers: { aws_ssm: driver },
  sessions: sessions("session-object"),
  evidence: new MemoryEvidence(),
  signal: new AbortController().signal,
  now: NOW,
});
const driver = (over: Partial<MachineDriver> = {}): MachineDriver => ({
  transport: "aws_ssm",
  supports: ["service.status"],
  execute: async (req) => okResult(req, { transport: "aws_ssm" }, { unit: "nginx.service", loadState: "loaded", activeState: "active" }),
  ...over,
});

describe("machine health telemetry", () => {
  it("a successful read is fresh, scoped to the target address and labeled with its transport", async () => {
    const out = await readMachineHealth(requestFor("service.status", { unit: "nginx.service" }), ctx(driver()));
    expect(out.result?.ok).toBe(true);
    expect(out.telemetry).toMatchObject({ signal: "health", state: "fresh", partial: false });
    expect(out.telemetry.scope).toEqual({ workspaceId: "ws-1", environmentId: "env-1", addresses: ["compute_instance/web"] });
    expect(out.telemetry.provenance[0]).toMatchObject({ source: "machines.aws_ssm", provider: "aws", address: "compute_instance/web", state: "fresh", simulated: false });
  });

  it("a grant refusal is inaccessible, not healthy and not an exception", async () => {
    const execute = vi.fn(driver().execute);
    const context = ctx(driver({ execute }), grantFor("service.status", { ws: "other-ws" }));
    const out = await readMachineHealth(requestFor("service.status", { unit: "nginx.service" }), context);
    expect(out.result).toBeUndefined();
    expect(out.error?.code).toBe("grant_mismatch");
    expect(out.telemetry.state).toBe("inaccessible");
    expect(out.telemetry.provenance[0].reason).toContain("denied");
    expect(execute).not.toHaveBeenCalled();
    expect(context.sessions.opened).toBe(0);
    expect(context.evidence.records).toHaveLength(1);
    expect(context.evidence.records[0].summary).toMatchObject({ outcome: "rejected", code: "grant_mismatch" });
  });

  it("classifies both authority refusal codes without promoting ordinary read failures", () => {
    const req = requestFor("service.status", { unit: "nginx.service" });
    for (const code of ["denied", "grant_mismatch"]) {
      const telemetry = machineHealthTelemetry({ target: req.target, observedAt: NOW().toISOString(), error: { code, message: "read authority refused" } });
      expect(telemetry.state).toBe("inaccessible");
      expect(telemetry.provenance[0].itemCount).toBe(0);
      expect(telemetry.provenance[0].reason).toContain(`access denied: ${code}:`);
    }
    for (const code of ["unsupported_operation", "transport_error"]) {
      const telemetry = machineHealthTelemetry({ target: req.target, observedAt: NOW().toISOString(), error: { code, message: "the target could not be read" } });
      expect(telemetry.state).toBe("unknown");
      expect(telemetry.provenance[0].itemCount).toBe(0);
    }
  });

  it("an operation the transport does not support is unknown", async () => {
    const out = await readMachineHealth(requestFor("service.status", { unit: "nginx.service" }), ctx(driver({ supports: [] })));
    expect(out.error?.code).toBe("unsupported_operation");
    expect(out.telemetry.state).toBe("unknown");
  });

  it("a returned failed operation is unknown", () => {
    const req = requestFor("service.status", { unit: "x" });
    const result = { ...okResult(req, { transport: "aws_ssm" }), ok: false };
    const env = machineHealthTelemetry({ target: req.target, observedAt: new Date(T0).toISOString(), result });
    expect(env.state).toBe("unknown");
    expect(env.provenance[0].itemCount).toBe(0);
  });

  it("refuses non-health operations", async () => {
    await expect(readMachineHealth(requestFor("machine.exec", { command: "id" }), ctx(driver()))).rejects.toThrow(/not a read-only machine health operation/);
  });
});

describe("zenithd machine health through readMachineHealth", () => {
  const zenithd = (enqueue: () => Promise<string>) => ({
    grant: grantFor("system.metrics"),
    drivers: { zenithd: createZenithdMachineDriver({ dispatcher: { enqueue: vi.fn(enqueue), await: vi.fn() }, now: () => T0 }) },
    sessions: sessions({ grantJws: "inert-local-grant" }), evidence: new MemoryEvidence(), signal: new AbortController().signal, now: NOW,
  });
  const req = () => requestFor("system.metrics", {}, { transport: "zenithd", targetId: "mac_fixture" });
  it.each([
    ["a revoked machine is inaccessible", new DispatchError("agent_revoked", "The machine mac_fixture is revoked."), "inaccessible", "denied"],
    ["a silent machine is unknown", new DispatchError("agent_stale", "The machine has not sent a heartbeat for 90 seconds."), "unknown", "target_unreachable"],
    ["an unregistered machine is unknown", new DispatchError("agent_not_found", "No machine mac_fixture in this workspace."), "unknown", "target_unreachable"],
    ["any other queue failure stays an unknown transport error", new Error("store outage"), "unknown", "transport_error"],
  ])("%s, never healthy", async (_case, failure, state, code) => {
    const out = await readMachineHealth(req(), zenithd(async () => { throw failure; }));
    expect(out.result).toBeUndefined();
    expect(out.error?.code).toBe(code);
    expect(out.telemetry).toMatchObject({ signal: "health", state });
    expect(out.telemetry.provenance[0]).toMatchObject({ source: "machines.zenithd", provider: "zenithd", state });
    expect(out.telemetry.provenance[0].reason).toMatch(/\S/);
  });
});

