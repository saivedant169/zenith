/**
 * Zenith canonical domain model.
 *
 * The Manifest is the single source of truth for an application:
 * the System Map, the Source view, the REST API, and the Navigator agent
 * all read and write THIS structure through typed actions. There is no
 * second model — a visual state can never diverge from the deployed truth.
 *
 * Everything downstream imports these shapes, so this file adds types rather
 * than changing the meaning of an existing one.
 */
import { z } from "zod";
import type { AnyManifest } from "@/lib/resources/manifest-v2";
export type { AnyManifest } from "@/lib/resources/manifest-v2";

/* --------------------------- ids and fingerprints ------------------------- */

/**
 * Id minting and the non-cryptographic hashes live in `./hash` — they describe
 * no domain shape, and pulling one in should not pull in the whole model.
 * Re-exported here because this is where every caller already looks for them.
 */
export { id, fnv1a, hash32, contentHash } from "./hash";

/* ------------------------------- vocabulary ------------------------------ */

export const ServiceKind = z.enum(["web", "worker", "cron", "static"]);
export type ServiceKind = z.infer<typeof ServiceKind>;

export const ResourceKind = z.enum([
  "postgres",
  "redis",
  "object_store",
  "queue",
  "email",
]);
export type ResourceKind = z.infer<typeof ResourceKind>;

/** How Zenith relates to a node. Progressive adoption depends on this. */
export const Ownership = z.enum([
  "managed", // Zenith provisions and operates it
  "referenced", // exists in the customer cloud; Zenith reads state, never mutates
  "external", // documented only (e.g. a third-party API); no cloud presence
]);
export type Ownership = z.infer<typeof Ownership>;

export const ServiceSize = z.enum(["nano", "small", "standard", "performance"]);
export type ServiceSize = z.infer<typeof ServiceSize>;

/** What a binding grants. Determines injected config and network rules. */
export const BindingCapability = z.enum([
  "sql", // service -> postgres
  "cache", // service -> redis
  "blob", // service -> object_store
  "queue_publish",
  "queue_consume",
  "smtp", // service -> email
  "http", // route -> service, or service -> service
]);
export type BindingCapability = z.infer<typeof BindingCapability>;

/* --------------------------------- pieces -------------------------------- */

export const EnvVar = z.object({
  key: z.string().min(1),
  /** Exactly one of value / secretRef. Secrets never live in the manifest. */
  value: z.string().optional(),
  secretRef: z.string().optional(),
});
export type EnvVar = z.infer<typeof EnvVar>;

export const ServiceSource = z.discriminatedUnion("type", [
  z.object({ type: z.literal("image"), image: z.string().min(1) }),
  z.object({
    type: z.literal("git"),
    repo: z.string().min(1),
    ref: z.string().prefault("main"),
    dockerfile: z.string().optional(),
    /** build context subdirectory (monorepo root); honored only with the `contextDigest` from source inspection */
    contextDir: z.string().max(200).optional(),
    /** digest returned by source inspection for exactly this repo, commit, context and Dockerfile; build admission re-derives it */
    contextDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  }),
  z.object({ type: z.literal("blueprint"), blueprint: z.string() }),
]);
export type ServiceSource = z.infer<typeof ServiceSource>;

export const Service = z.object({
  id: z.string(),
  name: z
    .string()
    .regex(/^[a-z][a-z0-9-]{1,30}$/, "lowercase letters, digits, dashes"),
  kind: ServiceKind,
  source: ServiceSource,
  size: ServiceSize.prefault("small"),
  /** Explicit, visible default — cost implications are shown before deploy. */
  replicas: z.number().int().min(0).max(10).prefault(1),
  port: z.number().int().min(1).max(65535).optional(),
  healthPath: z.string().optional(),
  /** cron services only */
  schedule: z.string().optional(),
  env: z.array(EnvVar).max(500).prefault([]),
  ownership: Ownership.prefault("managed"),
});
export type Service = z.infer<typeof Service>;

export const Resource = z.object({
  id: z.string(),
  name: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/),
  kind: ResourceKind,
  /** kind-specific settings, validated by the catalog */
  config: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).prefault({}),
  size: ServiceSize.prefault("small"),
  ownership: Ownership.prefault("managed"),
  /** for `referenced` resources: the provider-side identifier */
  externalRef: z.string().optional(),
});
export type Resource = z.infer<typeof Resource>;

/**
 * A DNS hostname and nothing else. Strict on purpose: these strings are
 * interpolated into generated Terraform, Docker Compose and provider calls,
 * so a quote, a newline or a `${` here would be someone else's syntax. The
 * exporter escapes as well — this is the first of the two walls, not the only
 * one. Labels are 1-63 chars, alphanumeric with inner hyphens.
 */
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;
/** A URL path: leading slash, then unreserved characters only. */
const PATH_PREFIX = /^\/[A-Za-z0-9\-._~/]*$/;

export const Route = z.object({
  id: z.string(),
  /** hostname, e.g. app.example.com or auto-assigned sandbox host */
  host: z
    .string()
    .min(1)
    .regex(HOSTNAME, "Host must be a hostname like app.example.com — letters, digits, dots and hyphens only."),
  pathPrefix: z
    .string()
    .regex(PATH_PREFIX, "Path prefix must start with / and use letters, digits, - . _ ~ only.")
    .prefault("/"),
  tls: z.boolean().prefault(true),
  /** auto = Zenith-assigned host on the environment's base domain */
  managedDns: z.boolean().prefault(true),
});
export type Route = z.infer<typeof Route>;

export const Binding = z.object({
  id: z.string(),
  /** node ids: route or service */
  from: z.string(),
  /** node ids: service or resource */
  to: z.string(),
  capability: BindingCapability,
  /**
   * Human explanation rendered on the edge — bindings are always explained.
   * e.g. "api reads and writes orders in postgres/main"
   */
  note: z.string().optional(),
});
export type Binding = z.infer<typeof Binding>;

export const ManifestPolicies = z.object({
  /** deploys to this environment require explicit human approval */
  approvalRequired: z.boolean().prefault(false),
  budgetUsdMonthly: z.number().positive().optional(),
  /** the Navigator may not delete stateful resources, ever, unless true */
  allowStatefulDeletion: z.boolean().prefault(false),
});
export type ManifestPolicies = z.infer<typeof ManifestPolicies>;

/* -------------------------------- manifest ------------------------------- */

export const Manifest = z.object({
  version: z.literal(1),
  services: z.array(Service).max(500).prefault([]),
  resources: z.array(Resource).max(500).prefault([]),
  routes: z.array(Route).max(500).prefault([]),
  bindings: z.array(Binding).max(500).prefault([]),
});
export type Manifest = z.infer<typeof Manifest>;

export const emptyManifest = (): Manifest => ({
  version: 1,
  services: [],
  resources: [],
  routes: [],
  bindings: [],
});

/* ------------------------------ org entities ------------------------------ */

export const EnvironmentClass = z.enum(["sandbox", "staging", "production"]);
export type EnvironmentClass = z.infer<typeof EnvironmentClass>;

export const ProviderId = z.enum([
  "sandbox",
  "localstack",
  "aws",
  "kubernetes",
  "gcp",
  "azure",
  "zenith",
]);
export type ProviderId = z.infer<typeof ProviderId>;

export interface Workspace {
  id: string;
  /** The accountable owner; an admin member whose seat must be transferred explicitly. */
  ownerId?: string;
  name: string;
  slug: string;
  createdAt: string;
}

export interface Member {
  id: string;
  workspaceId: string;
  name: string;
  email: string;
  role: "admin" | "editor" | "viewer";
}

/**
 * An admin's standing offer for one email address to join the workspace.
 * Signing up is not joining: without an invite (or being the first real user)
 * a signed-in stranger is refused, not silently made an editor.
 */
export interface Invite {
  id: string;
  workspaceId: string;
  email: string;
  role: Member["role"];
  /** member id of the admin who created it */
  createdBy: string;
  createdAt: string;
  /** set the moment the invited email first signs in */
  acceptedAt?: string;
  /** New invitations expire after seven days; legacy entries may omit this. */
  expiresAt?: string;
  /** Revocation is retained so copied invitation links can explain their state. */
  revokedAt?: string;
}

export interface CloudConnection {
  id: string;
  workspaceId: string;
  provider: ProviderId;
  label: string;
  region: string;
  status: "connecting" | "healthy" | "degraded" | "disconnected";
  /** exact permission summary shown to the user */
  grantedPermissions: string[];
  /** Current provider-declared access; presenting this does not imply a live check. */
  declaredPermissions?: string[];
  createdAt: string;
  lastCheckedAt?: string;
  /**
   * The platform control store's `ProviderConnection` this record extends
   * (`platform.provider_connections`), when the account is connected keylessly
   * (ADR-0006). Absent for sandbox/LocalStack and for legacy Preview AWS
   * connections. The platform record carries the role ARNs and verification
   * state; this record stays what the product screens render. A pointer only:
   * never a credential.
   */
  platformConnectionId?: string;
  /** Set when an administrator revoked the platform connection (PROD-LIFE-01). Revocation is terminal. */
  revokedAt?: string;
}

export interface Project {
  id: string;
  workspaceId: string;
  name: string;
  slug: string;
  /** the editable working copy */
  workingManifest: AnyManifest;
  createdAt: string;
  /** how this project came to exist — shown in UI, used by importer */
  origin:
    | { type: "blank" }
    | { type: "blueprint"; blueprint: string }
    | { type: "import"; source: "compose" | "dockerfile" | "git" | "terraform" };
}

export interface Environment {
  id: string;
  projectId: string;
  name: string;
  class: EnvironmentClass;
  connectionId: string;
  region: string;
  /** revision currently live in this environment (undefined = never deployed) */
  deployedRevisionId?: string;
  policies: ManifestPolicies;
  /** base domain for managed routes, e.g. "atlas.zenith.test" */
  baseDomain: string;
  /**
   * The deployment that currently owns this environment — the lease. Only the
   * holder may commit `deployedRevisionId`, so a rollback that supersedes an
   * in-flight deploy cannot have its result overwritten by the runner it
   * replaced, whichever finishes last. Undefined when nothing is in flight.
   */
  activeDeploymentId?: string;
  createdAt: string;
}

export interface Revision {
  id: string;
  projectId: string;
  /** monotonically increasing per project */
  number: number;
  manifest: AnyManifest;
  message: string;
  author: Actor;
  createdAt: string;
  /**
   * Environment ids this revision was actually deployed to, appended when a
   * deployment succeeds. Recorded, never reconstructed by matching names.
   */
  deployedTo?: string[];
}

/* ------------------------------- deployments ------------------------------ */

export const DeploymentStatus = z.enum([
  "planning",
  "awaiting_approval",
  "applying",
  "verifying",
  "succeeded",
  "failed",
  "rolling_back",
  "rolled_back",
  "cancelled",
]);
export type DeploymentStatus = z.infer<typeof DeploymentStatus>;

export type StepStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface DeploymentStep {
  id: string;
  seq: number;
  /** phase grouping in the timeline UI */
  phase: "prepare" | "provision" | "release" | "verify";
  title: string;
  /** node this step concerns, for map highlighting; "" = whole system */
  targetId: string;
  status: StepStatus;
  startedAt?: string;
  endedAt?: string;
  /** provider-native detail, shown in the raw log toggle */
  detail?: string;
  error?: string;
}

export interface Output {
  key: string;
  label: string;
  value: string;
  kind: "url" | "hostname" | "connection" | "text";
  targetId?: string;
  /**
   * True when nothing outside Zenith exists behind this value — the sandbox
   * invented it. The UI must label a simulated output as such; an absent flag
   * means the provider did not say, which is not the same as "real".
   */
  simulated?: boolean;
}

export interface Deployment {
  id: string;
  projectId: string;
  environmentId: string;
  revisionId: string;
  status: DeploymentStatus;
  steps: DeploymentStep[];
  outputs: Output[];
  /** compact human summary of the changeset that produced it */
  changeSummary: string;
  estCostDeltaUsd: number;
  actor: Actor;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  error?: string;
  /** revision live before this deployment; rollback target */
  previousRevisionId?: string;
  /**
   * Who executes this deployment. Absent means `"engine"`: the in-process state
   * machine (`engine/engine.ts`) that runs sandbox and LocalStack. `"workflow"`
   * means a Temporal workflow owns it (ADR-0001, ADR-0009): the engine's
   * ticker, resume pass and lease logic must never touch it; the execution
   * worker projects step progress onto this record.
   */
  executor?: "engine" | "workflow";
  /** The platform operation (`platform.operations`) this deployment projects; set when `executor` is `"workflow"`. */
  operationId?: string;
  /** When the Temporal workflow was started for this deployment (absent while it is still waiting for an approval). */
  workflowStartedAt?: string;
}

/* --------------------------------- events --------------------------------- */

export type DeploymentEvent = {
  ts: string;
  deploymentId: string;
  seq: number;
} & (
  | { type: "status"; status: DeploymentStatus }
  | { type: "step"; stepId: string; status: StepStatus; error?: string }
  | { type: "log"; stepId: string; line: string; stream: "info" | "provider" }
  | { type: "output"; output: Output }
);

export interface Actor {
  type: "user" | "navigator" | "system";
  id: string;
  name: string;
}

export interface AuditEvent {
  ts: string;
  id: string;
  workspaceId: string;
  projectId?: string;
  environmentId?: string;
  actor: Actor;
  actionId: string;
  /** redacted input snapshot */
  input: unknown;
  result: "ok" | "error" | "denied";
  summary: string;
  error?: string;
}

/* ------------------------------- changesets ------------------------------- */

export type ChangeOp = "create" | "update" | "delete";

export interface ChangeItem {
  op: ChangeOp;
  /** Whole-document V2 settings use "manifest" rather than a fabricated node. */
  nodeType: "service" | "resource" | "route" | "binding" | "manifest";
  nodeId: string;
  nodeName: string;
  /** field-level detail for updates */
  fields?: { field: string; before: unknown; after: unknown }[];
  /** plain-language explanation of the change and its consequence */
  explanation: string;
  costDeltaUsd: number;
  risk: "low" | "medium" | "high";
}

export interface Changeset {
  items: ChangeItem[];
  totalCostDeltaUsd: number;
  /** est. monthly cost after apply */
  projectedMonthlyUsd: number;
  warnings: string[];
}

/* ---------------------------- security findings ---------------------------- */

export interface SecurityFinding {
  id: string;
  projectId: string;
  environmentId?: string;
  severity: "low" | "medium" | "high";
  title: string;
  detail: string;
  targetId?: string;
  /** action id + input that resolves this finding, if automatable */
  fix?: { actionId: string; input: unknown; label: string };
  /**
   * `fixed_pending_deploy` is the honest middle state: the fix edited the
   * working copy, so the environment is still exposed until a deploy lands it.
   * It becomes `resolved` when a deployed revision no longer triggers the rule.
   */
  status: "open" | "fixed_pending_deploy" | "resolved" | "dismissed";
  createdAt: string;
  /** when the finding left `open` (fixed, dismissed or marked resolved) */
  resolvedAt?: string;
  /** who moved it — the audit trail's counterpart on the finding itself */
  resolvedBy?: Actor;
  /** dismissal reason, or the fix that was run */
  resolvedReason?: string;
  /** the deployed revision that made the fix true; set on the pending → resolved step */
  fixedInRevisionId?: string;
}

/* --------------------------------- alerts --------------------------------- */

/** What an alert rule watches. Each kind reads inputs that already exist. */
export const AlertKind = z.enum([
  "health_degraded", // any managed service reports degraded health
  "deploy_failed", // the newest finished deployment failed
  "budget_exceeded", // estimated monthly cost reached N% of the budget
  "replicas_below", // a service has fewer ready replicas than the floor
]);
export type AlertKind = z.infer<typeof AlertKind>;

/**
 * A standing condition on one environment. Rules are evaluated on a timer and
 * whenever the Alerts API is read; they deliver nowhere but in-product (see
 * docs/LIMITATIONS.md — there is no email or Slack channel).
 */
export interface AlertRule {
  id: string;
  projectId: string;
  environmentId: string;
  kind: AlertKind;
  /** kind-specific number: percent of budget, or a minimum ready-replica count */
  threshold?: number;
  enabled: boolean;
  /**
   * Which delivery channels this rule pushes to. Unset means every enabled
   * channel in the workspace; an empty array means none, which is how a rule is
   * kept on screen only. A disabled channel is skipped either way.
   */
  channelIds?: string[];
  createdBy: Actor;
  createdAt: string;
}

/**
 * The record that a rule's condition was true. One open event per rule: it
 * stays open until the condition clears, so a flapping service is one incident
 * rather than a hundred rows.
 */
export interface AlertEvent {
  id: string;
  ruleId: string;
  /** copied from the rule so the record outlives the rule that produced it */
  projectId: string;
  environmentId: string;
  firedAt: string;
  resolvedAt?: string;
  /** why it closed: recovered, rule disabled, rule deleted */
  resolvedReason?: string;
  summary: string;
  severity: "low" | "medium" | "high";
  detail: string;
  /** true when the condition read generated or estimated data, not a measurement */
  simulated: boolean;
  acknowledgedAt?: string;
  acknowledgedBy?: Actor;
  acknowledgedNote?: string;
  /**
   * What happened when this event was pushed to the workspace's channels — one
   * entry per channel per transition (fired, then resolved). Absent on events
   * recorded before channels existed, and empty when the workspace has none.
   */
  deliveries?: AlertDelivery[];
}

/** Where an alert goes besides the screen. Workspace-wide, not per project. */
export const AlertChannelKind = z.enum([
  "webhook", // POST JSON, optionally signed with HMAC-SHA256
  "slack", // Slack incoming webhook (text + blocks)
  "email", // SMTP, via ZENITH_SMTP_URL
]);
export type AlertChannelKind = z.infer<typeof AlertChannelKind>;

export interface AlertChannel {
  id: string;
  workspaceId: string;
  kind: AlertChannelKind;
  /** what an operator calls it, e.g. "#ops in Slack" */
  name: string;
  /** the non-secret origin for HTTP channels, or recipient address for email */
  target: string;
  /**
   * Server-only reference for a webhook signing key. The plaintext value is
   * held by Zenith's encrypted secret store and never belongs in this record.
   */
  secret?: string;
  /** Server-only reference for the credential-bearing HTTP target. */
  secretRef?: string;
  /** Server-only reference for a Slack/webhook target URL. */
  targetSecretRef?: string;
  enabled: boolean;
  createdBy: Actor;
  createdAt: string;
  /** the newest attempt at this channel, real or test — what Settings shows */
  lastDelivery?: AlertDelivery;
}

/** One channel's outcome for one alert transition, after all retries. */
export interface AlertDelivery {
  channelId: string;
  /** when the last attempt finished */
  at: string;
  ok: boolean;
  /** HTTP status of the final attempt, when the channel speaks HTTP */
  status?: number;
  /** why it failed, in prose, with the fix — absent when it succeeded */
  error?: string;
  /** how many attempts were made (1–3) */
  attempts?: number;
}

/**
 * One durable intent to deliver one alert transition to one channel.
 *
 * Written in the same save as the event that caused it, so a crash can never
 * leave an open alert nobody was told about. Claimed before the send and
 * settled after it, so a crash mid-flight is retried rather than lost — and
 * `idempotencyKey` is stable across those retries, so a receiver that already
 * saw the first attempt can recognise the duplicate.
 */
export interface AlertOutboxEntry {
  id: string;
  workspaceId: string;
  channelId: string;
  eventId: string;
  /** which transition this is: the alert opening, or clearing */
  transition: "fired" | "resolved" | "test";
  /** stable across retries of this exact transition on this exact channel */
  idempotencyKey: string;
  status: "pending" | "sending" | "delivered" | "failed";
  attempts: number;
  createdAt: string;
  /** set while a runner holds it; a stale claim is reclaimable after the lease */
  claimedAt?: string;
  /** when it reached a terminal status */
  settledAt?: string;
  /** the last failure, in prose with its fix */
  error?: string;
  /** HTTP status of the last attempt, when the channel speaks HTTP */
  httpStatus?: number;
}

/* ------------------------------- navigator -------------------------------- */

/** Autonomy dial. Level semantics are enforced by the action executor. */
export const AutonomyLevel = z.enum([
  "observe", // 1: advisory only
  "plan", // 2: prepares plans, never executes
  "approve", // 3: executes after explicit approval
  "bounded", // 4: auto-executes low-risk actions inside policy
  "autonomous", // 5: full autonomy inside budgets/environments/risk limits
]);
export type AutonomyLevel = z.infer<typeof AutonomyLevel>;

/**
 * Evidence for the whole Navigator run, recorded by an authoritative verifier
 * after execution. A successful action or deployment status alone is not this
 * evidence. The run verifier records it only when provider checks cover the
 * complete intended result; unsupported or incomplete observations stay neutral.
 */
export interface NavigatorVerification {
  scope: "run";
  source: "provider";
  status: "passed" | "failed";
  simulated: boolean;
  checkedAt: string;
  /** Reference to the recorded provider observation/check, not explanatory prose. */
  evidenceRef: string;
  /** Immutable observations retained with the run for inspection. */
  checks?: { deploymentId: string; revisionId: string; provider: ProviderId; detail: string; passed: boolean }[];
}

export interface NavigatorRun {
  id: string;
  projectId: string;
  goal: string;
  status: "planning" | "awaiting_approval" | "executing" | "done" | "failed" | "cancelled";
  steps: NavigatorStep[];
  createdAt: string;
  endedAt?: string;
  summary?: string;
  verification?: NavigatorVerification;
  verificationPending?: boolean;
  verificationNote?: string;
}

export interface NavigatorStep {
  id: string;
  seq: number;
  title: string;
  rationale: string;
  actionId: string;
  input: unknown;
  risk: "low" | "medium" | "high";
  needsApproval: boolean;
  /**
   * The workspace role `runAction` will demand, copied from the registry at
   * plan time so the UI can disable Run before the refusal. The registry stays
   * the authority: the executor re-reads it.
   */
  requiredRole?: Member["role"];
  /** Approval is a client-side selection until Run; there is no stored "approved". */
  status: "proposed" | "running" | "done" | "failed" | "skipped";
  resultSummary?: string;
  /** Deployment created by this action, retained across approval/resume cycles. */
  deploymentId?: string;
  error?: string;
}
