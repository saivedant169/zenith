/**
 * Default machine port: workspace-scoped observations and zenithd registrations,
 * durable evidence/dispatch deduplication, and the existing signed runner queue.
 * Cloud driver selection and broker sessions remain in the execution activity;
 * no privilege, policy bypass, cloud credential or eager signer is added here.
 * Transport acceptance is contract-tested only, never live-verified.
 */
import { repos } from "@/lib/controlplane/db";
import type { Sql } from "@/lib/controlplane/types";
import type { MachineExecutionPort } from "@/lib/execution/ports";
import { StepFailedError } from "@/lib/execution/errors";
import { createPlatformRunnerStore } from "@/lib/runners/db/pg-store";
import { getRunnerRuntime } from "@/lib/runners/runtime";
import { MachineOperationError } from "./errors";
import { createRunnerMachineDispatcher } from "./dispatcher";
import { createMachineEvidenceSink, machineResultSealer } from "./persistence";

export function createDefaultMachinePort(db: Sql, secretKey: string): MachineExecutionPort {
  const store = createPlatformRunnerStore(db);
  // Unbound dispatcher tracks only ids it enqueues; no cross-tenant await oracle.
  const dispatcher = async () => createRunnerMachineDispatcher({ ...await getRunnerRuntime(), store });
  const scopes = new Map<string, string>();
  return {
    latestObservation: (ws, resourceId) => repos.observations.latestObservation(db, ws, resourceId),
    async boundMachine(ws, environmentId, address) {
      const matches = (await store.machines.list(ws)).filter((m) => m.environmentId === environmentId && m.address === address);
      const active = matches.filter((m) => m.status === "active");
      const allRevoked = matches.length > 0 && matches.every((m) => m.status === "revoked");
      if (active.length > 1 || (!active.length && matches.length > 1 && !allRevoked)) throw new StepFailedError("Multiple registered machines bind this resource; an operator must resolve the ambiguity.");
      // A revoked registration cannot mask its active replacement. With no
      // replacement, return the revoked binding so execution refuses fallback;
      // when every binding is revoked the refusal is the same, so the latest registration is returned.
      return active[0] ?? [...matches].sort((x, y) => y.registeredAt.localeCompare(x.registeredAt))[0] ?? null;
    },
    evidence: createMachineEvidenceSink(db, machineResultSealer(secretKey)),
    dispatcher: {
      async enqueue(req, grantJws) {
        const id = await (await dispatcher()).enqueue(req, grantJws);
        scopes.set(id, req.target.workspaceId);
        return id;
      },
      async await(id, signal) {
        const ws = scopes.get(id);
        if (!ws) throw new MachineOperationError("invalid_request", "the machine dispatcher cannot await an unknown request");
        const runtime = { ...await getRunnerRuntime(), store };
        try { return await createRunnerMachineDispatcher(runtime, ws).await(id, signal); }
        finally { scopes.delete(id); }
      },
    },
  };
}
