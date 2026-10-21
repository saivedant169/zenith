/**
 * Resource driver contract (spec §9, ADR-0004).
 *
 * A provider is a set of resource-oriented drivers, one per (provider, native
 * type) — never one switch statement. Each driver realizes one portable kind
 * on one provider and declares, honestly, which of its operations are real.
 *
 * Lifecycle split (ADR-0005, hybrid OpenTofu + native APIs):
 *   - Declarative lifecycle (create/update/delete of persistent
 *     infrastructure) is `compile()` → OpenTofu JSON. Drivers never hand-roll
 *     create/update/delete calls for anything OpenTofu manages.
 *   - Day-two operations (restart, scale-now, invoke, target health, log and
 *     metric queries, SSM) are native API calls in `operations`.
 *   - `observe`, `runtime`, `verify`, `discover` are native API reads.
 *
 * Invariants:
 *   - `observe`/`runtime`/`verify`/`discover` are read-only. They never
 *     create, mutate or delete, and they never return secret values.
 *   - An attribute the driver did not read is `{ state: "unknown" }`.
 *   - Every mutating native operation is idempotent where the provider allows
 *     it (client tokens / idempotency keys derived from the operation id) and
 *     carries the fence token in a request tag or token when the API has one.
 *   - Operations honour `ctx.signal` and stop promptly when it aborts.
 *   - Discovery returns candidates only; it never marks anything `managed`.
 */
import type { Observation, ResourceNode, RuntimeState, ProviderKey, PortableKind } from "@/lib/resources/types";
import type { AwsBootstrapContext } from "@/lib/credentials/aws/naming";

/* ------------------------------- evidence --------------------------------- */

/**
 * How an operation's claim of success has been verified, per the no-false-
 * claims rule (spec §42). The capability matrix is generated from these.
 *   real      — exercised against the real provider in a live acceptance run
 *   emulated  — exercised against an emulator (LocalStack, kind, PGlite)
 *   contract  — only mocked SDK/HTTP contract tests
 *   simulated — generated data (sandbox); never presented as real
 */
export type EvidenceLevel = "real" | "emulated" | "contract" | "simulated";

export interface DriverCapabilities {
  compile: boolean;
  observe: boolean;
  runtime: boolean;
  verify: boolean;
  discover: boolean;
  /** Experimental driver; independent of per-operation verification evidence. */
  experimental?: boolean;
  /** capability names (from the capability catalog) this driver can execute natively */
  operations: string[];
  /** Implemented refusal-only operations; disjoint from executable operations. */
  refuses?: string[];
  /** per-operation verification evidence, including refusal paths */
  evidence: Record<string, EvidenceLevel>;
}

/* ------------------------------ context ----------------------------------- */

export interface DriverLog {
  (line: string, level?: "info" | "warn" | "error"): void;
}

/**
 * What a driver receives for any call. `session` is the provider session the
 * credential broker produced for THIS operation; drivers never construct
 * credentials, read env credentials, or cache sessions across operations.
 */
export interface DriverContext<Session = unknown> {
  /** Trusted saved connection context, never node configuration. */
  awsBootstrap?: AwsBootstrapContext;
  provider: ProviderKey;
  region: string;
  workspaceId: string;
  environmentId: string;
  operationId?: string;
  /** Non-secret reviewed build custody binding, set only by the execution release guard. */
  reviewedBuildProfileDigest?: string;
  session: Session;
  signal: AbortSignal;
  log: DriverLog;
  /** tags every created/managed object carries (zenith:workspace, zenith:environment, zenith:resource, zenith:managed) */
  tags: Record<string, string>;
  /** present when the calling operation holds a lease */
  fence?: { scope: string; token: number };
  now(): Date;
}

/* ------------------------------ compilation ------------------------------- */

/**
 * An OpenTofu JSON-syntax fragment. The tofu workspace assembler merges the
 * fragments of all nodes deterministically (sorted keys) and adds the
 * `terraform`/`provider` blocks and backend itself. Drivers never emit
 * providers, backends or credentials.
 */
export interface TofuFragment {
  resource?: Record<string, Record<string, Record<string, unknown>>>;
  data?: Record<string, Record<string, Record<string, unknown>>>;
  /** OpenTofu 1.12 temporary resources; values never enter saved plans/state. */
  ephemeral?: Record<string, Record<string, unknown>>;
  output?: Record<string, { value: unknown; sensitive?: boolean; description?: string }>;
  locals?: Record<string, unknown>;
  /** State-backed tofu addresses (`aws_ecs_service.web`) — joins plans to nodes. */
  addresses: string[];
}

export interface CompileContext {
  /** Present for production AWS compilation; absent only for standalone rendering. */
  awsBootstrap?: AwsBootstrapContext;
  environmentId: string;
  /** Azure cloud of the deploy connection (PROD-LIFE-04); absent means the public cloud. */
  azureCloud?: "public" | "usgov" | "china";
  /** deterministic short name prefix, lowercase, ≤ 20 chars */
  namePrefix: string;
  region: string;
  tags: Record<string, string>;
  /**
   * Record a cross-node reference as a single provisional `${...}`
   * interpolation; execution resolves it after every node has compiled,
   * including within longer expressions. Reciprocal node references need no
   * compile order. The declared `refLocalName(address, attribute)` local wins;
   * otherwise a plain identifier path with optional numeric indexes resolves
   * on its primary resource/data address. Semantic keys such as
   * `target_group_arn:container_service/web:3000` require a published local;
   * invalid/unpublished keys and targets without an address fail closed.
   */
  ref(address: string, attribute: string): string;
  /**
   * A typed dependency input of a mixed-provider consumer (a value another partition produced), as the interpolation of its
   * OpenTofu variable. Present in production compilation; it refuses a name the operation does not consume. A secret input is a
   * sensitive variable whose value never enters the rendered configuration.
   */
  input?(name: string): string;
  /** all nodes, for drivers that need a neighbour's spec */
  node(address: string): ResourceNode | undefined;
  /** the whole graph, for facts that come from other nodes (e.g. an autoscaler node targeting this workload) */
  nodes?(): readonly ResourceNode[];
}

/* ------------------------------ verification ------------------------------ */

export interface VerificationCheck {
  id: string;
  description: string;
  passed: boolean | "unknown";
  detail?: string;
}

export interface VerificationResult {
  address: string;
  status: "passed" | "failed" | "unknown";
  checks: VerificationCheck[];
  checkedAt: string;
  simulated: boolean;
}

/* ------------------------------- discovery -------------------------------- */

export interface DiscoveredResource {
  provider: ProviderKey;
  kind: PortableKind;
  nativeType: string;
  externalId: string;
  name: string;
  region: string;
  /** true when tags show Zenith created it (still requires explicit adoption) */
  zenithTagged: boolean;
  attributes: Record<string, string | number | boolean>;
}

/* --------------------------- native operations ---------------------------- */

export interface NativeOperationResult {
  ok: boolean;
  summary: string;
  /** bounded, redacted, model-safe data */
  data?: Record<string, unknown>;
  /** provider request ids for evidence */
  requestIds?: string[];
  simulated: boolean;
}

export type NativeOperation<Session = unknown> = (
  ctx: DriverContext<Session>,
  node: ResourceNode,
  input: Record<string, unknown>
) => Promise<NativeOperationResult>;

/* --------------------------------- driver --------------------------------- */

export interface ResourceDriver<Session = unknown> {
  /** `<provider>.<nativeType-suffix>@<major>`, e.g. `aws.ecs_service@1` */
  id: string;
  provider: ProviderKey;
  kind: PortableKind | "provider_native";
  nativeType: string;
  capabilities: DriverCapabilities;

  /** OpenTofu JSON for this node. Pure: no I/O, deterministic. */
  compile?(node: ResourceNode, ctx: CompileContext): TofuFragment;

  /** Read provider configuration for this node. Read-only. */
  observe?(ctx: DriverContext<Session>, node: ResourceNode, externalId?: string): Promise<Observation>;

  /** Read what is running now (counts, health). Read-only. */
  runtime?(ctx: DriverContext<Session>, node: ResourceNode, externalId?: string): Promise<RuntimeState>;

  /** Check the node satisfies its desired spec and is serving. Read-only. */
  verify?(ctx: DriverContext<Session>, node: ResourceNode, observation: Observation, runtime?: RuntimeState): Promise<VerificationResult>;

  /** List candidates in the account/cluster for reference-import. Read-only. */
  discover?(ctx: DriverContext<Session>): Promise<DiscoveredResource[]>;

  /**
   * Map desired spec → comparable attribute values, so drift compares like
   * with like: `{ replicas: 3, cpu: 256 }`. Only attributes `observe` reads.
   */
  expectedAttributes?(node: ResourceNode, ctx?: Pick<DriverContext, "awsBootstrap">): Record<string, unknown>;

  /** Day-two operations keyed by capability name (e.g. `service.restart`). */
  operations?: Record<string, NativeOperation<Session>>;
}

/* -------------------------------- registry -------------------------------- */

type G = typeof globalThis & { __zenithDrivers?: Map<string, ResourceDriver> };

const registry = (): Map<string, ResourceDriver> => {
  const g = globalThis as G;
  if (!g.__zenithDrivers) g.__zenithDrivers = new Map();
  return g.__zenithDrivers;
};

const key = (provider: ProviderKey, nativeType: string) => `${provider}|${nativeType}`;

export function registerDriver(driver: ResourceDriver): void {
  registry().set(key(driver.provider, driver.nativeType), driver as ResourceDriver);
}

export function getDriver(provider: ProviderKey, nativeType: string): ResourceDriver {
  const d = registry().get(key(provider, nativeType));
  if (!d) throw new Error(`No driver registered for ${provider} ${nativeType}.`);
  return d;
}

export function findDriver(provider: ProviderKey, nativeType: string): ResourceDriver | undefined {
  return registry().get(key(provider, nativeType));
}

export function listDrivers(provider?: ProviderKey): ResourceDriver[] {
  return [...registry().values()].filter((d) => !provider || d.provider === provider);
}
