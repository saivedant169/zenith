/**
 * Control-plane side of the runner / zenithd wire protocol
 * (docs/platform/RUNNER-PROTOCOL.md). This file holds the vocabulary the
 * rest of `src/lib/runners` shares: protocol ids, JWS `typ` values, envelope
 * shapes, limits and the error type every agent-facing route answers with.
 *
 * Invariants (every module in this directory):
 *  1. Agents authenticate with a per-request Ed25519 signature (`request-auth`);
 *     nothing here trusts an id, workspace or capability an agent merely claims.
 *  2. Every store call after authentication is scoped by the AGENT'S workspace
 *     (taken from its own row, never from the URL or the body).
 *  3. Jobs are signed by the control plane (`signing`); a job is delivered at
 *     most once and settled at most once; nothing is ever re-dispatched.
 *  4. No secret values in stored results, logs, events or errors. Results are
 *     sealed at rest (`seal`), log lines and error strings are redacted.
 */

export type AgentKind = "runner" | "machine";

export const RUNNER_PROTOCOL = "zenith.runner/v1";
export const MACHINE_PROTOCOL = "zenith.machine/v1";

/**
 * Protocol support windows (PROD-OPS-03). `current` is what a new agent registers
 * with; `previous` is the N-1 window this control plane still serves so agents can
 * be upgraded after the control plane (rolling upgrade). At most ONE previous
 * protocol is ever listed, and it is dropped one release after the next protocol
 * ships. Anything outside the window is refused with 426 upgrade_required
 * (`src/lib/runners/protocol-window.ts`). Both kinds are on v1 today, so the N-1
 * list is empty; adding `zenith.runner/v2` means moving v1 into `previous` here.
 */
export interface ProtocolWindow {
  current: string;
  previous: readonly string[];
}
export const RUNNER_PROTOCOL_WINDOW: ProtocolWindow = { current: RUNNER_PROTOCOL, previous: [] };
export const MACHINE_PROTOCOL_WINDOW: ProtocolWindow = { current: MACHINE_PROTOCOL, previous: [] };

/** JWS `typ` header values (spec section 1). */
export const TYP_JOB = "zenith-job+jwt";
export const TYP_MACHINE = "zenith-machine+jwt";
export const TYP_GRANT = "zenith-grant+jwt";
export type JwsTyp = typeof TYP_JOB | typeof TYP_MACHINE | typeof TYP_GRANT;

export interface AgentKindInfo {
  kind: AgentKind;
  /** the protocol ids this control plane speaks for the kind: current first, then the N-1 window */
  protocols: readonly string[];
  /** the explicit support window `protocols` is derived from */
  window: ProtocolWindow;
  /** URL collection: `/api/platform/v1/<collection>/…` */
  collection: "runners" | "machines";
  idPrefix: "run" | "mac";
  /** id prefix of one queued unit of work (`jti`) */
  jobPrefix: "job" | "mreq";
  tokenPrefix: "zrt" | "zmt";
  jobTyp: typeof TYP_JOB | typeof TYP_MACHINE;
}

export const AGENT_KINDS: Record<AgentKind, AgentKindInfo> = {
  runner: { kind: "runner", protocols: [RUNNER_PROTOCOL_WINDOW.current, ...RUNNER_PROTOCOL_WINDOW.previous], window: RUNNER_PROTOCOL_WINDOW, collection: "runners", idPrefix: "run", jobPrefix: "job", tokenPrefix: "zrt", jobTyp: TYP_JOB },
  machine: { kind: "machine", protocols: [MACHINE_PROTOCOL_WINDOW.current, ...MACHINE_PROTOCOL_WINDOW.previous], window: MACHINE_PROTOCOL_WINDOW, collection: "machines", idPrefix: "mac", jobPrefix: "mreq", tokenPrefix: "zmt", jobTyp: TYP_MACHINE },
};

export const API_PREFIX = "/api/platform/v1";

/** Request-signing header names (spec section 3). */
export const HEADER_AGENT = "x-zenith-agent";
export const HEADER_TIMESTAMP = "x-zenith-timestamp";
export const HEADER_NONCE = "x-zenith-nonce";
export const HEADER_CONTENT_SHA256 = "x-zenith-content-sha256";
export const HEADER_SIGNATURE = "x-zenith-signature";
/**
 * Optional, informational (NOT in the spec): an agent MAY name the protocol it
 * speaks so the server can answer `426 upgrade_required` before verifying. The
 * protocol id is otherwise only inside the signed string.
 */
export const HEADER_PROTOCOL = "x-zenith-protocol";

/* --------------------------------- limits --------------------------------- */

/** Clock skew tolerated on request timestamps and envelope iat/exp (spec section 3). */
export const SKEW_SEC = 60;
/** A nonce seen within this window for an agent is a replay (spec section 3). */
export const NONCE_WINDOW_MS = 10 * 60 * 1000;
/** Three missed 30 s heartbeats (spec section 6). */
export const STALE_AFTER_SEC = 90;
/** Long-poll bound: serverless-safe, tighter than the spec's 25 s. */
export const MAX_POLL_WAIT_SEC = 20;
export const POLL_STEP_MS = 500;
export const DEFAULT_POLL_INTERVAL_SEC = 5;
/** Registration tokens live at most one hour (spec section 2). */
export const MAX_REGISTRATION_TOKEN_TTL_SEC = 60 * 60;

/** Request bodies, by endpoint class. Read once, with a hard cap, before hashing. */
export const MAX_SMALL_BODY_BYTES = 64 * 1024;
export const MAX_LOG_BODY_BYTES = 64 * 1024;
/** One result. The Go agent defaults to 4 MiB (serverless request limit), max 64 MiB. */
export const MAX_RESULT_BODY_BYTES = 16 * 1024 * 1024;

/** A compact JWS the store will keep (ws-db `runner_jobs.envelope`). */
export const MAX_ENVELOPE_BYTES = 256 * 1024;
/**
 * After the job's own timeout, how long the control plane still expects the
 * agent to report (the Go agent retries result posts for several minutes).
 */
export const LEASE_GRACE_SEC = 150;
/** Lease taken at claim time, only to cover the hand-off to `markRunning`. */
export const CLAIM_LEASE_MS = 60_000;

export const MAX_LOG_BYTES_PER_JOB = 4 * 1024 * 1024;
export const MAX_LOG_LINES_PER_JOB = 20_000;
export const MAX_LOG_LINE_CHARS = 8192;
/** ws-db `runner_job_logs` accepts at most this many lines per append call. */
export const STORE_LOG_BATCH_LINES = 500;

/* -------------------------------- job kinds -------------------------------- */

export const RUNNER_JOB_KINDS = ["tofu.run", "aws.http", "oci.http", "k8s.http", "probe.http", "probe.tcp", "probe.dns"] as const;
export type RunnerJobKind = (typeof RUNNER_JOB_KINDS)[number];

/* -------------------------------- envelopes -------------------------------- */

/** Signed payload of a runner job (`typ: zenith-job+jwt`). Key order is the wire order. */
export interface JobEnvelope {
  protocol: string;
  jti: string;
  runnerId: string;
  workspaceId: string;
  operationId: string;
  capability: string;
  kind: RunnerJobKind;
  payload: unknown;
  grant: string;
  iat: number;
  exp: number;
  timeoutSec: number;
  maxOutputBytes: number;
}

/** Signed payload of a zenithd request (`typ: zenith-machine+jwt`). */
export interface MachineEnvelope {
  protocol: string;
  jti: string;
  machineId: string;
  workspaceId: string;
  operationId: string;
  operation: string;
  args: Record<string, unknown>;
  grant: string;
  iat: number;
  exp: number;
  timeoutSec: number;
  maxOutputBytes: number;
}

/** What an agent may report for one job (spec section 4). */
export type AgentResultStatus = "succeeded" | "failed" | "rejected" | "timed_out";

/* --------------------------------- errors ---------------------------------- */

export type AgentApiErrorCode =
  | "invalid_request"
  | "missing_signature_headers"
  | "agent_revoked"
  | "agent_mismatch"
  | "invalid_signature"
  | "clock_skew"
  | "nonce_replayed"
  | "body_digest_mismatch"
  | "invalid_registration_token"
  | "job_not_found"
  | "already_settled"
  | "payload_too_large"
  | "upgrade_required"
  | "not_found"
  | "grant_not_active"
  | "runner_plane_unconfigured";

/**
 * An error an agent-facing route answers with. The body is
 * `{ error: { code, message, … } }`, which the Go client's `errorFields`
 * understands (it keys terminal handling on the `code`, not the message).
 */
export class AgentApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: AgentApiErrorCode,
    message: string,
    readonly extra: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "AgentApiError";
  }
}

/** Secrets, keys or the platform store are not wired: the runner plane refuses to guess. */
export class RunnerConfigError extends AgentApiError {
  constructor(message: string) {
    super(503, "runner_plane_unconfigured", message);
    this.name = "RunnerConfigError";
  }
}

/** Identifier shape accepted anywhere an id is placed in a URL or a claim (mirrors the Go `ValidID`). */
export const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
export const isValidId = (s: unknown): s is string => typeof s === "string" && ID_PATTERN.test(s);
