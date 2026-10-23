/**
 * Shared server read models for platform pages and REST. Authorization precedes
 * SQL; every query names the workspace. Reads never probe or mutate a cloud.
 * Public values are bounded and redacted; missing observations stay missing.
 */
import type { Principal, Sql } from "@/lib/controlplane/types";
import type { ResourceNode, Observation, DriftReport } from "@/lib/resources/types";
import type { Investigation } from "@/lib/incidents/types";
import type { ResourceStateRow } from "@/components/platform/resource-state-model";
import { isSecretishPath, isSecretReference } from "@/components/platform/text";
import { platformBroker } from "@/lib/capabilities/platform";
import { BrokerError, isBrokerError, notFound } from "@/lib/capabilities/errors";
import { scrubSecrets } from "@/lib/capabilities/secret-guard";
import { scrubValue } from "@/lib/reconcile/redact";
import { platformDb, repos } from "@/lib/controlplane/db";

export interface ReadCaller { workspaceId: string; principal: Principal; surface?: "rest" | "ui" }
export const ENVIRONMENT_ID = /^[A-Za-z0-9_-]{1,200}$/;

/** Defense in depth for persisted external data, including secret-named keys. */
export function publicData<T>(value: T): T {
  let nodes = 0;
  const walk = (v: unknown, depth: number): unknown => {
    if (++nodes > 5000 || depth > 12) return "[truncated]";
    if (typeof v === "string") return scrubSecrets(scrubValue(v)).slice(0, 2048);
    if (Array.isArray(v)) return v.slice(0, 200).map((x) => walk(x, depth + 1));
    if (v === null || typeof v !== "object") return v;
    return Object.fromEntries(Object.entries(v).slice(0, 200).map(([key, child]) => [
      scrubSecrets(scrubValue(key)).slice(0, 512),
      isSecretishPath(key) && !isSecretReference(child) ? "[redacted]" : walk(child, depth + 1),
    ]));
  };
  return walk(value, 0) as T;
}

export async function authorizeEnvironment(caller: ReadCaller, environmentId: string, capability: "infrastructure.observe" | "incident.investigate") {
  if (!ENVIRONMENT_ID.test(environmentId)) throw notFound();
  const broker = await platformBroker();
  const authorization = await broker.authorizeRead({
    capability, scope: { workspaceId: caller.workspaceId, environmentId }, input: {},
  }, caller.principal, { audience: "platform-ui-read", ctx: { via: caller.surface ?? "rest" } });
  if (authorization.decision.outcome !== "allow") {
    throw new BrokerError("policy_denied", "Policy does not allow this read. Ask a workspace admin to review the policy.");
  }
}

function observationView(observation: Observation | null): Observation | undefined {
  if (!observation) return undefined;
  return {
    address: publicData(observation.address), presence: observation.presence,
    observedAt: observation.observedAt, source: publicData(observation.source), simulated: observation.simulated,
    attributes: Object.fromEntries(Object.entries(observation.attributes).slice(0, 200).map(([name, value]) => [
      publicData(name),
      value.state === "known" && ((isSecretishPath(name) && !isSecretReference(value.value)) || JSON.stringify(publicData(value.value)) !== JSON.stringify(value.value))
        ? { state: "unknown", reason: "not_inspected", detail: "Sensitive value withheld from this read view." }
        : publicData(value),
    ])),
    // Native responses, provider ids and raw errors are deliberately not a read DTO.
  };
}

export interface ResourcesView {
  environmentId: string; rows: ResourceStateRow[]; nextCursor?: string; evidence: "contract";
}

/** Fail closed instead of emitting an unbounded response or a broken typed DTO. */
export function boundedView<T>(value: T): T {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 1024 * 1024) throw new BrokerError("platform_store_unavailable", "The stored read view is too large to display safely. Narrow the read or ask an operator to inspect it.");
  return value;
}

/** Unexpected store failures are never sent to the generic request logger with raw error text. */
export async function safeRead<T>(read: () => Promise<T>): Promise<T> {
  try { return await read(); }
  catch (error) {
    if (isBrokerError(error)) throw error;
    throw new BrokerError("platform_store_unavailable", "Stored platform data could not be read. Restore the platform store, then retry.");
  }
}

export async function readResources(caller: ReadCaller, environmentId: string, limit = 100, cursor?: string): Promise<ResourcesView> {
  await authorizeEnvironment(caller, environmentId, "infrastructure.observe");
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new BrokerError("invalid_request", "limit must be between 1 and 200.");
  let after = "";
  if (cursor !== undefined) {
    if (!/^[A-Za-z0-9_-]{1,2800}$/.test(cursor)) throw new BrokerError("invalid_request", "The resource cursor is not valid.");
    after = Buffer.from(cursor, "base64url").toString("utf8");
    if (!after || after.length > 512 || Buffer.from(after).toString("base64url") !== cursor) throw new BrokerError("invalid_request", "The resource cursor is not valid.");
  }
  const sql = await platformDb();
  const records = await sql.query<{ id: string; node: ResourceNode }>(
    `select id, jsonb_build_object('address', address, 'kind', kind, 'provider', provider,
       'region', coalesce(region, ''), 'nativeType', native_type, 'ownership', ownership,
       'spec', spec, 'origin', origin, 'dependsOn', depends_on, 'specDigest', spec_digest,
       'labels', labels) as node
     from platform.resources where workspace_id = $1 and environment_id = $2
       and status <> 'deleted' and address > $3 order by address limit $4::bigint`,
    [caller.workspaceId, environmentId, after, limit + 1],
  );
  const rows: ResourceStateRow[] = [];
  // Bound query concurrency on the shared DB, as well as response size.
  for (let offset = 0; offset < Math.min(records.length, limit); offset += 20) {
    rows.push(...await Promise.all(records.slice(offset, Math.min(offset + 20, limit)).map(async ({ id, node }) => {
      const [observation, runtime] = await Promise.all([
        repos.observations.latestObservation(sql, caller.workspaceId, id),
        repos.observations.getRuntime(sql, caller.workspaceId, id),
      ]);
      const safeNode: ResourceNode = { ...publicData({ ...node, spec: {}, labels: {}, origin: [], dependsOn: [] }), spec: publicData(node.spec), labels: publicData(node.labels), origin: publicData(node.origin), dependsOn: publicData(node.dependsOn) };
      return { id, node: safeNode, observation: observationView(observation), runtime: runtime ? publicData(runtime) : undefined };
    })));
  }
  return boundedView({ environmentId, rows, evidence: "contract", ...(records.length > limit ? { nextCursor: Buffer.from(records[limit - 1].node.address).toString("base64url") } : {}) });
}

export interface DriftView { report: DriftReport | null; truncated: boolean; evidence: "contract" }
export async function readDrift(caller: ReadCaller, environmentId: string): Promise<DriftView> {
  await authorizeEnvironment(caller, environmentId, "infrastructure.observe");
  const report = await repos.drift.latest(await platformDb(), caller.workspaceId, environmentId);
  if (!report) return { report: null, truncated: false, evidence: "contract" };
  const safe: DriftReport = {
    environmentId, graphDigest: report.graphDigest, computedAt: report.computedAt, simulated: report.simulated,
    findings: report.findings.slice(0, 200).map((f) => ({ ...publicData({ ...f, fields: undefined }), fields: f.fields?.slice(0, 100).map((field) => ({
      attribute: publicData(field.attribute),
      desired: isSecretishPath(field.attribute) && !isSecretReference(field.desired) ? "[redacted]" : publicData(field.desired),
      observed: isSecretishPath(field.attribute) && !isSecretReference(field.observed) ? "[redacted]" : publicData(field.observed),
    })) })),
    unobserved: publicData(report.unobserved),
  };
  return boundedView({ report: safe, truncated: report.findings.length > 200 || report.unobserved.length > 200 || report.findings.some((f) => (f.fields?.length ?? 0) > 100), evidence: "contract" });
}

/**
 * An incident that needs a person. Zenith has no paging vendor: the escalation
 * is shown here, with an explicit state, until someone acknowledges it.
 */
export interface EscalationView {
  incidentId: string;
  title: string;
  severity: string;
  escalatedAt: string;
  reasons: string[];
  state: "unacknowledged" | "acknowledged";
  acknowledgedAt?: string;
}
export interface IncidentsView { investigations: Investigation[]; escalations: EscalationView[]; truncated: boolean; evidence: "contract" }
function investigationView(inv: Investigation): Investigation {
  const truncated = inv.path.length > 200 || inv.evidence.length > 200 || inv.hypotheses.length > 200 || inv.recentChanges.length > 200 || inv.hypotheses.some((h) => h.remediations.length > 50);
  return {
    ...publicData({ ...inv, path: [], evidence: [], hypotheses: [], recentChanges: [], notes: [] }),
    path: publicData(inv.path),
    evidence: inv.evidence.slice(0, 200).map((e) => ({ ...publicData({ ...e, data: {} }), data: publicData(e.data) })),
    hypotheses: inv.hypotheses.slice(0, 200).map((h) => ({
      ...publicData({ ...h, remediations: [] }),
      remediations: h.remediations.slice(0, 50).map((r) => ({
        ...publicData({ ...r, request: { ...r.request, input: undefined } }),
        request: { ...publicData({ ...r.request, input: undefined }), input: publicData(r.request.input) },
      })),
    })),
    recentChanges: publicData(inv.recentChanges),
    notes: [...publicData(inv.notes ?? []), ...(truncated ? ["This stored investigation is truncated for display; omitted evidence and options have not been assessed here."] : [])],
  };
}
export async function readIncidents(caller: ReadCaller, environmentId: string): Promise<IncidentsView> {
  await authorizeEnvironment(caller, environmentId, "incident.investigate");
  const sql: Sql = await platformDb();
  const rows = await sql.query<{ document: Investigation }>(
    `select document from platform.investigations where workspace_id = $1 and environment_id = $2
     order by started_at desc, id limit 21`, [caller.workspaceId, environmentId],
  );
  if (rows.some((r) => r.document.workspaceId !== caller.workspaceId || r.document.environmentId !== environmentId)) throw notFound();
  const escalated = await repos.incidentStability.listEscalations(sql, caller.workspaceId, { environmentId, limit: 20 });
  const escalations: EscalationView[] = escalated.map((i) => ({
    incidentId: i.id,
    title: publicData(i.title),
    severity: i.severity,
    escalatedAt: i.escalatedAt ?? i.updatedAt,
    reasons: publicData(i.escalationReasons),
    state: i.escalationAcknowledgedAt ? "acknowledged" : "unacknowledged",
    ...(i.escalationAcknowledgedAt ? { acknowledgedAt: i.escalationAcknowledgedAt } : {}),
  }));
  return boundedView({ investigations: rows.slice(0, 20).map((r) => investigationView(r.document)), escalations, truncated: rows.length > 20, evidence: "contract" });
}

/**
 * Data-service portability state (PROD-LIFE-11): verified exports, restores with
 * their independent readback verdicts, and adoption claims with the live drift of
 * the adopted object from its adoption baseline. Reads only stored rows and the
 * latest stored observation; nothing here touches a cloud or a data service.
 */
export interface PortabilityView {
  environmentId: string;
  exports: Awaited<ReturnType<typeof repos.portability.listExports>>;
  restores: Awaited<ReturnType<typeof repos.portability.listRestores>>;
  adoptions: (Awaited<ReturnType<typeof repos.portability.listAdoptions>>[number] & { baselineDrift: { attribute: string; kind: string }[] | null })[];
  truncated: boolean;
  evidence: "contract";
}
export async function readPortability(caller: ReadCaller, environmentId: string): Promise<PortabilityView> {
  await authorizeEnvironment(caller, environmentId, "infrastructure.observe");
  const sql = await platformDb();
  const [exports, restores, adoptions] = await Promise.all([
    repos.portability.listExports(sql, caller.workspaceId, environmentId, { limit: 50 }),
    repos.portability.listRestores(sql, caller.workspaceId, environmentId, { limit: 50 }),
    repos.portability.listAdoptions(sql, caller.workspaceId, environmentId, { limit: 100 }),
  ]);
  const withDrift = await Promise.all(adoptions.map(async (a) => {
    if (a.status !== "active") return { ...a, baselineDrift: null };
    const [resource, observation] = await Promise.all([
      repos.resources.get(sql, caller.workspaceId, a.resourceId),
      repos.observations.latestObservation(sql, caller.workspaceId, a.resourceId),
    ]);
    if (!resource || !observation || observation.presence !== "present") return { ...a, baselineDrift: null };
    const { compareToBaseline } = await import("@/lib/portability/adoption");
    const { factsForNode } = await import("@/lib/ownership");
    const drift = compareToBaseline({ attributes: (a.baseline.attributes ?? {}) as Record<string, unknown> }, observation.attributes, {
      nativeType: resource.nativeType, address: resource.address, facts: factsForNode({ address: resource.address, spec: resource.spec }),
    });
    // Attribute names and the kind of difference only: values stay in the stored observation, behind its own redaction.
    return { ...a, baselineDrift: drift.map((d) => ({ attribute: publicData(d.attribute), kind: d.kind })) };
  }));
  return boundedView({
    environmentId,
    exports: publicData(exports), restores: publicData(restores), adoptions: publicData(withDrift),
    truncated: exports.length >= 50 || restores.length >= 50 || adoptions.length >= 100,
    evidence: "contract",
  });
}
