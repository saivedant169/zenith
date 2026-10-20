/**
 * The `Broker` facade and `platformBroker()`, the one way application code
 * (the REST routes, later MCP v3 and the workflow activities) obtains a broker.
 *
 * WHICH STORE. `platformBroker()` never guesses:
 *  - `ZENITH_PLATFORM_BROKER_MEMORY=1` → a process-wide `MemoryBrokerStore`.
 *    For tests and local development ONLY: state is per-process and lost on
 *    restart, and two instances share nothing. In production an enabled flag
 *    refuses before overrides, registrations, cache or default store selection.
 *  - otherwise, a store the orchestrator registered with
 *    `registerPlatformBrokerStore()` (tests, or a pre-opened adapter).
 *  - otherwise the PLATFORM CONTROL STORE: `PlatformBrokerStore` over
 *    `platformDb()` (Postgres from `ZENITH_PLATFORM_DB_URL`, or PGlite). In a
 *    production build a store that was not configured explicitly (no
 *    `ZENITH_PLATFORM_DB`, no URL) is refused rather than defaulting to a
 *    local PGlite directory: `platform_store_unavailable`.
 *  If the store cannot be opened the broker answers `platform_store_unavailable`;
 *  it NEVER falls back to memory silently — an authorization ledger that quietly
 *  lives in RAM is worse than one that refuses to start.
 *
 * The other ports default to the product store (`productScopeResolver`,
 * `currentProductRoleResolver`), the credential broker's control-plane signer
 * (`CredentialGrantSigner`, key from `ZENITH_CONTROL_SIGNING_JWK`), the system
 * clock and the committed OPA bundle.
 */
import { platformDb, platformDbConfigFromEnv, isOpenedPlatformDbHandle, isOpenedPlatformPostgresTarget } from "@/lib/controlplane/db";
import { loadPolicyEngine } from "@/lib/policy";
import type { Principal, Sql } from "@/lib/controlplane/types";
import { approve, approveRunbookStep, reject, revokeApproval } from "./approvals";
import { getEnvironmentAutonomy, setEnvironmentAutonomy } from "./autonomy";
import { authorizeRead, check, propose } from "./broker";
import { BrokerError } from "./errors";
import { beginExecution, completeExecution, markUncertain } from "./execution";
import { CredentialGrantSigner } from "./credential-signer";
import { MemoryBrokerStore } from "./memory-store";
import { PlatformBrokerStore } from "./platform-store";
import { createStandingGrant, listStandingGrants, listStandingGrantUsage, revokeStandingGrant } from "./standing-grants";
import { cancelOperation, getOperationDetail, listOperationEvents, listOperations } from "./operations";
import { getWorkspacePolicy, setWorkspacePolicy } from "./policy-settings";
import { systemClock, type BrokerDeps, type BrokerStore, type GrantSigner, type RoleResolver, type ScopeResolver } from "./ports";
import { productScopeResolver } from "./product-adapters";
import { currentProductRoleResolver } from "./current-product-roles";
import type { BrowserSessionProof, ProposeContext } from "./types";

export const MEMORY_STORE_ENV = "ZENITH_PLATFORM_BROKER_MEMORY";

type Args<F> = F extends (deps: BrokerDeps, ...rest: infer R) => unknown ? R : never;

/** Every broker operation, bound to one set of dependencies. */
export interface Broker {
  readonly deps: BrokerDeps;
  propose(request: unknown, principal: Principal, ctx?: ProposeContext): ReturnType<typeof propose>;
  check(request: unknown, principal: Principal, ctx?: ProposeContext): ReturnType<typeof check>;
  authorizeRead(...args: Args<typeof authorizeRead>): ReturnType<typeof authorizeRead>;
  approve(...args: Args<typeof approve>): ReturnType<typeof approve>;
  /** Internal: the runbook delivery path presents its run approval for one step operation. */
  approveRunbookStep(...args: Args<typeof approveRunbookStep>): ReturnType<typeof approveRunbookStep>;
  reject(...args: Args<typeof reject>): ReturnType<typeof reject>;
  revokeApproval(...args: Args<typeof revokeApproval>): ReturnType<typeof revokeApproval>;
  cancelOperation(...args: Args<typeof cancelOperation>): ReturnType<typeof cancelOperation>;
  getOperationDetail(...args: Args<typeof getOperationDetail>): ReturnType<typeof getOperationDetail>;
  listOperations(...args: Args<typeof listOperations>): ReturnType<typeof listOperations>;
  listOperationEvents(...args: Args<typeof listOperationEvents>): ReturnType<typeof listOperationEvents>;
  beginExecution(...args: Args<typeof beginExecution>): ReturnType<typeof beginExecution>;
  completeExecution(...args: Args<typeof completeExecution>): ReturnType<typeof completeExecution>;
  markUncertain(...args: Args<typeof markUncertain>): ReturnType<typeof markUncertain>;
  getAutonomy(...args: Args<typeof getEnvironmentAutonomy>): ReturnType<typeof getEnvironmentAutonomy>;
  setAutonomy(...args: Args<typeof setEnvironmentAutonomy>): ReturnType<typeof setEnvironmentAutonomy>;
  getWorkspacePolicy(...args: Args<typeof getWorkspacePolicy>): ReturnType<typeof getWorkspacePolicy>;
  setWorkspacePolicy(...args: Args<typeof setWorkspacePolicy>): ReturnType<typeof setWorkspacePolicy>;
  createStandingGrant(...args: Args<typeof createStandingGrant>): ReturnType<typeof createStandingGrant>;
  revokeStandingGrant(...args: Args<typeof revokeStandingGrant>): ReturnType<typeof revokeStandingGrant>;
  listStandingGrants(...args: Args<typeof listStandingGrants>): ReturnType<typeof listStandingGrants>;
  listStandingGrantUsage(...args: Args<typeof listStandingGrantUsage>): ReturnType<typeof listStandingGrantUsage>;
}

export function createBroker(deps: BrokerDeps): Broker {
  return {
    deps,
    propose: (request, principal, ctx) => propose(deps, request, principal, ctx),
    check: (request, principal, ctx) => check(deps, request, principal, ctx),
    authorizeRead: (...a) => authorizeRead(deps, ...a),
    approve: (...a) => approve(deps, ...a),
    approveRunbookStep: (...a) => approveRunbookStep(deps, ...a),
    reject: (...a) => reject(deps, ...a),
    revokeApproval: (...a) => revokeApproval(deps, ...a),
    cancelOperation: (...a) => cancelOperation(deps, ...a),
    getOperationDetail: (...a) => getOperationDetail(deps, ...a),
    listOperations: (...a) => listOperations(deps, ...a),
    listOperationEvents: (...a) => listOperationEvents(deps, ...a),
    beginExecution: (...a) => beginExecution(deps, ...a),
    completeExecution: (...a) => completeExecution(deps, ...a),
    markUncertain: (...a) => markUncertain(deps, ...a),
    getAutonomy: (...a) => getEnvironmentAutonomy(deps, ...a),
    setAutonomy: (...a) => setEnvironmentAutonomy(deps, ...a),
    getWorkspacePolicy: (...a) => getWorkspacePolicy(deps, ...a),
    setWorkspacePolicy: (...a) => setWorkspacePolicy(deps, ...a),
    createStandingGrant: (...a) => createStandingGrant(deps, ...a),
    revokeStandingGrant: (...a) => revokeStandingGrant(deps, ...a),
    listStandingGrants: (...a) => listStandingGrants(deps, ...a),
    listStandingGrantUsage: (...a) => listStandingGrantUsage(deps, ...a),
  };
}

/* ------------------------------- wiring state ------------------------------- */

interface PlatformState {
  memoryStore?: MemoryBrokerStore;
  registeredStore?: BrokerStore;
  ports: Partial<{ scopes: ScopeResolver; roles: RoleResolver; signer: GrantSigner }>;
  cached?: { key: object; broker: Broker };
  override?: Broker;
}

type G = typeof globalThis & { __zenithPlatformBroker?: PlatformState };

const state = (): PlatformState => {
  const g = globalThis as G;
  return (g.__zenithPlatformBroker ??= { ports: {} });
};
interface OriginalObject { value: object; prototype: object | null; own: Map<PropertyKey, PropertyDescriptor>; inherited: Map<PropertyKey, PropertyDescriptor> }
function originalObject(value: object): OriginalObject | undefined {
  const own = new Map<PropertyKey, PropertyDescriptor>(), inherited = new Map<PropertyKey, PropertyDescriptor>(), prototype = Object.getPrototypeOf(value);
  for (const key of Reflect.ownKeys(value)) { const descriptor = Object.getOwnPropertyDescriptor(value, key); if (!descriptor || !("value" in descriptor)) return undefined; own.set(key, descriptor); }
  if (prototype) for (const key of Reflect.ownKeys(prototype)) { const descriptor = Object.getOwnPropertyDescriptor(prototype, key); if (!descriptor) return undefined; inherited.set(key, descriptor); }
  return { value, prototype, own, inherited };
}
function unchangedObject(original: OriginalObject): boolean {
  const same = (value: object, saved: Map<PropertyKey, PropertyDescriptor>) => Reflect.ownKeys(value).length === saved.size && [...saved].every(([key, descriptor]) => {
    const current = Object.getOwnPropertyDescriptor(value, key);
    return !!current && ("value" in descriptor ? "value" in current && current.value === descriptor.value && current.writable === descriptor.writable
      : !("value" in current) && current.get === descriptor.get && current.set === descriptor.set)
      && current.enumerable === descriptor.enumerable && current.configurable === descriptor.configurable;
  });
  return Object.getPrototypeOf(original.value) === original.prototype && same(original.value, original.own)
    && (!original.prototype || same(original.prototype, original.inherited));
}
const originalDefaultStores = new WeakMap<object, { db: Sql; original: OriginalObject }>();
const originalDefaultBrokers = new WeakMap<object, { state: PlatformState; ports: PlatformState["ports"]; db: Sql; originals: OriginalObject[] }>();
/** Boolean-only provenance of the actual default composition. No caller can register a broker here. */
export function isDefaultPlatformBrokerFor(value: unknown, owner: Sql): boolean {
  try {
    if (!value || typeof value !== "object") return false;
    const entry = originalDefaultBrokers.get(value), global = Object.getOwnPropertyDescriptor(globalThis, "__zenithPlatformBroker");
    if (!entry || !global || !("value" in global) || global.value !== entry.state || !entry.originals.every(unchangedObject)) return false;
    for (const key of ["override", "registeredStore"] as const) { const descriptor = Object.getOwnPropertyDescriptor(entry.state, key); if (descriptor && (!("value" in descriptor) || descriptor.value !== undefined)) return false; }
    const ports = Object.getOwnPropertyDescriptor(entry.state, "ports");
    if (!ports || !("value" in ports) || ports.value !== entry.ports) return false;
    for (const key of ["scopes", "roles"] as const) { const descriptor = Object.getOwnPropertyDescriptor(entry.ports, key); if (descriptor && (!("value" in descriptor) || descriptor.value !== undefined)) return false; }
    if (!isOpenedPlatformDbHandle(owner, "postgres") || !isOpenedPlatformDbHandle(entry.db, "postgres")) return false;
    const config = platformDbConfigFromEnv(); if (config.kind !== "postgres" || !config.url) return false;
    const url = new URL(config.url), options = [...url.searchParams];
    if (!["postgres:","postgresql:"].includes(url.protocol) || !url.port || url.hash || options.length > 1
      || options.some(([key,value]) => key !== "sslmode" || !["require","verify-full"].includes(value))) return false;
    const host = url.hostname, port = Number(url.port), database = decodeURIComponent(url.pathname.slice(1)), username = decodeURIComponent(url.username);
    return isOpenedPlatformPostgresTarget(owner, host, port, database, username) && isOpenedPlatformPostgresTarget(entry.db, host, port, database, username);
  } catch { return false; }
}

/** The orchestrator's plug-in point: hand the platform control store adapter to the broker. */
export function registerPlatformBrokerStore(store: BrokerStore): void {
  const s = state();
  s.registeredStore = store;
  s.cached = undefined;
}

/** Replace the default scope/role/signer ports (e.g. the credential broker's signer). */
export function registerPlatformBrokerPorts(ports: Partial<{ scopes: ScopeResolver; roles: RoleResolver; signer: GrantSigner }>): void {
  const s = state();
  s.ports = { ...s.ports, ...ports };
  s.cached = undefined;
}

/** Tests: use exactly this broker (or pass null to restore normal selection). */
export function setPlatformBrokerForTests(broker: Broker | null): void {
  const s = state();
  if (broker) s.override = broker;
  else delete s.override;
}

/** Tests: drop the memory store and every registration. */
export function resetPlatformBrokerForTests(): void {
  (globalThis as G).__zenithPlatformBroker = { ports: {} };
}

export const isMemoryStoreEnabled = (): boolean => process.env[MEMORY_STORE_ENV] === "1";

async function defaultStore(): Promise<BrokerStore> {
  let config;
  try {
    config = platformDbConfigFromEnv();
  } catch {
    throw storeUnavailable("The platform control store is misconfigured (check ZENITH_PLATFORM_DB and ZENITH_PLATFORM_DB_URL).");
  }
  if (process.env.NODE_ENV === "production" && config.source === "default") {
    throw storeUnavailable("This production build has no platform control store configured (ZENITH_PLATFORM_DB_URL), and will not default to a local PGlite directory.");
  }
  try {
    const db = await platformDb(), store = new PlatformBrokerStore(db), original = originalObject(store);
    if (original && isOpenedPlatformDbHandle(db, "postgres")) originalDefaultStores.set(store, { db, original });
    return store;
  } catch {
    // The store's own error may name hosts or paths; the operator reads the server log.
    throw storeUnavailable("The platform control store could not be opened.");
  }
}

const storeUnavailable = (message: string): BrokerError =>
  new BrokerError(
    "platform_store_unavailable",
    `${message} Capability requests are refused until it is available.`,
    `An operator must configure the platform store. For local development only, ${MEMORY_STORE_ENV}=1 uses a per-process in-memory store.`
  );

export async function platformBroker(): Promise<Broker> {
  if (process.env.NODE_ENV === "production" && isMemoryStoreEnabled()) {
    throw storeUnavailable("This production build cannot use an in-memory capability ledger. Remove ZENITH_PLATFORM_BROKER_MEMORY and configure a durable platform control store.");
  }
  const s = state();
  if (s.override) return s.override;

  let store: BrokerStore;
  if (isMemoryStoreEnabled()) store = s.memoryStore ??= new MemoryBrokerStore();
  else if (s.registeredStore) store = s.registeredStore;
  else store = await defaultStore();
  if (s.cached && s.cached.key === store) return s.cached.broker;

  const broker = createBroker({
    store,
    scopes: s.ports.scopes ?? productScopeResolver(),
    // Cache the resolver, never its membership result. Each check and consumed
    // approver read uses the shared bounded, tenant-scoped current authority.
    roles: s.ports.roles ?? currentProductRoleResolver(),
    signer: s.ports.signer ?? new CredentialGrantSigner(),
    clock: systemClock,
    policy: () => loadPolicyEngine(),
  });
  const original = originalDefaultStores.get(store);
  if (original && !s.override && !s.registeredStore && !s.ports.scopes && !s.ports.roles) {
    const values = [broker, broker.deps, broker.deps.scopes, broker.deps.roles, broker.deps.clock];
    const originals = values.map(originalObject);
    if (originals.every((value): value is OriginalObject => !!value)) originalDefaultBrokers.set(broker,
      { state: s, ports: s.ports, db: original.db, originals: [original.original, ...originals] });
  }
  s.cached = { key: store, broker };
  return broker;
}

export type { BrowserSessionProof };
