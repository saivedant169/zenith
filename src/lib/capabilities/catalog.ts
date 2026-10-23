/**
 * The semantic capability vocabulary (spec §13, §18, §20, §31).
 *
 * Authorization operates on these names — never on raw cloud APIs, shell
 * commands or product action ids. Every interface (UI, REST, CLI, MCP, the
 * Navigator, Codex/Claude connectors) asks the capability broker for one of
 * these, and every execution surface (Temporal activities, runners, zenithd)
 * refuses anything not named here.
 *
 * `risk` is the floor the policy engine starts from; policy may raise it
 * (production, stateful, public exposure) but never lower it.
 * `defaultAutonomy` is the minimum environment autonomy level (0–5, ADR-0007)
 * at which the capability may execute WITHOUT a human approval, before policy.
 * `escapeHatch` capabilities (machine.exec, container.exec, provider.native)
 * are never auto-approved at any autonomy level below 5 and are denied in
 * production unless a workspace policy explicitly enables them.
 */
import { z } from "zod";

export type CapabilityRisk = "low" | "medium" | "high" | "critical";

export interface CapabilityDef {
  name: string;
  title: string;
  /** does it change anything outside Zenith (cloud, workload, machine)? */
  mutates: boolean;
  risk: CapabilityRisk;
  /** minimum autonomy level for execution without approval (6 = never) */
  defaultAutonomy: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  /** may destroy data or availability; always surfaces a destructive warning */
  destructive?: boolean;
  /** unrestricted execution surface; strongest gates */
  escapeHatch?: boolean;
  /** which scope level the request must name */
  scopeLevel: "workspace" | "project" | "environment" | "resource";
  /** coarse credential scope an integration needs (compat with za_ scopes) */
  integrationScope: "read" | "plan" | "logs" | "write" | "publish";
}

const def = (d: CapabilityDef): CapabilityDef => d;

export const CAPABILITIES = {
  /* ---------------------------- observation ---------------------------- */
  "infrastructure.observe": def({ name: "infrastructure.observe", title: "Observe infrastructure", mutates: false, risk: "low", defaultAutonomy: 0, scopeLevel: "environment", integrationScope: "read" }),
  "topology.read": def({ name: "topology.read", title: "Read topology", mutates: false, risk: "low", defaultAutonomy: 0, scopeLevel: "project", integrationScope: "read" }),
  "logs.read": def({ name: "logs.read", title: "Read logs", mutates: false, risk: "low", defaultAutonomy: 0, scopeLevel: "environment", integrationScope: "logs" }),
  "metrics.read": def({ name: "metrics.read", title: "Read metrics", mutates: false, risk: "low", defaultAutonomy: 0, scopeLevel: "environment", integrationScope: "read" }),
  "traces.read": def({ name: "traces.read", title: "Read traces", mutates: false, risk: "low", defaultAutonomy: 0, scopeLevel: "environment", integrationScope: "read" }),
  "events.read": def({ name: "events.read", title: "Read events", mutates: false, risk: "low", defaultAutonomy: 0, scopeLevel: "environment", integrationScope: "read" }),
  "incident.investigate": def({ name: "incident.investigate", title: "Investigate an incident", mutates: false, risk: "low", defaultAutonomy: 0, scopeLevel: "environment", integrationScope: "read" }),
  "cost.estimate": def({ name: "cost.estimate", title: "Estimate cost", mutates: false, risk: "low", defaultAutonomy: 0, scopeLevel: "project", integrationScope: "read" }),
  "firewall.inspect": def({ name: "firewall.inspect", title: "Inspect firewall rules", mutates: false, risk: "low", defaultAutonomy: 0, scopeLevel: "environment", integrationScope: "read" }),

  /* ------------------------------ planning ----------------------------- */
  "connection.plan": def({ name: "connection.plan", title: "Plan a runner connection change", mutates: false, risk: "low", defaultAutonomy: 0, scopeLevel: "project", integrationScope: "plan" }),
  "infrastructure.plan": def({ name: "infrastructure.plan", title: "Plan an infrastructure change", mutates: false, risk: "low", defaultAutonomy: 1, scopeLevel: "environment", integrationScope: "plan" }),
  "placement.solve": def({ name: "placement.solve", title: "Solve placement", mutates: false, risk: "low", defaultAutonomy: 0, scopeLevel: "project", integrationScope: "plan" }),

  /* --------------------------- infrastructure -------------------------- */
  "infrastructure.apply": def({ name: "infrastructure.apply", title: "Apply an infrastructure plan", mutates: true, risk: "high", defaultAutonomy: 5, scopeLevel: "environment", integrationScope: "write" }),
  "infrastructure.destroy": def({ name: "infrastructure.destroy", title: "Destroy infrastructure", mutates: true, risk: "critical", defaultAutonomy: 6, destructive: true, scopeLevel: "environment", integrationScope: "write" }),
  "deployment.deploy": def({ name: "deployment.deploy", title: "Deploy a revision", mutates: true, risk: "high", defaultAutonomy: 4, scopeLevel: "environment", integrationScope: "write" }),
  "deployment.rollback": def({ name: "deployment.rollback", title: "Roll back a deployment", mutates: true, risk: "high", defaultAutonomy: 4, scopeLevel: "environment", integrationScope: "write" }),
  "drift.repair": def({ name: "drift.repair", title: "Repair drift", mutates: true, risk: "high", defaultAutonomy: 4, scopeLevel: "resource", integrationScope: "write" }),

  /* ----------------------------- day-two ops --------------------------- */
  "service.restart": def({ name: "service.restart", title: "Restart a service", mutates: true, risk: "medium", defaultAutonomy: 3, scopeLevel: "resource", integrationScope: "write" }),
  "service.scale": def({ name: "service.scale", title: "Scale a service", mutates: true, risk: "medium", defaultAutonomy: 3, scopeLevel: "resource", integrationScope: "write" }),
  "firewall.modify": def({ name: "firewall.modify", title: "Modify firewall rules", mutates: true, risk: "high", defaultAutonomy: 5, scopeLevel: "resource", integrationScope: "write" }),
  "dns.modify": def({ name: "dns.modify", title: "Modify DNS", mutates: true, risk: "high", defaultAutonomy: 5, scopeLevel: "resource", integrationScope: "write" }),
  "function.invoke": def({ name: "function.invoke", title: "Invoke a function", mutates: true, risk: "medium", defaultAutonomy: 4, scopeLevel: "resource", integrationScope: "write" }),
  "database.snapshot": def({ name: "database.snapshot", title: "Snapshot a database", mutates: true, risk: "low", defaultAutonomy: 3, scopeLevel: "resource", integrationScope: "write" }),
  "database.restore": def({ name: "database.restore", title: "Restore a database", mutates: true, risk: "critical", defaultAutonomy: 6, destructive: true, scopeLevel: "resource", integrationScope: "write" }),
  "database.delete": def({ name: "database.delete", title: "Delete a database", mutates: true, risk: "critical", defaultAutonomy: 6, destructive: true, scopeLevel: "resource", integrationScope: "write" }),
  "database.migrate": def({ name: "database.migrate", title: "Run database migrations", mutates: true, risk: "high", defaultAutonomy: 4, scopeLevel: "resource", integrationScope: "write" }),
  "secret.write": def({ name: "secret.write", title: "Write a secret reference", mutates: true, risk: "high", defaultAutonomy: 5, scopeLevel: "environment", integrationScope: "write" }),
  "identity.modify": def({ name: "identity.modify", title: "Modify identity/IAM", mutates: true, risk: "critical", defaultAutonomy: 6, scopeLevel: "environment", integrationScope: "write" }),

  /* ---------------------------- machine plane -------------------------- */
  "machine.inspect": def({ name: "machine.inspect", title: "Inspect a machine", mutates: false, risk: "low", defaultAutonomy: 0, scopeLevel: "resource", integrationScope: "read" }),
  "process.list": def({ name: "process.list", title: "List processes", mutates: false, risk: "low", defaultAutonomy: 0, scopeLevel: "resource", integrationScope: "read" }),
  "service.status": def({ name: "service.status", title: "Service status", mutates: false, risk: "low", defaultAutonomy: 0, scopeLevel: "resource", integrationScope: "read" }),
  "container.list": def({ name: "container.list", title: "List containers", mutates: false, risk: "low", defaultAutonomy: 0, scopeLevel: "resource", integrationScope: "read" }),
  "container.inspect": def({ name: "container.inspect", title: "Inspect a container", mutates: false, risk: "low", defaultAutonomy: 0, scopeLevel: "resource", integrationScope: "read" }),
  "container.logs": def({ name: "container.logs", title: "Container logs", mutates: false, risk: "low", defaultAutonomy: 0, scopeLevel: "resource", integrationScope: "logs" }),
  "file.read": def({ name: "file.read", title: "Read a file", mutates: false, risk: "medium", defaultAutonomy: 2, scopeLevel: "resource", integrationScope: "logs" }),
  "network.portCheck": def({ name: "network.portCheck", title: "Check a port", mutates: false, risk: "low", defaultAutonomy: 0, scopeLevel: "resource", integrationScope: "read" }),
  "network.dnsCheck": def({ name: "network.dnsCheck", title: "Check DNS resolution", mutates: false, risk: "low", defaultAutonomy: 0, scopeLevel: "resource", integrationScope: "read" }),
  "system.metrics": def({ name: "system.metrics", title: "System metrics", mutates: false, risk: "low", defaultAutonomy: 0, scopeLevel: "resource", integrationScope: "read" }),
  "system.logs": def({ name: "system.logs", title: "System logs", mutates: false, risk: "low", defaultAutonomy: 0, scopeLevel: "resource", integrationScope: "logs" }),
  "file.write": def({ name: "file.write", title: "Write a file", mutates: true, risk: "high", defaultAutonomy: 5, scopeLevel: "resource", integrationScope: "write" }),
  "file.upload": def({ name: "file.upload", title: "Upload a file", mutates: true, risk: "high", defaultAutonomy: 5, scopeLevel: "resource", integrationScope: "write" }),
  "package.install": def({ name: "package.install", title: "Install a package", mutates: true, risk: "high", defaultAutonomy: 5, scopeLevel: "resource", integrationScope: "write" }),
  "service.configure": def({ name: "service.configure", title: "Configure and converge a system service", mutates: true, risk: "high", defaultAutonomy: 5, scopeLevel: "resource", integrationScope: "write" }),
  "machine.service.restart": def({ name: "machine.service.restart", title: "Restart a system service", mutates: true, risk: "medium", defaultAutonomy: 4, scopeLevel: "resource", integrationScope: "write" }),
  "machine.exec": def({ name: "machine.exec", title: "Execute a command on a machine", mutates: true, risk: "critical", defaultAutonomy: 6, escapeHatch: true, scopeLevel: "resource", integrationScope: "write" }),
  "container.exec": def({ name: "container.exec", title: "Execute in a container", mutates: true, risk: "critical", defaultAutonomy: 6, escapeHatch: true, scopeLevel: "resource", integrationScope: "write" }),

  /* ------------------- data portability and adoption (LIFE-11) ------------------- */
  "data.export": def({ name: "data.export", title: "Export a data service to tenant-owned storage", mutates: true, risk: "high", defaultAutonomy: 5, scopeLevel: "resource", integrationScope: "write" }),
  "data.import": def({ name: "data.import", title: "Restore an export into a new data service", mutates: true, risk: "high", defaultAutonomy: 5, scopeLevel: "resource", integrationScope: "write" }),
  "resource.adopt": def({ name: "resource.adopt", title: "Adopt an existing resource under management", mutates: true, risk: "high", defaultAutonomy: 6, scopeLevel: "resource", integrationScope: "write" }),
  "resource.release": def({ name: "resource.release", title: "Release an adopted resource from management", mutates: true, risk: "high", defaultAutonomy: 6, scopeLevel: "resource", integrationScope: "write" }),

  /* ----------------------------- escape hatch -------------------------- */
  "provider.native": def({ name: "provider.native", title: "Provider-native resource change", mutates: true, risk: "critical", defaultAutonomy: 6, escapeHatch: true, scopeLevel: "environment", integrationScope: "write" }),
} as const satisfies Record<string, CapabilityDef>;

export type CapabilityName = keyof typeof CAPABILITIES;

export const CapabilityNameSchema = z.enum(Object.keys(CAPABILITIES) as [CapabilityName, ...CapabilityName[]]);

export function capability(name: string): CapabilityDef {
  const c = (CAPABILITIES as Record<string, CapabilityDef>)[name];
  if (!c) throw new Error(`Unknown capability "${name}".`);
  return c;
}

export const isCapability = (name: string): name is CapabilityName =>
  Object.prototype.hasOwnProperty.call(CAPABILITIES, name);

/**
 * The request every interface submits to the capability broker (spec §13).
 * The broker — not the model, not the client — decides the outcome.
 */
export const CapabilityRequestSchema = z
  .object({
    capability: CapabilityNameSchema,
    scope: z
      .object({
        workspaceId: z.string().min(1),
        projectId: z.string().min(1).optional(),
        environmentId: z.string().min(1).optional(),
        resourceId: z.string().min(1).optional(),
      })
      .strict(),
    /** capability-specific, validated again by the executing handler */
    input: z.unknown().optional(),
    /** narrowing the requester asks for, e.g. { maxLines: 500, window: "1h" } */
    constraints: z.record(z.string(), z.unknown()).optional(),
    /** how long a resulting grant should live, capped by policy (seconds) */
    requestedDurationSec: z.number().int().min(1).max(3600).optional(),
    /** why — shown to approvers; untrusted text */
    reason: z.string().max(2000).optional(),
    /** client-supplied idempotency key, scoped by workspace+principal+capability */
    idempotencyKey: z.string().min(8).max(200).optional(),
  })
  .strict();

export type CapabilityRequest = z.infer<typeof CapabilityRequestSchema>;
