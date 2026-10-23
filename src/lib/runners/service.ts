/**
 * The agent-facing protocol operations: registration tokens, registration,
 * poll, heartbeat, result, logs, revoke, and the reaper.
 *
 * The routes are thin: they authenticate the request (`request-auth`), check
 * that the URL's agent is the signer, read the raw body once, and call one of
 * these functions with the authenticated `AgentRecord`. Everything here is
 * scoped by `agent.workspaceId` — the workspace of the agent's own row.
 *
 * Delivery and settlement guarantees:
 *  - `claimNext` is exclusive and nothing is re-queued. A claimed job is moved
 *    to `running` (lease = its timeout + grace) before the poll response leaves;
 *    response loss can still leave delivery uncertain.
 *  - A result settles an active job at most once. The first authenticated
 *    outcome is retained independently; exact logical retries are accepted,
 *    divergent retries conflict, and late evidence cannot reopen a job.
 *  - Outcomes are sealed (`seal.ts`) before persistence. Historical active
 *    error projections and log lines are redacted (`redact.ts`).
 *  - A result or log for a job that is not this agent's is `404 job_not_found`
 *    (never a hint that the job exists for someone else).
 */
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { canonical, digest, sha256Hex } from "@/lib/controlplane/digest";
import { log } from "@/lib/log";
import { queueOf, registryOf, RunnerStoreError, type AgentEffectReceipt, type AgentJob, type AgentRecord, type JobLogLine, type RunnerEvent, type SettledOutcome } from "@/lib/runners/ports";
import { sanitizeInboundResult } from "@/lib/runners/custody";
import { redactText } from "@/lib/runners/redact";
import { parseLifecycleReport } from "@/lib/runners/lifecycle";
import { selectRegistrationProtocol } from "@/lib/runners/protocol-window";
import { announcedNextKeys, controlPlaneKeys, type RunnerRuntime } from "@/lib/runners/runtime";
import { unverifiedClaims } from "@/lib/runners/signing";
import {
  AGENT_KINDS,
  AgentApiError,
  CLAIM_LEASE_MS,
  DEFAULT_POLL_INTERVAL_SEC,
  LEASE_GRACE_SEC,
  MAX_LOG_BYTES_PER_JOB,
  MAX_RESULT_BODY_BYTES,
  MAX_LOG_LINES_PER_JOB,
  MAX_LOG_LINE_CHARS,
  MAX_POLL_WAIT_SEC,
  MAX_REGISTRATION_TOKEN_TTL_SEC,
  STORE_LOG_BATCH_LINES,
  isValidId,
  type AgentKind,
} from "@/lib/runners/types";

/* ------------------------------ event emission ------------------------------ */

async function emit(rt: Pick<RunnerRuntime, "events">, event: RunnerEvent): Promise<void> {
  try {
    await rt.events.emit(event);
  } catch (error) {
    // an event sink failure must never fail the protocol step that caused it
    log.warn("runner event sink failed", { scope: "runners", type: event.type, error });
  }
}

/* ---------------------------- registration tokens ---------------------------- */

export interface CreatedRegistrationToken {
  /** the raw token — returned ONCE; only its SHA-256 is stored */
  token: string;
  kind: AgentKind;
  workspaceId: string;
  expiresAt: string;
}

export function generateRegistrationToken(kind: AgentKind): { token: string; tokenHash: string } {
  const token = `${AGENT_KINDS[kind].tokenPrefix}_${randomBytes(24).toString("base64url")}`;
  return { token, tokenHash: sha256Hex(token) };
}

export async function createRegistrationToken(
  rt: RunnerRuntime,
  input: { workspaceId: string; kind: AgentKind; createdBy: string; ttlSec?: number; binding?: { environmentId?: string; address?: string } }
): Promise<CreatedRegistrationToken> {
  const ttlSec = Math.max(1, Math.min(MAX_REGISTRATION_TOKEN_TTL_SEC, Math.trunc(input.ttlSec ?? MAX_REGISTRATION_TOKEN_TTL_SEC)));
  const { token, tokenHash } = generateRegistrationToken(input.kind);
  const binding = input.kind === "machine" ? input.binding : undefined;
  const created = await rt.store.tokens.create({ workspaceId: input.workspaceId, kind: input.kind, binding, createdBy: input.createdBy, tokenHash, ttlMs: ttlSec * 1000 });
  return { token, kind: input.kind, workspaceId: input.workspaceId, expiresAt: created.expiresAt };
}

/* --------------------------------- schemas --------------------------------- */

const PRINTABLE = /^[^\u0000-\u001f\u007f]*$/;
const PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/;

const RegisterBody = z.object({
  token: z.string().regex(/^z[rm]t_[A-Za-z0-9_-]{16,128}$/),
  publicKey: z.string().regex(PUBLIC_KEY),
  name: z.string().trim().min(1).max(128).regex(PRINTABLE),
  version: z.string().max(64).regex(PRINTABLE).optional(),
  /** protocol ids the agent speaks, newest first; absent means the v1 baseline (PROD-OPS-03 negotiation) */
  protocols: z.array(z.string().regex(/^zenith\.(?:runner|machine)\/v[1-9][0-9]{0,2}$/)).min(1).max(8).optional(),
  capabilities: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)).max(32).prefault([]),
  labels: z
    .record(z.string(), z.string().max(253).regex(PRINTABLE))
    .refine((l) => Object.keys(l).length <= 32 && Object.keys(l).every((k) => k.length >= 1 && k.length <= 63 && PRINTABLE.test(k)), "at most 32 labels; keys 1-63 printable characters")
    .prefault({}),
  host: z
    .record(z.string(), z.string().max(64).regex(PRINTABLE))
    .refine((h) => Object.keys(h).length <= 8, "at most 8 host members")
    .prefault({}),
});

const HeartbeatBody = z.object({
  version: z.string().max(64).regex(PRINTABLE).optional(),
  capabilities: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)).max(32).optional(),
  running: z.number().int().min(0).max(10_000).optional(),
  host: z
    .record(z.string(), z.string().max(64).regex(PRINTABLE))
    .refine((h) => Object.keys(h).length <= 8, "at most 8 host members")
    .optional(),
  /** informational delivery report; validated separately so a bad one never fails the heartbeat */
  lifecycle: z.unknown().optional(),
});

const PollBody = z.object({ max: z.number().int().min(1).max(10).prefault(1), waitSec: z.number().int().min(0).max(25).prefault(0) });

const ResultBody = z.object({
  status: z.enum(["succeeded", "failed", "rejected", "timed_out"]),
  startedAt: z.string().max(64).optional(),
  finishedAt: z.string().max(64).optional(),
  exitCode: z.number().int().optional(),
  result: z.unknown().optional(),
  error: z.string().max(100_000).optional(),
}).strict();

const LogsBody = z.object({
  seq: z.number().int().min(0).max(500_000_000),
  lines: z
    .array(z.object({ ts: z.string().max(64).optional(), stream: z.enum(["stdout", "stderr", "info"]), line: z.string() }))
    .max(2000),
});

function parse<T>(schema: z.ZodType<T, unknown>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) {
    const issue = r.error.issues[0];
    throw new AgentApiError(400, "invalid_request", `Invalid request body: ${issue.path.join(".") || "body"}: ${issue.message}`);
  }
  return r.data;
}

/* ------------------------------- registration ------------------------------- */

export interface RegistrationResponse {
  id: string;
  workspaceId: string;
  controlPlaneKeys: { kid: string; publicKey: string }[];
  pollIntervalSec: number;
  protocol: string;
  /** the N and N-1 protocols this control plane serves, newest first */
  supportedProtocols: string[];
  /** the agent negotiated an N-1 protocol and should be upgraded */
  protocolDeprecated: boolean;
}

/** `POST /{runners|machines}/register`. The token is consumed in the same step that creates the agent. */
export async function registerAgent(rt: RunnerRuntime, kind: AgentKind, body: unknown): Promise<RegistrationResponse> {
  const b = parse(RegisterBody, body);
  // Negotiate BEFORE the token is consumed: an agent outside the N-1 window is refused with 426 and keeps its token.
  const selected = selectRegistrationProtocol(kind, b.protocols);
  let agent: AgentRecord;
  try {
    agent = await registryOf(rt.store, kind).register({
      tokenHash: sha256Hex(b.token),
      name: b.name,
      publicKey: b.publicKey,
      protocol: selected.protocol,
      version: b.version,
      capabilities: b.capabilities,
      labels: b.labels,
      host: b.host,
    });
  } catch (error) {
    if (error instanceof RunnerStoreError && error.code === "invalid_registration_token")
      throw new AgentApiError(401, "invalid_registration_token", "The registration token is invalid, expired, already used, or for another kind of agent.");
    throw error;
  }
  await emit(rt, { type: kind === "runner" ? "runner.registered" : "machine.registered", workspaceId: agent.workspaceId, agentId: agent.id, data: { name: agent.name, version: agent.version, capabilities: agent.capabilities } });
  return { id: agent.id, workspaceId: agent.workspaceId, controlPlaneKeys: controlPlaneKeys(rt), pollIntervalSec: DEFAULT_POLL_INTERVAL_SEC, protocol: agent.protocol, supportedProtocols: [...AGENT_KINDS[kind].protocols], protocolDeprecated: selected.deprecated };
}

/* ---------------------------------- heartbeat ---------------------------------- */

export async function heartbeatAgent(rt: RunnerRuntime, agent: AgentRecord, body: unknown): Promise<{ revoked: boolean; nextKeys?: { kid: string; publicKey: string }[]; pollIntervalSec: number }> {
  const b = parse(HeartbeatBody, body);
  const lifecycle = parseLifecycleReport(b.lifecycle);
  if (b.lifecycle !== undefined && b.lifecycle !== null && !lifecycle) log.warn("dropped a malformed agent lifecycle report", { scope: "runners", agentId: agent.id });
  const res = await registryOf(rt.store, agent.kind).heartbeat({ workspaceId: agent.workspaceId, id: agent.id, version: b.version, capabilities: b.capabilities, host: b.host, lifecycle });
  if (!res || res.revoked) return { revoked: true, pollIntervalSec: DEFAULT_POLL_INTERVAL_SEC };
  const next = await announcedNextKeys(rt);
  return { revoked: false, ...(next.length > 0 ? { nextKeys: next } : {}), pollIntervalSec: DEFAULT_POLL_INTERVAL_SEC };
}

/* ------------------------------------ poll ------------------------------------ */

/** The job timeout is in the envelope this control plane signed; it sizes the lease. */
function leaseMsFor(job: AgentJob): number {
  const claims = unverifiedClaims(job.envelope);
  const timeoutSec = typeof claims?.timeoutSec === "number" && claims.timeoutSec > 0 ? claims.timeoutSec : 1800;
  return Math.ceil((timeoutSec + LEASE_GRACE_SEC) * 1000);
}

const revokedError = (): AgentApiError => new AgentApiError(401, "agent_revoked", "This agent is unknown or has been revoked; stop and re-register with a new token.");

/**
 * Long-poll: claim up to `max` jobs, waiting up to min(`waitSec`, 20) s in
 * `rt.pollStepMs` steps (serverless-safe: the wait never exceeds one function
 * invocation). Revocation is re-checked every few steps so a revoked agent is
 * told promptly instead of at the end of the wait.
 */
/** True when the grant embedded in the (control-plane signed) envelope has been revoked since the job was enqueued. */
async function grantRevokedFor(rt: RunnerRuntime, job: AgentJob): Promise<boolean> {
  if (!rt.grantRevoked) return false;
  const grant = unverifiedClaims(job.envelope)?.grant;
  const jti = typeof grant === "string" ? unverifiedClaims(grant)?.jti : undefined;
  return typeof jti === "string" && (await rt.grantRevoked(job.workspaceId, jti));
}

export async function pollAgent(rt: RunnerRuntime, agent: AgentRecord, body: unknown, signal?: AbortSignal): Promise<{ jobs: string[]; pollIntervalSec: number }> {
  const b = parse(PollBody, body);
  const queue = queueOf(rt.store, agent.kind);
  const registry = registryOf(rt.store, agent.kind);
  const deadline = rt.now() + Math.min(b.waitSec, MAX_POLL_WAIT_SEC) * 1000;
  for (let i = 0; ; i++) {
    if (signal?.aborted) return { jobs: [], pollIntervalSec: DEFAULT_POLL_INTERVAL_SEC };
    const claimed = await queue.claimNext({ workspaceId: agent.workspaceId, agentId: agent.id, max: b.max, leaseMs: CLAIM_LEASE_MS });
    const delivered: string[] = [];
    for (const job of claimed) {
      // A grant revoked after enqueue must never reach the agent: withdraw the claimed job as refused instead of handing it over.
      if (await grantRevokedFor(rt, job)) {
        await queue.settle({ workspaceId: agent.workspaceId, agentId: agent.id, jobId: job.id, status: "rejected", error: "The capability grant was revoked before this job was delivered; it was withdrawn." });
        await emit(rt, { type: "runner.job.completed", workspaceId: agent.workspaceId, operationId: job.operationId, agentId: agent.id, data: { jobId: job.id, kind: job.kind, capability: job.capability, agentKind: agent.kind, status: "rejected", reason: "grant_revoked" } });
        continue;
      }
      const started = await queue.markRunning({ workspaceId: agent.workspaceId, agentId: agent.id, jobId: job.id, leaseMs: leaseMsFor(job) });
      if (!started) continue; // lease lapsed between claim and hand-over: not delivered, the reaper settles it
      delivered.push(job.envelope);
      await emit(rt, {
        type: "runner.job.dispatched",
        workspaceId: agent.workspaceId,
        operationId: job.operationId,
        agentId: agent.id,
        data: { jobId: job.id, kind: job.kind, capability: job.capability, agentKind: agent.kind },
      });
    }
    if (delivered.length > 0) return { jobs: delivered, pollIntervalSec: DEFAULT_POLL_INTERVAL_SEC };
    if (rt.now() >= deadline) return { jobs: [], pollIntervalSec: DEFAULT_POLL_INTERVAL_SEC };
    if (i % 5 === 4) {
      const current = await registry.get(agent.workspaceId, agent.id);
      if (!current || current.status !== "active") throw revokedError();
    }
    try {
      await rt.sleep(Math.min(rt.pollStepMs, Math.max(1, deadline - rt.now())), signal);
    } catch {
      return { jobs: [], pollIntervalSec: DEFAULT_POLL_INTERVAL_SEC }; // the agent went away
    }
  }
}

/* ----------------------------------- results ----------------------------------- */

/** What `settle` stores: timing in the clear, everything else sealed. */
export interface StoredResult {
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number;
  sealed: unknown;
}

export const sealAad = (workspaceId: string, jobId: string): string => `${workspaceId}|${jobId}`;
/** Tenant/job and authenticated assignment associations are part of ciphertext integrity. */
export const effectReceiptAad = (workspaceId: string, kind: AgentKind, jobId: string,
  binding: Pick<AgentEffectReceipt, "agentId" | "agentKeyDigest" | "envelopeDigest">): string =>
  `${workspaceId}|${kind}|${jobId}|${binding.agentId}|${binding.agentKeyDigest}|${binding.envelopeDigest}|effect-receipt:v1`;

const isoOrUndefined = (s: string | undefined): string | undefined => {
  if (!s) return undefined;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
};

const MAX_ERROR_CHARS = 4000;
const NOT_AWAITING = "This job is not awaiting a result: it already has one, was cancelled or timed out, or was never delivered.";

export const redactError = (s: string): string => redactText(s).slice(0, MAX_ERROR_CHARS);

/** Bounded plain JSON only; generic errors never echo untrusted result keys/values. */
function outcomeBody(value: unknown): z.infer<typeof ResultBody> {
  const parsed = ResultBody.safeParse(value);
  const invalid = (): never => { throw new AgentApiError(400, "invalid_request", "Invalid result body."); };
  if (!parsed.success) return invalid();
  const seen = new WeakSet<object>();
  const pending: { value: unknown; depth: number }[] = [{ value: parsed.data.result ?? null, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const { value: current, depth } = pending.pop()!;
    if (++nodes > 100_000 || depth > 64) return invalid();
    if (current === null || typeof current === "string" || typeof current === "boolean") continue;
    if (typeof current === "number" && Number.isFinite(current)) continue;
    if (typeof current !== "object" || seen.has(current)) return invalid();
    if (!Array.isArray(current) && Object.getPrototypeOf(current) !== Object.prototype && Object.getPrototypeOf(current) !== null) return invalid();
    seen.add(current);
    // Bound queued work too: a broad JSON array/object must not allocate an
    // unbounded pending list before the visited-node limit can reject it.
    for (const key in current) {
      if (!Object.prototype.hasOwnProperty.call(current, key)) continue;
      if (nodes + pending.length >= 100_000) return invalid();
      pending.push({ value: (current as Record<string, unknown>)[key], depth: depth + 1 });
    }
  }
  if (parsed.data.exitCode !== undefined && !Number.isSafeInteger(parsed.data.exitCode)) return invalid();
  const normalized = { ...parsed.data, result: parsed.data.result ?? null };
  const text = canonical(normalized);
  if (Buffer.byteLength(text, "utf8") > MAX_RESULT_BODY_BYTES) throw new AgentApiError(413, "payload_too_large", "The parsed result exceeds the supported bound.");
  return JSON.parse(text) as z.infer<typeof ResultBody>;
}

/** Signed current-agent outcome: active settlement or independent late evidence, never reopening a terminal job. */
export async function settleResult(rt: RunnerRuntime, agent: AgentRecord, jobId: string, body: unknown): Promise<{ status: "accepted" }> {
  if (!isValidId(jobId)) throw new AgentApiError(404, "job_not_found", "No such job for this agent.");
  const b = outcomeBody(body);
  const queue = queueOf(rt.store, agent.kind);
  const job = await queue.get(agent.workspaceId, jobId);
  if (!job || job.agentId !== agent.id) throw new AgentApiError(404, "job_not_found", "No such job for this agent.");
  // The assignment trigger prevents substitution after this read. The store
  // independently derives these same hashes under its original-job lock and
  // holds the authenticated current-key predicate until receipt commit.
  const receiptBinding = { agentId: agent.id, agentKeyDigest: sha256Hex(agent.publicKey), envelopeDigest: sha256Hex(job.envelope) };
  // A local_only runner never sends credential material. If one did anyway, what is sealed has the
  // shapes replaced by markers (the logical digest below stays over what the runner sent, so a retry still matches).
  const inbound = agent.kind === "runner" ? sanitizeInboundResult(agent, b.result ?? null) : { value: b.result ?? null, kinds: [] as string[] };
  const sealedBody = inbound.kinds.length > 0 ? { ...b, result: inbound.value } : b;
  const stored = {
    startedAt: isoOrUndefined(b.startedAt),
    finishedAt: isoOrUndefined(b.finishedAt),
    exitCode: b.exitCode,
    sealed: rt.sealer.seal(sealAad(agent.workspaceId, jobId), sealedBody.result ?? null),
  };
  let settled: SettledOutcome;
  try {
    settled = await queue.settleOutcome({
      workspaceId: agent.workspaceId, agentId: agent.id, jobId, authenticatedPublicKey: agent.publicKey,
      logicalDigest: digest(b), status: b.status,
      sealed: rt.sealer.seal(effectReceiptAad(agent.workspaceId, agent.kind, jobId, receiptBinding), sealedBody), result: stored,
      error: b.error === undefined ? undefined : redactError(b.error),
    });
  } catch (error) {
    if (error instanceof RunnerStoreError) {
      if (error.code === "agent_revoked") throw revokedError();
      if (error.code === "not_found") throw new AgentApiError(404, "job_not_found", "No such job for this agent.");
      if (error.code === "conflict") throw new AgentApiError(409, "already_settled", NOT_AWAITING);
    }
    throw error;
  }
  // Historical completion events mean an active job actually settled. Late
  // evidence is audited in the permanent receipt, with no misleading completion
  // event or new operation transition. A sink failure cannot erase that receipt.
  if (settled.disposition === "settled") await emit(rt, {
    type: agent.kind === "runner" ? "runner.job.completed" : "machine.request.completed",
    workspaceId: agent.workspaceId,
    operationId: job.operationId,
    agentId: agent.id,
    data: { jobId, kind: job.kind, status: b.status, agentKind: agent.kind, ...(inbound.kinds.length > 0 ? { custody: { credentialMaterialSanitized: true, kinds: inbound.kinds } } : {}) },
  });
  return { status: "accepted" };
}

/* ------------------------------------ logs ------------------------------------ */

/**
 * `POST /{runners|machines}/{id}/jobs/{jti}/logs` — advisory, bounded, redacted.
 *
 * The call body is capped at 64 KiB by the caller. A batch can still hold more
 * lines than the store accepts per append (the Go agent counts 64 bytes of
 * overhead per line, so a 60 KiB batch may carry ~900 tiny lines; the DB takes
 * 500), so a batch is split into sub-batches with the derived sequence number
 * `seq * 4 + part` — a retried POST of the same `seq` reproduces the same keys
 * and does not duplicate lines. Past the per-job byte or line cap further lines
 * are dropped and the call still succeeds (`truncated: true`): log streaming
 * must never be able to fail a job.
 */
export async function appendAgentLogs(rt: RunnerRuntime, agent: AgentRecord, jobId: string, body: unknown): Promise<{ stored: number; truncated: boolean }> {
  if (!isValidId(jobId)) throw new AgentApiError(404, "job_not_found", "No such job for this agent.");
  const b = parse(LogsBody, body);
  const queue = queueOf(rt.store, agent.kind);
  const job = await queue.get(agent.workspaceId, jobId);
  if (!job || job.agentId !== agent.id) throw new AgentApiError(404, "job_not_found", "No such job for this agent.");
  if (job.status !== "claimed" && job.status !== "running") throw new AgentApiError(409, "already_settled", "This job already has a result (or was cancelled or timed out); its log stream is closed.");

  const usage = await queue.logUsage(agent.workspaceId, jobId);
  let bytesLeft = MAX_LOG_BYTES_PER_JOB - usage.bytes;
  let linesLeft = MAX_LOG_LINES_PER_JOB - usage.lines;
  const lines: JobLogLine[] = [];
  let truncated = false;
  const nowIso = new Date(rt.now()).toISOString();
  for (const l of b.lines) {
    const text = redactText(l.line.length > MAX_LOG_LINE_CHARS ? l.line.slice(0, MAX_LOG_LINE_CHARS) : l.line);
    const size = Buffer.byteLength(text, "utf8");
    if (linesLeft <= 0 || size > bytesLeft) {
      truncated = true;
      break;
    }
    bytesLeft -= size;
    linesLeft--;
    lines.push({ ts: isoOrUndefined(l.ts) ?? nowIso, stream: l.stream, line: text });
  }
  let stored = 0;
  for (let part = 0, i = 0; i < lines.length && part < 4; part++, i += STORE_LOG_BATCH_LINES) {
    const n = await queue.appendLogs({ workspaceId: agent.workspaceId, agentId: agent.id, jobId, batchSeq: b.seq * 4 + part, lines: lines.slice(i, i + STORE_LOG_BATCH_LINES) });
    if (n === null) throw new AgentApiError(404, "job_not_found", "No such job for this agent.");
    stored += n;
  }
  return { stored, truncated };
}

/* ------------------------------------ revoke ------------------------------------ */

export async function revokeAgent(rt: RunnerRuntime, kind: AgentKind, workspaceId: string, id: string, actorId: string): Promise<{ id: string; status: "revoked"; cancelledJobs: number }> {
  if (!isValidId(id)) throw new AgentApiError(404, "not_found", "No such runner or machine in this workspace.");
  const res = await registryOf(rt.store, kind).revoke(workspaceId, id);
  if (!res) throw new AgentApiError(404, "not_found", "No such runner or machine in this workspace.");
  await emit(rt, { type: kind === "runner" ? "runner.revoked" : "machine.revoked", workspaceId, agentId: id, actorId, data: { cancelledJobs: res.cancelledJobs } });
  return { id, status: "revoked", cancelledJobs: res.cancelledJobs };
}

/* ------------------------------------- reaper ------------------------------------- */

/**
 * Settle work whose agent went silent: unclaimed past expiry → `expired`,
 * claimed/running past lease → `timed_out`. Returns the affected jobs so the
 * caller reconciles each owning operation to `uncertain`. Never re-queues.
 * Wire this to a periodic tick (`/api/internal/tick/*`) or a Temporal schedule.
 */
export async function reapExpiredJobs(rt: Pick<RunnerRuntime, "store" | "events">, limit = 100): Promise<{ runnerJobs: AgentJob[]; machineRequests: AgentJob[] }> {
  const runnerJobs = await rt.store.jobs.expireStale(limit);
  const machineRequests = await rt.store.machineRequests.expireStale(limit);
  for (const [jobs, kind] of [
    [runnerJobs, "runner"],
    [machineRequests, "machine"],
  ] as const) {
    for (const j of jobs)
      await emit(rt, {
        type: kind === "runner" ? "runner.job.completed" : "machine.request.completed",
        workspaceId: j.workspaceId,
        operationId: j.operationId,
        agentId: j.agentId,
        data: { jobId: j.id, kind: j.kind, status: j.status, agentKind: kind },
      });
  }
  return { runnerJobs, machineRequests };
}
