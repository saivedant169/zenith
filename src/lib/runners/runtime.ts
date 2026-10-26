/**
 * Process wiring of the runner plane: which store, signer, result sealer,
 * event sink and clock the routes and `dispatch.ts` use.
 *
 * Defaults (nothing is guessed, and a missing piece is a `RunnerConfigError` —
 * HTTP 503 `runner_plane_unconfigured` — never a silent fallback):
 *  - store     `createPlatformRunnerStore(await platformDb())`, the platform control
 *              store (Postgres, or PGlite when no URL is configured; `ZENITH_PLATFORM_DB*`).
 *  - signer    `getControlSigner()` from the credential module: a local Ed25519 JWK
 *              (`ZENITH_CONTROL_SIGNING_JWK`) or KMS (`ZENITH_CONTROL_KMS_KEY_ID`).
 *  - keys      `getControlVerificationKeys()`: the active key plus
 *              `ZENITH_CONTROL_EXTRA_PUBLIC_JWKS` (announced next / retiring keys).
 *  - sealer    `ZENITH_RUNNER_RESULT_KEY`, else derived from the local signing JWK (`seal.ts`).
 *  - events    a no-op until the orchestrator wires the event store (`events.append`).
 * Tests and the composition root inject pieces with `configureRunnerRuntime`.
 */
import { createHash } from "node:crypto";
import { platformDb } from "@/lib/controlplane/db";
import { getControlSigner, getControlVerificationKeys } from "@/lib/credentials/signing";
import type { JwtSigner, PublicJwk } from "@/lib/credentials/signing/types";
import { repos } from "@/lib/controlplane/db";
import type { GrantStatus } from "@/lib/controlplane/db/repos/grants";
import type { ConnectionLookup } from "@/lib/runners/custody";
import { createPlatformRunnerStore } from "@/lib/runners/db/pg-store";
import type { RunnerEventSink, RunnerStore } from "@/lib/runners/ports";
import { createResultSealerFromEnv, type ResultSealer } from "@/lib/runners/seal";
import { controlKeyOf, type ControlKey } from "@/lib/runners/signing";
import { POLL_STEP_MS, RunnerConfigError } from "@/lib/runners/types";

export interface RunnerRuntime {
  store: RunnerStore;
  /** the EdDSA control-plane signer (local JWK or KMS) */
  signer: JwtSigner;
  /** pinned control-plane public keys: the active key plus announced next/previous ones */
  verificationKeys(): Promise<PublicJwk[]>;
  sealer: ResultSealer;
  /** fresh read of a provider connection, used to re-prove a runner binding at dispatch (never cached) */
  connections: ConnectionLookup;
  events: RunnerEventSink;
  /**
   * True when the broker revoked this capability grant. Consulted at dispatch so a grant revoked after it was issued
   * stops the job. The default reads the platform grant row (an unknown jti is not revoked); the composition root or a
   * test that supplies its own store supplies its own answer, and without one no revocation source exists.
   */
  grantRevoked?(workspaceId: string, jti: string): Promise<boolean>;
  /**
   * Lifecycle of a grant on the store's clock. The recall check before an agent's result is accepted refuses every
   * status but `active` and `consumed`; without it the revocation hook above is the only source.
   */
  grantStatus?(workspaceId: string, jti: string): Promise<GrantStatus>;
  /** epoch milliseconds (tests fake it; it must be the clock the store uses when they do) */
  now(): number;
  /** wait `ms`, rejecting with an AbortError when `signal` aborts */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  /** long-poll / await polling step */
  pollStepMs: number;
}

export function realSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function abortError(): Error {
  const e = new Error("The operation was aborted.");
  e.name = "AbortError";
  return e;
}

const noopEvents: RunnerEventSink = { emit: () => undefined };

type G = typeof globalThis & { __zenithRunnerStore?: { db: unknown; store: RunnerStore }; __zenithRunnerSealer?: { key: string; sealer: ResultSealer } };

let override: Partial<RunnerRuntime> = {};

/** Register the composition root's adapters at boot, or fakes in tests. Replaces any earlier override. */
export function configureRunnerRuntime(next: Partial<RunnerRuntime>): void {
  override = { ...next };
}

export function resetRunnerRuntime(): void {
  override = {};
  const g = globalThis as G;
  delete g.__zenithRunnerStore;
  delete g.__zenithRunnerSealer;
}

async function defaultStore(): Promise<RunnerStore> {
  const g = globalThis as G;
  const db = await platformDb();
  if (g.__zenithRunnerStore?.db !== db) g.__zenithRunnerStore = { db, store: createPlatformRunnerStore(db) };
  return g.__zenithRunnerStore.store;
}

function defaultSealer(): ResultSealer {
  const g = globalThis as G;
  const key = createHash("sha256").update(`${process.env.ZENITH_RUNNER_RESULT_KEY ?? ""}|${process.env.ZENITH_RUNNER_RESULT_PREVIOUS_KEYS ?? ""}|${process.env.ZENITH_CONTROL_SIGNING_JWK ?? ""}`).digest("hex");
  if (g.__zenithRunnerSealer?.key !== key) g.__zenithRunnerSealer = { key, sealer: createResultSealerFromEnv() };
  return g.__zenithRunnerSealer.sealer;
}

export async function getRunnerRuntime(): Promise<RunnerRuntime> {
  const o = override;
  const signer = o.signer ?? (await getControlSigner());
  if (!signer) throw new RunnerConfigError("No control-plane signing key is configured (ZENITH_CONTROL_SIGNING_JWK or ZENITH_CONTROL_KMS_KEY_ID); the runner plane cannot sign jobs.");
  return {
    store: o.store ?? (await defaultStore()),
    signer,
    verificationKeys: o.verificationKeys ?? (o.signer ? async () => [o.signer!.publicJwk()] : () => getControlVerificationKeys()),
    sealer: o.sealer ?? defaultSealer(),
    connections: o.connections ?? (async (workspaceId, connectionId) => repos.connections.get(await platformDb(), workspaceId, connectionId)),
    events: o.events ?? noopEvents,
    grantRevoked: o.grantRevoked ?? (o.store ? undefined : async (workspaceId, jti) => repos.grants.isRevoked(await platformDb(), workspaceId, jti)),
    grantStatus: o.grantStatus ?? (o.store ? undefined : async (workspaceId, jti) => repos.grants.status(await platformDb(), workspaceId, jti)),
    now: o.now ?? Date.now,
    sleep: o.sleep ?? realSleep,
    pollStepMs: o.pollStepMs ?? POLL_STEP_MS,
  };
}

/** The keys an agent pins at registration: the active signing key. */
export const controlPlaneKeys = (rt: Pick<RunnerRuntime, "signer">): ControlKey[] => [controlKeyOf(rt.signer.publicJwk())];

/** Announced rotation keys (heartbeat `nextKeys`): every verification key that is not the active one. */
export async function announcedNextKeys(rt: Pick<RunnerRuntime, "signer" | "verificationKeys">): Promise<ControlKey[]> {
  return (await rt.verificationKeys()).filter((k) => k.kid !== rt.signer.kid && k.x).map(controlKeyOf);
}
