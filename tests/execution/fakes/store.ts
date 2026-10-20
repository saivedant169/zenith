/**
 * In-memory platform-store ports for the execution tests.
 *
 * Faithful where it matters to the activities: fence tokens only ever increase,
 * a stale holder's fence fails `assertFence`, a repeated event/evidence id is
 * insert-or-return, ownership never changes through `upsertDesired`, every row is
 * workspace-scoped, and events/evidence/observations are run through the real
 * store's secret scanner (`assertNoSecretValues`) so a summary that would be
 * refused in production is refused here too.
 *
 * NOT faithful: there is no SQL, no real clock (time is `clock()`), and the
 * operation state machine is the simplified one the activities rely on. The real
 * adapters are tested separately against PGlite (platform.test.ts).
 */
import { assertNoSecretValues } from "@/lib/controlplane/db/secrets";
import { LeaseLostError, TERMINAL_OPERATION_STATUSES, type EvidenceRecord, type Lease, type OperationRecord, type OperationStatus, type PlatformEvent } from "@/lib/controlplane/types";
import type { ProviderConnection } from "@/lib/credentials/types";
import type { ConnectionsPort, EventsPort, EvidencePort, LeasesPort, NewEvidence, NewPlatformEvent, OperationsPort, ResourcesPort, ResourceStatusName, StoredResource } from "@/lib/execution/ports";
import type { DriftReport, Observation, ResourceNode, RuntimeState } from "@/lib/resources/types";
import type { LeaseRef } from "@/lib/workflows/types";
import { DEPLOYMENT, ENV, OP, PRODUCT_CONNECTION, PROJECT, REVISION, WS, providerConnection } from "./fixtures";

/* --------------------------------- events --------------------------------- */

export class FakeEvents implements EventsPort {
  readonly events: PlatformEvent[] = [];
  private seq = 0;
  async append(event: NewPlatformEvent): Promise<void> {
    assertNoSecretValues(event.data, "data");
    if (event.id && this.events.some((e) => e.id === event.id && e.workspaceId === event.workspaceId)) return;
    this.events.push({ ...event, id: event.id ?? `evt-${++this.seq}`, seq: ++this.seq, ts: "2026-09-30T00:00:00.000Z" } as PlatformEvent);
  }
  ofType(type: string): PlatformEvent[] {
    return this.events.filter((e) => e.type === type);
  }
}

/* -------------------------------- evidence -------------------------------- */

export class FakeEvidence implements EvidencePort {
  readonly rows: EvidenceRecord[] = [];
  /** make the next N appends fail (a ledger hiccup) */
  failNext = 0;
  async append(input: NewEvidence): Promise<EvidenceRecord> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("evidence store unavailable");
    }
    assertNoSecretValues(input.summary, "summary");
    if (!/^[0-9a-f]{64}$/.test(input.digest)) throw new Error("digest must be a 64-character hex SHA-256");
    if (input.id) {
      const existing = this.rows.find((r) => r.id === input.id && r.workspaceId === input.workspaceId);
      if (existing) return existing;
    }
    const row: EvidenceRecord = { ...input, id: input.id ?? `evd-${this.rows.length + 1}`, createdAt: "2026-09-30T00:00:00.000Z" };
    this.rows.push(row);
    return row;
  }
  async find({ workspaceId, operationId, kind, digest, stage }: Parameters<EvidencePort["find"]>[0]): Promise<EvidenceRecord | null> {
    return [...this.rows].reverse().find((r) => r.workspaceId === workspaceId && r.operationId === operationId && r.kind === kind && (digest === undefined || r.digest === digest) && (stage === undefined || r.summary.stage === stage)) ?? null;
  }
  ofKind(kind: EvidenceRecord["kind"]): EvidenceRecord[] {
    return this.rows.filter((r) => r.kind === kind);
  }
}

/* --------------------------------- leases --------------------------------- */

interface LeaseState {
  holder: string;
  fence: number;
  expired: boolean;
  released: boolean;
  workspaceId?: string;
}

export class FakeLeases implements LeasesPort {
  readonly state = new Map<string, LeaseState>();
  private readonly counters = new Map<string, number>();
  renewCalls = 0;
  /** what `renew` does: "ok", "lost" (returns null) or "throw" (store unreachable) */
  renewMode: "ok" | "lost" | "throw" = "ok";
  /** flip `renewMode` after this many renewals */
  lostAfterRenewals: number | undefined;
  acquireCalls: { scope: string; holder: string; workspaceId?: string; ttlMs: number }[] = [];
  readonly assertCalls: { scope: string; fenceToken: number }[] = [];

  /** Make the next acquire of `scope` return fence `next`, to match a real platform lease (its floor follows the recovery epoch). */
  startFenceAt(scope: string, next: number): void { this.counters.set(scope, next - 1); }

  async acquire(input: { scope: string; holder: string; ttlMs: number; workspaceId?: string }): Promise<Lease | null> {
    this.acquireCalls.push(input);
    const live = this.state.get(input.scope);
    if (live && !live.expired && !live.released && live.holder !== input.holder) return null;
    const fence = (this.counters.get(input.scope) ?? 0) + 1;
    this.counters.set(input.scope, fence);
    this.state.set(input.scope, { holder: input.holder, fence, expired: false, released: false, workspaceId: input.workspaceId });
    return { scope: input.scope, holder: input.holder, fenceToken: fence, acquiredAt: "2026-09-30T00:00:00.000Z", expiresAt: "2026-09-30T00:05:00.000Z" };
  }

  async renew(lease: LeaseRef, _ttlMs: number): Promise<Lease | null> {
    this.renewCalls++;
    if (this.lostAfterRenewals !== undefined && this.renewCalls > this.lostAfterRenewals) this.renewMode = "lost";
    if (this.renewMode === "throw") throw new Error("platform store unreachable");
    const s = this.state.get(lease.scope);
    if (this.renewMode === "lost" || !s || s.holder !== lease.holder || s.fence !== lease.fenceToken || s.expired || s.released) return null;
    return { ...lease, acquiredAt: "2026-09-30T00:00:00.000Z", expiresAt: "2026-09-30T00:05:00.000Z" };
  }

  async release(lease: LeaseRef): Promise<boolean> {
    const s = this.state.get(lease.scope);
    if (!s || s.holder !== lease.holder || s.fence !== lease.fenceToken || s.released) return false;
    s.released = true;
    return true;
  }

  async assertFence(scope: string, fenceToken: number): Promise<void> {
    this.assertCalls.push({ scope, fenceToken });
    const s = this.state.get(scope);
    if (!s || s.fence !== fenceToken || s.expired || s.released) throw new LeaseLostError(scope, fenceToken);
  }

  /** Another worker takes the scope: the old fence is dead. */
  steal(scope: string, holder = "worker:other:op-other"): number {
    const fence = (this.counters.get(scope) ?? 0) + 1;
    this.counters.set(scope, fence);
    this.state.set(scope, { holder, fence, expired: false, released: false });
    return fence;
  }

  expire(scope: string): void {
    const s = this.state.get(scope);
    if (s) s.expired = true;
  }
}

/* ------------------------------- operations ------------------------------- */

const LEGAL: Record<string, OperationStatus[]> = {
  approved: ["running", "cancelled", "expired"],
  queued: ["running", "cancelled", "expired"],
  running: ["awaiting_approval", "succeeded", "failed", "uncertain", "cancelled"],
  awaiting_approval: ["approved", "cancelled", "expired"],
};

export class FakeOps implements OperationsPort {
  readonly ops = new Map<string, OperationRecord>();
  readonly transitions: { operationId: string; to: string; error?: string }[] = [];
  readonly planDigests: string[] = [];
  readonly policyDecisions: string[] = [];
  readonly uncertain: { operationId: string; reason: string }[] = [];
  heartbeatResult = true;
  heartbeats = 0;
  /** make `transition` reject the next N calls (a store outage) */
  failTransitions = 0;

  constructor(private readonly events: FakeEvents) {}

  seed(over: Partial<OperationRecord> = {}): OperationRecord {
    const op: OperationRecord = {
      id: OP,
      workspaceId: WS,
      projectId: PROJECT,
      environmentId: ENV,
      capability: "deployment.deploy",
      principal: { kind: "user", id: "user-1", name: "Alice" },
      status: "approved",
      proposal: {
        capability: "deployment.deploy",
        scope: { workspaceId: WS, projectId: PROJECT, environmentId: ENV },
        input: { revisionId: REVISION, deploymentId: DEPLOYMENT },
        summary: "Deploy revision 1",
        details: [],
        risk: "high",
      },
      proposalDigest: "a".repeat(64),
      inputDigest: "b".repeat(64),
      approvalRequired: false,
      correlationId: "corr-act-1",
      createdAt: "2026-09-30T00:00:00.000Z",
      updatedAt: "2026-09-30T00:00:00.000Z",
      expiresAt: "2026-10-01T00:00:00.000Z",
      ...over,
    };
    this.ops.set(op.id, op);
    return op;
  }

  async get(operationId: string): Promise<OperationRecord | null> {
    return this.ops.get(operationId) ?? null;
  }

  async transition({ workspaceId, operationId, to, error }: { workspaceId: string; operationId: string; to: OperationStatus; error?: string }): Promise<OperationRecord | null> {
    if (this.failTransitions > 0) {
      this.failTransitions--;
      throw new Error("ledger unavailable");
    }
    const op = this.ops.get(operationId);
    if (!op || op.workspaceId !== workspaceId) return null;
    this.transitions.push({ operationId, to, ...(error ? { error } : {}) });
    if (op.status === to || TERMINAL_OPERATION_STATUSES.includes(op.status)) return op;
    if (!LEGAL[op.status]?.includes(to)) return op;
    const next: OperationRecord = { ...op, status: to, ...(error ? { error } : {}) };
    this.ops.set(op.id, next);
    const type = ({ running: "operation.started", succeeded: "operation.succeeded", failed: "operation.failed", uncertain: "operation.uncertain", cancelled: "operation.cancelled" } as Record<string, string>)[to];
    if (type) await this.events.append({ type: type as PlatformEvent["type"], workspaceId, projectId: op.projectId, environmentId: op.environmentId, operationId: op.id, correlationId: op.correlationId, data: {} });
    return next;
  }

  async markUncertain({ workspaceId, operationId, reason }: { workspaceId: string; operationId: string; reason: string }): Promise<OperationRecord | null> {
    this.uncertain.push({ operationId, reason });
    return this.transition({ workspaceId, operationId, to: "uncertain", error: reason });
  }

  async heartbeat(_input: { workspaceId: string; operationId: string }): Promise<boolean> {
    this.heartbeats++;
    return this.heartbeatResult;
  }

  async setPlanDigest({ operationId, planDigest }: { workspaceId: string; operationId: string; planDigest: string }): Promise<void> {
    this.planDigests.push(planDigest);
    const op = this.ops.get(operationId);
    if (op && !op.planDigest) this.ops.set(operationId, { ...op, planDigest });
  }

  async setPolicyDecision({ operationId, decisionId }: { workspaceId: string; operationId: string; decisionId: string }): Promise<void> {
    this.policyDecisions.push(decisionId);
    const op = this.ops.get(operationId);
    if (op) this.ops.set(operationId, { ...op, policyDecisionId: decisionId });
  }
}

/* -------------------------------- resources ------------------------------- */

export class FakeResources implements ResourcesPort {
  readonly rows = new Map<string, StoredResource>();
  readonly observations: { resourceId: string; observation: Observation }[] = [];
  readonly runtime = new Map<string, RuntimeState>();
  readonly reports: { workspaceId: string; report: DriftReport }[] = [];
  /** make observation writes for this address fail (a secret-shaped value, say) */
  rejectObservationFor: string | undefined;
  private n = 0;

  async upsertDesired({ workspaceId, projectId, environmentId, node, revisionId }: { workspaceId: string; projectId?: string; environmentId: string; node: ResourceNode; revisionId?: string }): Promise<StoredResource> {
    assertNoSecretValues(node.spec, "spec");
    const key = `${environmentId}|${node.address}`;
    const existing = this.rows.get(key);
    if (existing && existing.workspaceId !== workspaceId) throw Object.assign(new Error("Environment not found in this workspace."), { code: "tenant_mismatch" });
    if (existing && existing.ownership !== node.ownership) {
      throw Object.assign(new Error(`Resource ${node.address} is ${existing.ownership}; ownership never changes as a side effect of an update.`), { code: "conflict" });
    }
    const row: StoredResource = {
      id: existing?.id ?? `res-${++this.n}`,
      workspaceId,
      projectId,
      environmentId,
      address: node.address,
      kind: node.kind,
      provider: node.provider,
      region: node.region,
      nativeType: node.nativeType,
      ownership: node.ownership,
      externalId: existing?.externalId ?? node.externalRef,
      specDigest: node.specDigest,
      spec: node.spec,
      dependsOn: node.dependsOn,
      origin: node.origin,
      labels: node.labels,
      revisionId,
      status: existing?.status ?? "planned",
    };
    this.rows.set(key, row);
    return row;
  }

  async list(workspaceId: string, environmentId: string): Promise<StoredResource[]> {
    return [...this.rows.values()].filter((r) => r.workspaceId === workspaceId && r.environmentId === environmentId && r.status !== "deleted").sort((a, b) => (a.address < b.address ? -1 : 1));
  }

  async get(workspaceId: string, resourceId: string): Promise<StoredResource | null> {
    return [...this.rows.values()].find((r) => r.workspaceId === workspaceId && r.id === resourceId) ?? null;
  }

  async setStatus({ workspaceId, resourceId, status }: { workspaceId: string; resourceId: string; status: ResourceStatusName }): Promise<void> {
    const r = await this.get(workspaceId, resourceId);
    if (r) r.status = status;
  }

  async appendObservation({ workspaceId, resourceId, observation }: { workspaceId: string; resourceId: string; observation: Observation }): Promise<void> {
    if (!(await this.get(workspaceId, resourceId))) throw new Error("resource not found in this workspace");
    if (this.rejectObservationFor === observation.address) throw Object.assign(new Error("Refusing to store a secret-shaped value"), { code: "secret_material" });
    assertNoSecretValues(observation.attributes, "attributes");
    this.observations.push({ resourceId, observation });
  }

  async upsertRuntime({ workspaceId, resourceId, runtime }: { workspaceId: string; resourceId: string; runtime: RuntimeState }): Promise<void> {
    if (!(await this.get(workspaceId, resourceId))) throw new Error("resource not found in this workspace");
    this.runtime.set(resourceId, runtime);
  }

  async latestDriftReport(workspaceId: string, environmentId: string): Promise<DriftReport | null> {
    return [...this.reports].reverse().find((r) => r.workspaceId === workspaceId && r.report.environmentId === environmentId)?.report ?? null;
  }

  async saveDriftReport(input: { workspaceId: string; report: DriftReport }): Promise<void> {
    this.reports.push(input);
  }

  byAddress(address: string): StoredResource | undefined {
    return [...this.rows.values()].find((r) => r.address === address);
  }
}

/* ------------------------------- connections ------------------------------ */

export class FakeConnections implements ConnectionsPort {
  connections: ProviderConnection[] = [providerConnection()];
  async resolve({ workspaceId, connectionId }: { workspaceId: string; connectionId: string }): Promise<ProviderConnection | null> {
    return this.connections.find((c) => c.workspaceId === workspaceId && (c.id === connectionId || c.legacyConnectionId === connectionId) && c.status !== "revoked") ?? null;
  }
}

export { PRODUCT_CONNECTION };
