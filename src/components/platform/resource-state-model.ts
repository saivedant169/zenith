/**
 * Desired, observed and runtime state side by side (ADR-0003), as pure data.
 *
 *   desired  - `ResourceNode.spec`, what the configuration asks for
 *   observed - `Observation`, what the provider's configuration API returned
 *   runtime  - `RuntimeState`, what is running right now
 *
 * The one rule this module exists to keep: an attribute nobody read is
 * UNKNOWN, never "matches". `compareAttributes` only ever reports `matches`
 * when the observed value is known AND the desired value exists AND they are
 * structurally equal. Everything else is `differs`, `observed_only` or
 * `not_observed`, and a `not_observed` cell always carries the reason.
 *
 * `import type` only from the contracts: no resources barrel, no drivers.
 */
import type {
  DriftFinding,
  DriftReport,
  Observation,
  ObservedValue,
  ResourceNode,
  RuntimeState,
} from "@/lib/resources/types";
import { flattenObject, humanizeToken, isSecretishPath, isSecretReference, sameValue, truncate } from "./text";

export interface ResourceStateRow {
  /** the stored resource's id: what a capability proposal names as `scope.resourceId` */
  id?: string;
  node: ResourceNode;
  /** absent until something has read the resource */
  observation?: Observation;
  runtime?: RuntimeState;
}

/* ------------------------------ unknown reasons ---------------------------- */

export type UnknownReason =
  | Extract<ObservedValue, { state: "unknown" }>["reason"]
  | "no_observation"
  | "not_read"
  | "resource_missing"
  | "resource_inaccessible";

export const UNKNOWN_REASON_SENTENCE: Record<UnknownReason, string> = {
  not_supported: "this provider's driver cannot read it",
  not_inspected: "Zenith did not read it in the last pass",
  access_denied: "the connected role is not allowed to read it",
  error: "reading it failed",
  not_applicable: "it does not apply to this kind of resource",
  no_observation: "nothing has read this resource yet",
  not_read: "the last observation did not include this attribute",
  resource_missing: "the resource does not exist at the provider",
  resource_inaccessible: "the connected role cannot see this resource",
};

/** "Not observed (the connected role is not allowed to read it)" - never blank. */
export function notObservedText(reason: UnknownReason, detail?: string): string {
  const base = `Not observed (${UNKNOWN_REASON_SENTENCE[reason]})`;
  return detail ? `${base}: ${truncate(detail, 160)}` : base;
}

/* -------------------------------- comparison ------------------------------- */

export type ObservedCell =
  | { state: "known"; value: unknown; observedAt: string }
  | { state: "unknown"; reason: UnknownReason; detail?: string };

export type AttributeStatus = "matches" | "differs" | "not_observed" | "observed_only";

export interface AttributeComparison {
  path: string;
  desired: { specified: true; value: unknown } | { specified: false };
  observed: ObservedCell;
  status: AttributeStatus;
}

const isPlain = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

function observedCell(path: string, obs: Observation | undefined): ObservedCell {
  if (!obs) return { state: "unknown", reason: "no_observation" };
  if (obs.presence === "missing") return { state: "unknown", reason: "resource_missing" };
  if (obs.presence === "inaccessible") return { state: "unknown", reason: "resource_inaccessible" };
  const attr = obs.attributes[path];
  if (!attr) return { state: "unknown", reason: "not_read" };
  if (attr.state === "known") return { state: "known", value: attr.value, observedAt: attr.observedAt };
  return { state: "unknown", reason: attr.reason, ...(attr.detail ? { detail: attr.detail } : {}) };
}

/**
 * One row per attribute that is either in the desired configuration or in the
 * observation, sorted by name. Desired values are the flattened `spec`; when the
 * observation names a whole top-level object attribute, that object is compared
 * as one value rather than as its parts.
 */
export function compareAttributes(node: ResourceNode, observation: Observation | undefined): AttributeComparison[] {
  const desired = new Map<string, unknown>(Object.entries(flattenObject(node.spec)));
  for (const key of Object.keys(observation?.attributes ?? {})) {
    if (key in node.spec && isPlain(node.spec[key])) {
      for (const d of [...desired.keys()]) if (d.startsWith(`${key}.`)) desired.delete(d);
      desired.set(key, node.spec[key]);
    } else if (!desired.has(key) && key in node.spec) {
      desired.set(key, node.spec[key]);
    }
  }
  const paths = new Set<string>([...desired.keys(), ...Object.keys(observation?.attributes ?? {})]);
  return [...paths]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((path): AttributeComparison => {
      const specified = desired.has(path);
      const cell = observedCell(path, observation);
      const d = specified ? ({ specified: true, value: desired.get(path) } as const) : ({ specified: false } as const);
      let status: AttributeStatus;
      if (cell.state === "unknown") status = "not_observed";
      else if (!specified) status = "observed_only";
      else status = sameValue(desired.get(path), cell.value) ? "matches" : "differs";
      return { path, desired: d, observed: cell, status };
    });
}

/** What a value looks like on screen: a masked marker for anything secret-looking. */
export function displayAttributeValue(path: string, value: unknown): { text: string; masked: boolean } {
  if (isSecretishPath(path) && !isSecretReference(value) && !(isPlain(value) && "secretRef" in value)) {
    return { text: "(sensitive)", masked: true };
  }
  if (isPlain(value) && typeof value.secretRef === "string") {
    return { text: `Secret reference ${truncate(value.secretRef, 120)}`, masked: false };
  }
  if (value === null) return { text: "null", masked: false };
  if (typeof value === "string") return { text: value === "" ? '""' : truncate(value, 200), masked: false };
  if (typeof value === "number" || typeof value === "boolean") return { text: String(value), masked: false };
  return { text: truncate(JSON.stringify(value) ?? "", 200), masked: false };
}

export interface ComparisonTally {
  matches: number;
  differs: number;
  notObserved: number;
  observedOnly: number;
}

export function tally(rows: readonly AttributeComparison[]): ComparisonTally {
  const t: ComparisonTally = { matches: 0, differs: 0, notObserved: 0, observedOnly: 0 };
  for (const r of rows) {
    if (r.status === "matches") t.matches++;
    else if (r.status === "differs") t.differs++;
    else if (r.status === "not_observed") t.notObserved++;
    else t.observedOnly++;
  }
  return t;
}

/* --------------------------------- runtime --------------------------------- */

/** "target_unhealthy:2" -> "2 load balancer targets are unhealthy". Unknown codes are humanized, never shown bare. */
export function describeSignal(code: string): string {
  const at = code.indexOf(":");
  const name = at === -1 ? code : code.slice(0, at);
  const arg = at === -1 ? "" : code.slice(at + 1);
  if (name === "target_unhealthy" && /^\d+$/.test(arg)) {
    const n = Number(arg);
    return `${n} load balancer ${n === 1 ? "target is" : "targets are"} unhealthy.`;
  }
  if (name === "task_stopped") return arg ? `A task stopped: ${truncate(arg, 120)}.` : "A task stopped.";
  const words = humanizeToken(name);
  return arg ? `${words}: ${truncate(arg, 120)}.` : `${words}.`;
}

export function describeCounts(counts: Record<string, number>): { label: string; value: number }[] {
  return Object.entries(counts)
    .filter(([, v]) => Number.isFinite(v))
    .map(([k, v]) => ({ label: humanizeToken(k), value: v }));
}

/* ----------------------------------- drift --------------------------------- */

const SEVERITY_RANK = { low: 1, medium: 2, high: 3 } as const;

export type DriftCell =
  | { kind: "finding"; finding: DriftFinding }
  | { kind: "not_checked" }
  | { kind: "none" };

/** The most severe finding per address, plus the unobserved set. */
export function driftLookup(report: DriftReport | undefined): (address: string) => DriftCell {
  const worst = new Map<string, DriftFinding>();
  for (const f of report?.findings ?? []) {
    const cur = worst.get(f.address);
    if (!cur || SEVERITY_RANK[f.severity] > SEVERITY_RANK[cur.severity]) worst.set(f.address, f);
  }
  const unobserved = new Set(report?.unobserved ?? []);
  return (address) => {
    const f = worst.get(address);
    if (f) return { kind: "finding", finding: f };
    if (unobserved.has(address)) return { kind: "not_checked" };
    return { kind: "none" };
  };
}
