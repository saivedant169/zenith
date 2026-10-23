/** L3 plans describe real requests, never results. No credential is opened in plan mode. */
import { z } from "zod";
import { digest } from "@/lib/controlplane/digest";
import { PROVIDERS, type ScopeManifest } from "../../../release/scope";
import { REQUIRED_SCENARIO_IDS } from "../../../release/scenarios";

const Id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const Account = z.string().regex(/^[a-zA-Z0-9_.:-]{1,300}$/);
const Hex = z.string().regex(/^[a-f0-9]{40}$/);
const Ref = z.string().regex(/^[A-Z][A-Z0-9_]*_FILE$/);
const Pointer = z.string().regex(/^(?:\/(?:[^~]|~[01])*)*$/).max(300);
const Assertion = z.object({ pointer: Pointer, equals: z.unknown().optional(), min: z.number().finite().optional(), max: z.number().finite().optional() }).strict().superRefine((a, ctx) => {
  const range = a.min !== undefined || a.max !== undefined;
  if ((a.equals !== undefined) === range || a.min !== undefined && a.max !== undefined && a.min > a.max) ctx.addIssue({ code: "custom", message: "Choose equality or a finite numeric range" });
});
const Target = z.object({
  id: Id, provider: z.enum(PROVIDERS), account: Account, region: Id,
  kind: z.enum(["product", "https", "kubernetes", "aws", "gcp", "azure", "postgres"]),
  origin: z.string().url().optional(), credentialRef: Ref.optional(),
  auth: z.enum(["bearer", "browser", "none"]).prefault("none"), workspaceId: Id.optional(),
  context: z.string().min(1).max(300).optional(),
  caRef: Ref.optional(), hostSuffix: z.string().regex(/^\.[a-z0-9.-]+$/).optional(),
}).strict();
export type Target = z.infer<typeof Target>;
const Request = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("http"), target: Id, method: z.enum(["GET", "POST"]), path: z.string().max(1000), body: z.record(z.string(), z.unknown()).optional(), status: z.number().int().min(100).max(599), assertions: z.array(Assertion).min(1) }).strict(),
  z.object({ kind: z.literal("kubernetes"), target: Id, resource: z.enum(["namespace", "deployment", "pods", "resourcequota", "networkpolicy", "httproute", "certificate", "persistentvolumeclaim", "job"]), namespace: Id.optional(), name: Id, assertions: z.array(Assertion).min(1) }).strict(),
  z.object({ kind: z.literal("delete_namespace"), target: Id, name: Id }).strict(),
  z.object({ kind: z.literal("scale_deployment"), target: Id, namespace: Id, name: Id, replicas: z.number().int().min(0).max(5) }).strict(),
  z.object({ kind: z.literal("inventory"), target: Id }).strict(),
  z.object({ kind: z.literal("mixed_evidence"), target: Id, path: z.string().regex(/^\/api\/platform\/v1\/mixed\/plans\/[a-zA-Z0-9_.:-]+$/) }).strict(),
  z.object({ kind: z.literal("mixed_traffic"), target: Id, databaseTarget: Id, orders: z.number().int().min(1).max(100).prefault(50), phase: z.enum(["baseline", "outage", "recovered"]) }).strict(),
  z.object({ kind: z.literal("connectivity"), target: Id, certRef: Ref, keyRef: Ref, caRef: Ref,
    outsideAllowlist: z.boolean(), endpoints: z.array(z.object({ id: Id, dataClass: z.enum(["database", "service", "function"]), host: z.string().regex(/^[a-z0-9][a-z0-9.-]+$/), port: z.number().int().min(1).max(65535), dnsTargets: z.array(z.string()).min(1), tlsMinVersion: z.enum(["1.2", "1.3"]), serverNames: z.array(z.string()).min(1), serverSpkiSha256: z.string().regex(/^[a-f0-9]{64}$/), allowlist: z.array(z.string()).min(1) }).strict()).min(1) }).strict(),
]);
export type Request = z.infer<typeof Request>;
const Resource = z.object({ id: Id, target: Id, name: Id, ownership: Request, tagPointer: Pointer, ttlPointer: Pointer }).strict();
export type Resource = z.infer<typeof Resource>;
const Step = z.object({ id: Id, scenario: Id, action: z.enum(["read", "create_disposable", "mutate_run_tagged", "teardown_run_tagged", "inject_fault"]), resource: Id.optional(), request: Request, attempts: z.number().int().min(1).max(120).prefault(1), intervalMs: z.number().int().min(100).max(30000).prefault(1000) }).strict();
export type Step = z.infer<typeof Step>;
export const Recipe = z.object({
  schema: z.literal(1), profile: z.enum(["managed", "mixed", "release"]), runId: z.string().regex(/^zlive-\d{12}-[a-z0-9]{4}$/),
  sourceCommit: Hex, startedAt: z.string().datetime(), ttlMinutes: z.number().int().min(5).max(240),
  estimate: z.object({ byProviderUsd: z.partialRecord(z.enum(PROVIDERS), z.number().finite().nonnegative()), cleanupReserveUsd: z.number().finite().positive(), basis: z.string().min(20).max(400), provisional: z.literal(true) }).strict(),
  targets: z.array(Target).min(1).max(30), resources: z.array(Resource).max(100),
  steps: z.array(Step).min(1).max(200), cleanup: z.array(Step).max(100), scans: z.array(Step).min(1).max(30),
}).strict();
export type Recipe = z.infer<typeof Recipe>;
export interface Plan extends Recipe { sha256: string }

export const MANAGED_SCENARIOS = ["managed-session-build-release", "registry-gateway-dns-tls-secrets-database", "storage-domain-renewal-export-autoscale", "two-tenant-isolation", "noisy-neighbour", "billing-test-mode", "suspension-export"] as const;
export const MIXED_SCENARIOS = ["partitions-authority", "immutable-plans-resume", "typed-output-review", "distributed-failure-order", "protected-connectivity", "mixed-traffic-readback", "provider-failure-economics"] as const;
export const OPS_SCENARIOS = ["slo-measurement", "control-plane-outage-fairness", "rolling-upgrade-replay", "clean-host-restore", "key-rotation-decrypt-history", "persistence-leak-scan", "archive-hold-dry-run", "independent-adversarial", "signed-release-audit"] as const;
export function scenarios(profile: Recipe["profile"]): readonly string[] {
  return profile === "managed" ? MANAGED_SCENARIOS : profile === "mixed" ? MIXED_SCENARIOS : [...REQUIRED_SCENARIO_IDS, ...OPS_SCENARIOS];
}
export function harness(profile: Recipe["profile"]): string { return profile === "mixed" ? "mixed-traffic-live" : `${profile}-acceptance-live`; }
export function at(value: unknown, pointer: string): unknown {
  return pointer === "" ? value : pointer.slice(1).split("/").reduce<unknown>((v, key) => {
    const k = key.replace(/~1/g, "/").replace(/~0/g, "~");
    return v !== null && typeof v === "object" && Object.hasOwn(v, k) ? (v as Record<string, unknown>)[k] : undefined;
  }, value);
}
export function assertionsPass(value: unknown, assertions: readonly z.infer<typeof Assertion>[]): boolean {
  return assertions.every(a => {
    const observed = at(value, a.pointer);
    if (observed === undefined) return false;
    if (a.equals !== undefined) return digest(observed) === digest(a.equals);
    return typeof observed === "number" && Number.isFinite(observed) && (a.min !== undefined || a.max !== undefined) && (a.min === undefined || observed >= a.min) && (a.max === undefined || observed <= a.max);
  });
}
function noInlineSecrets(value: unknown): void {
  if (Array.isArray(value)) { value.forEach(noInlineSecrets); return; }
  if (value && typeof value === "object") for (const [key, v] of Object.entries(value)) {
    if (/^(password|token|secret|authorization|cookie|accessKeyId|secretAccessKey|sessionToken|privateKey)$/i.test(key)) throw new Error("Inline credentials are forbidden; use credential FILE references or vault references in the product");
    noInlineSecrets(v);
  }
}
export function buildPlan(raw: unknown): Plan {
  const recipe = Recipe.parse(raw);
  noInlineSecrets(recipe);
  for (const list of [recipe.targets, recipe.resources, [...recipe.steps, ...recipe.cleanup, ...recipe.scans]]) {
    if (new Set(list.map(x => x.id)).size !== list.length) throw new Error("Duplicate plan identity");
  }
  for (const t of recipe.targets) {
    if (t.origin) { const u = new URL(t.origin); if (u.protocol !== "https:" || u.username || u.password || u.pathname !== "/" || u.search || u.hash) throw new Error("Targets require a bare HTTPS origin without credentials"); }
    if (t.kind === "kubernetes" && !t.origin) throw new Error("Kubernetes requires its exact API server origin");
    if (t.kind === "kubernetes" && (!t.context || !t.credentialRef)) throw new Error("Kubernetes requires an exact context and kubeconfig FILE reference");
    if (t.kind === "kubernetes" && /^(kind-|docker-desktop|minikube|colima|rancher-desktop)/.test(t.context!)) throw new Error("Live plans refuse local clusters; use the local Mac lanes");
    if (["aws", "gcp", "azure"].includes(t.kind) && (t.kind !== t.provider || !t.credentialRef)) throw new Error("Inventory requires matching cloud identity and credential FILE reference");
    if (t.kind === "aws" && !/^\d{12}$/.test(t.account)) throw new Error("AWS requires the exact sandbox account id");
    if (t.kind === "postgres" && (t.provider !== "azure" || !t.credentialRef || !t.caRef || !t.hostSuffix)) throw new Error("Mixed readback requires Azure PostgreSQL, private URL/CA FILE references and provider host suffix");
    if (["product", "https"].includes(t.kind)) {
      const url = new URL(t.origin ?? "");
      if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Targets require a bare HTTPS origin without credentials");
      if (t.kind === "product" && (t.provider !== "control_plane" || !t.credentialRef || t.auth === "none" || !t.workspaceId)) throw new Error("Product target requires a workspace and credential FILE reference");
      if (t.auth !== "none" && !t.credentialRef) throw new Error("Authenticated targets need a credential FILE reference");
    }
  }
  const requests = [...recipe.resources.map(r => r.ownership), ...recipe.steps.map(s => s.request), ...recipe.cleanup.map(s => s.request), ...recipe.scans.map(s => s.request)];
  for (const q of requests) {
    const t = recipe.targets.find(t => t.id === q.target);
    if (!t) throw new Error("Request names an unknown target");
    if (q.kind === "http") {
      if (!["product", "https"].includes(t.kind) || !/^\/(?!\/)/.test(q.path) || /[\\#\r\n]/.test(q.path) || new URL(q.path, t.origin).origin !== t.origin) throw new Error("Request must stay on its exact approved origin");
      if (/\/(approve|reject)(?:[/?]|$)/.test(q.path)) throw new Error("Harnesses cannot submit human approval decisions");
      if (q.method === "GET" && q.body) throw new Error("Read-only requests cannot carry an effect body");
      if (q.method === "POST" && t.kind !== "product") throw new Error("Provider mutation must use the product's ordinary policy and approval paths");
      if (q.method === "POST" && !/^\/api\/platform\/v1\/operations\/[a-zA-Z0-9_-]+\/mixed-run\/teardown$/.test(q.path)) throw new Error("This harness only releases or syncs already human-approved product teardown operations; provisioning and fault injection stay owner-driven");
      if (q.method === "POST" && (t.auth !== "browser" || !["release", "sync"].includes(String(q.body?.action)))) throw new Error("Teardown release requires a genuine browser session and a reviewed release/sync body");
      if (q.method === "POST" && (q.body?.action === "release" && (typeof q.body.childId !== "string" || typeof q.body.destroyOperationId !== "string") || Object.keys(q.body ?? {}).some(k => !["action", "childId", "destroyOperationId"].includes(k)))) throw new Error("Teardown must bind exact child and destroy operation ids");
    } else if (q.kind === "mixed_evidence") {
      if (t.kind !== "product") throw new Error("Mixed evidence requires the real product route");
    } else if (q.kind === "mixed_traffic") {
      if (t.kind !== "https" || t.auth !== "none" || t.provider !== "gcp" || recipe.targets.find(t => t.id === q.databaseTarget)?.kind !== "postgres") throw new Error("Mixed traffic requires GCP entry and an independent PostgreSQL target");
    } else if (q.kind === "connectivity") {
      if (t.kind !== "https" || q.endpoints.some(ep => ep.host !== new URL(t.origin!).hostname)) throw new Error("Connectivity endpoints must bind the exact target hostname");
    } else if (q.kind === "inventory") {
      if (!["kubernetes", "aws", "gcp", "azure"].includes(t.kind)) throw new Error("Unsupported independent inventory target");
    } else if (t.kind !== "kubernetes") throw new Error("Kubernetes request on non-cluster target");
  }
  for (const resource of recipe.resources) {
    if (!recipe.targets.some(t => t.id === resource.target) || resource.ownership.target !== resource.target || !(resource.ownership.kind === "http" && resource.ownership.method === "GET" || resource.ownership.kind === "kubernetes")) throw new Error("Resource requires an independent read-only ownership request on its target");
  }
  for (const s of [...recipe.steps, ...recipe.cleanup, ...recipe.scans]) {
    if (!scenarios(recipe.profile).includes(s.scenario)) throw new Error("Unknown acceptance scenario");
    const mutation = s.request.kind === "delete_namespace" || s.request.kind === "scale_deployment" || s.request.kind === "mixed_traffic" || s.request.kind === "http" && s.request.method === "POST";
    if (mutation === (s.action === "read") || s.action !== "read" && !s.resource) throw new Error("Effect and scope action disagree or lack a resource binding");
    const resource = recipe.resources.find(r => r.id === s.resource);
    if (s.resource && !resource) throw new Error("Unknown resource binding");
    if (s.action === "create_disposable" && !resource?.name.startsWith(`zenith-${recipe.runId}-`)) throw new Error("Creation requires a disposable run-prefixed name");
    if (s.request.kind === "delete_namespace" && (s.action !== "teardown_run_tagged" || s.request.target !== resource?.target || s.request.name !== resource?.name || s.attempts !== 1)) throw new Error("Namespace deletion must bind the exact owned namespace");
    if (mutation && s.attempts !== 1) throw new Error("Mutations are never retried automatically");
    if (s.request.kind === "http" && s.request.method === "POST" && s.action !== "teardown_run_tagged") throw new Error("Product teardown cannot be granted as a different action");
    if (s.request.kind === "mixed_traffic" && s.action !== "mutate_run_tagged") throw new Error("Traffic writes require mutation authority");
    if (s.request.kind === "scale_deployment") {
      const q = s.request;
      if (resource?.target !== q.target || resource.name !== q.name || resource.ownership.kind !== "kubernetes" || resource.ownership.resource !== "deployment" || resource.ownership.namespace !== q.namespace || q.replicas === 0 && s.action !== "inject_fault" || q.replicas > 0 && !["mutate_run_tagged", "teardown_run_tagged"].includes(s.action)) throw new Error("Scaling requires the exact owned Deployment and explicit fault/heal authority");
    }
  }
  for (const s of recipe.cleanup) if (!["read", "teardown_run_tagged"].includes(s.action)) throw new Error("Cleanup cannot inject faults, create or mutate resources");
  if (recipe.steps.some(s => s.action !== "read") && !recipe.cleanup.some(s => s.action === "teardown_run_tagged")) throw new Error("Mutating runs require preapproved cleanup");
  if (recipe.scans.some(s => s.action !== "read" || s.request.kind !== "inventory")) throw new Error("Leak scans must be independent provider inventories");
  for (const t of recipe.targets.filter(t => t.provider !== "control_plane" && t.provider !== "public")) {
    if (!recipe.scans.some(s => { const scan = recipe.targets.find(t => t.id === s.request.target); return scan?.provider === t.provider && scan.account === t.account && scan.region === t.region; })) throw new Error("Every provider account/region requires its own independent leak scan");
  }
  const required = new Set(recipe.resources.filter(r => recipe.steps.some(s => s.resource === r.id && s.action !== "read")).map(r => r.id));
  if ([...required].some(id => !recipe.cleanup.some(s => s.resource === id && s.action === "teardown_run_tagged"))) throw new Error("Every touched resource needs exact preapproved cleanup");
  return { ...recipe, sha256: digest(recipe) };
}
export function planSummary(plan: Plan, manifest: ScopeManifest): object {
  const usd = Object.values(plan.estimate.byProviderUsd).reduce((sum, x) => sum + x, 0) + plan.estimate.cleanupReserveUsd;
  return { plan, estimatedUsd: usd, credentialsRead: false, callsMade: 0, callEnvelope: [...plan.steps, ...plan.cleanup, ...plan.scans].map(s => ({ id: s.id, maximumRequests: s.attempts * 3, maximumSubcalls: s.attempts * 3 * 120, ownershipReads: s.resource ? 3 : 0 })), requiredScenarios: scenarios(plan.profile), pendingScenarios: scenarios(plan.profile).filter(id => !plan.steps.some(s => s.scenario === id)),
    proposedGrant: { [harness(plan.profile)]: { description: "Owner-reviewed L3 managed/mixed/release acceptance, exact plan separately pinned", providers: [...new Set(plan.targets.map(t => t.provider))], actions: [...new Set([...plan.steps, ...plan.cleanup, ...plan.scans].map(s => s.action))], maxRunUsd: usd } },
    approval: manifest.approval.status, statement: "Provisional estimate including cleanup reserve; no accounts, approvals or credentials are created. An incomplete scenario is pending, never verified." };
}
