/**
 * Test support for the runner plane: a wired "plane" (store, signer, sealer,
 * clock) and a fake agent that speaks the wire protocol the way the Go agents do.
 *
 * The fake agent builds its signing string and verifies job JWS with node:crypto
 * DIRECTLY — it deliberately does not call `signingString()` or
 * `verifyControlJws()` from the code under test, so a mistake there is caught
 * here instead of being mirrored. The Go golden vectors (fixtures/go-*.json)
 * are the independent ground truth for the byte forms.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign as cryptoSign, verify as cryptoVerify, type KeyObject } from "node:crypto";
import { NextRequest } from "next/server";
import { openPlatformDb, repos, type PlatformDbHandle } from "@/lib/controlplane/db";
import type { CapabilityGrantClaims } from "@/lib/controlplane/types";
import { signCapabilityGrant } from "@/lib/credentials/grants";
import { generateSigningJwk, LocalJwkSigner } from "@/lib/credentials/signing";
import type { JwtSigner } from "@/lib/credentials/signing/types";
import { createPlatformRunnerStore } from "@/lib/runners/db/pg-store";
import { migrationMachineRequests } from "@/lib/runners/db/machine-requests-migration";
import { createMemoryRunnerStore } from "@/lib/runners/memory-store";
import type { RunnerEvent, RunnerStore } from "@/lib/runners/ports";
import { configureRunnerRuntime, controlPlaneKeys, resetRunnerRuntime, realSleep, abortError, type RunnerRuntime } from "@/lib/runners/runtime";
import { createAesResultSealer } from "@/lib/runners/seal";
import { createRegistrationToken } from "@/lib/runners/service";
import { MACHINE_PROTOCOL, RUNNER_PROTOCOL, type AgentKind } from "@/lib/runners/types";

export const ORIGIN = "https://zenith.test";
export const API = "/api/platform/v1";
export const T0 = Date.parse("2026-09-30T12:00:00Z");

export interface Plane {
  rt: RunnerRuntime;
  store: RunnerStore;
  signer: JwtSigner;
  events: RunnerEvent[];
  /** fake clock (mode "fake"); in "real" mode `now` is wall time */
  clock: { t: number };
  /** control-plane public keys as an agent pins them */
  cpKeys: { kid: string; publicKey: string }[];
}

export async function newSigner(kid = "cp-test"): Promise<JwtSigner> {
  const key = await generateSigningJwk("EdDSA", { kid });
  return LocalJwkSigner.fromJwk("test", key.privateJwk, { alg: "EdDSA", kid });
}

/**
 * "fake": the clock is ours and `sleep` just advances it (deterministic timeouts; use when no
 * concurrent actor needs real time). "real": wall clock with a few-ms poll step (end-to-end
 * flows where a fake agent serves jobs concurrently).
 *
 * `backing`: the in-memory store, or a real platform store on PGlite (the same SQL production
 * runs) — then the store keeps its own (database) clock, so use mode "real" with it.
 */
export async function createPlane(mode: "fake" | "real" = "fake", extra: Partial<RunnerRuntime> = {}, backing: RunnerStore | undefined = undefined): Promise<Plane> {
  const clock = { t: T0 };
  const now = mode === "fake" ? () => clock.t : Date.now;
  const store = backing ?? createMemoryRunnerStore({ now });
  const signer = await newSigner();
  const events: RunnerEvent[] = [];
  const rt: RunnerRuntime = {
    store,
    signer,
    verificationKeys: async () => [signer.publicJwk()],
    sealer: createAesResultSealer(randomBytes(32)),
    connections: async () => null,
    events: { emit: (e) => void events.push(e) },
    now,
    sleep:
      mode === "fake"
        ? async (ms, signal) => {
            if (signal?.aborted) throw abortError();
            clock.t += ms;
            await Promise.resolve();
          }
        : realSleep,
    pollStepMs: mode === "fake" ? 500 : 5,
    ...extra,
  };
  configureRunnerRuntime(rt);
  return { rt, store, signer, events, clock, cpKeys: controlPlaneKeys(rt) };
}

/* ------------------------------ a real platform store ------------------------------ */

export interface DbPlane {
  db: PlatformDbHandle;
  store: RunnerStore;
  /** create the operation row a job's foreign key needs */
  operation(workspaceId: string, id?: string): Promise<string>;
  close(): Promise<void>;
}

/**
 * An in-memory PGlite platform store with the core schema and the machine-request migration
 * applied — the production SQL, no Docker. (The migration is applied here because WS-RUNSRV
 * cannot register it in `PLATFORM_MIGRATIONS`; see the handoff.)
 */
export async function openDbPlane(): Promise<DbPlane> {
  const db = await openPlatformDb({ kind: "pglite" });
  await db.exec(migrationMachineRequests.sql);
  let n = 0;
  return {
    db,
    store: createPlatformRunnerStore(db),
    async operation(workspaceId, id = `op_test_${++n}`) {
      await repos.operations.create(db, {
        id,
        workspaceId,
        principal: { kind: "user", id: "user-admin", name: "Admin" },
        proposal: { capability: "infrastructure.plan", scope: { workspaceId }, input: {}, summary: "test", details: [], risk: "low" },
      });
      return id;
    },
    close: () => db.close(),
  };
}

export const teardownPlane = (): void => resetRunnerRuntime();

/* ------------------------------ route invocation ------------------------------ */

type RouteFn = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

export async function call(handler: unknown, req: NextRequest, params: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> & { error?: { code: string; message: string } }; headers: Headers }> {
  const res = await (handler as RouteFn)(req, { params: Promise.resolve(params) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {}, headers: res.headers };
}

/* --------------------------------- fake agent --------------------------------- */

const b64u = (b: Uint8Array | Buffer): string => Buffer.from(b).toString("base64url");

export function newAgentKey(): { privateKey: KeyObject; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privateKey, publicKey: String(publicKey.export({ format: "jwk" }).x) };
}

export function keyFromSeedHex(seedHex: string): { privateKey: KeyObject; publicKey: string } {
  const seed = Buffer.from(seedHex, "hex");
  const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  const privateKey = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
  return { privateKey, publicKey: String(createPublicKey(privateKey).export({ format: "jwk" }).x) };
}

export interface SignOptions {
  timestamp?: number;
  nonce?: string;
  protocol?: string;
  method?: string;
  /** sign this path but send another */
  signPath?: string;
  /** sign these body bytes but send others */
  signBody?: string;
  agentHeader?: string;
  extraHeaders?: Record<string, string>;
  privateKey?: KeyObject;
}

export interface DecodedJob {
  token: string;
  header: Record<string, unknown>;
  claims: Record<string, unknown> & { jti: string; kind?: string; payload?: unknown; grant: string; capability?: string; operation?: string; args?: unknown };
}

export class FakeAgent {
  readonly protocol: string;
  constructor(
    readonly plane: Plane,
    readonly kind: AgentKind,
    readonly id: string,
    readonly workspaceId: string,
    readonly key: { privateKey: KeyObject; publicKey: string },
    readonly cpKeys: { kid: string; publicKey: string }[]
  ) {
    this.protocol = kind === "runner" ? RUNNER_PROTOCOL : MACHINE_PROTOCOL;
  }

  get collection(): string {
    return this.kind === "runner" ? "runners" : "machines";
  }

  path(suffix: string): string {
    return `${API}/${this.collection}/${this.id}${suffix}`;
  }

  /** A request signed exactly as the Go client signs one. */
  request(method: string, pathAndQuery: string, body?: string, o: SignOptions = {}): NextRequest {
    const ts = o.timestamp ?? Math.floor(this.plane.rt.now() / 1000);
    const nonce = o.nonce ?? b64u(randomBytes(16));
    const signedBody = o.signBody ?? body ?? "";
    const sha = createHash("sha256").update(signedBody, "utf8").digest("hex");
    const signing = [o.protocol ?? this.protocol, (o.method ?? method).toUpperCase(), o.signPath ?? pathAndQuery, String(ts), nonce, sha].join("\n");
    const sig = cryptoSign(null, Buffer.from(signing, "utf8"), o.privateKey ?? this.key.privateKey);
    const headers: Record<string, string> = {
      "x-zenith-agent": o.agentHeader ?? this.id,
      "x-zenith-timestamp": String(ts),
      "x-zenith-nonce": nonce,
      "x-zenith-content-sha256": sha,
      "x-zenith-signature": b64u(sig),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...o.extraHeaders,
    };
    return new NextRequest(new URL(pathAndQuery, ORIGIN), { method, headers, ...(body !== undefined ? { body } : {}) });
  }

  /** Verify a compact JWS with the pinned keys using node:crypto only, and decode it. */
  decodeJob(token: string, typ: string): DecodedJob {
    const [h, p, s] = token.split(".");
    const header = JSON.parse(Buffer.from(h, "base64url").toString("utf8")) as Record<string, unknown>;
    const key = this.cpKeys.find((k) => k.kid === header.kid);
    if (!key) throw new Error(`kid ${String(header.kid)} is not pinned`);
    const pub = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: key.publicKey }, format: "jwk" });
    if (!cryptoVerify(null, Buffer.from(`${h}.${p}`), pub, Buffer.from(s, "base64url"))) throw new Error("job signature does not verify against the pinned key");
    if (header.typ !== typ) throw new Error(`typ ${String(header.typ)} != ${typ}`);
    return { token, header, claims: JSON.parse(Buffer.from(p, "base64url").toString("utf8")) };
  }

  jobTyp(): string {
    return this.kind === "runner" ? "zenith-job+jwt" : "zenith-machine+jwt";
  }

  async post(handler: unknown, suffix: string, body: unknown, o: SignOptions = {}, params: Record<string, string> = {}) {
    const text = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
    return call(handler, this.request("POST", this.path(suffix), text, o), { id: this.id, ...params });
  }

  async get(handler: unknown, suffix: string, o: SignOptions = {}, params: Record<string, string> = {}) {
    return call(handler, this.request("GET", this.path(suffix), undefined, o), { id: this.id, ...params });
  }
}

export interface RegisterOptions {
  workspaceId?: string;
  kind?: AgentKind;
  name?: string;
  capabilities?: string[];
  binding?: { environmentId?: string; address?: string };
  /** extra registration labels (for example zenith.credentialMode) */
  labels?: Record<string, string>;
}

/** Register a fake agent through the real `register` route (token → agent), like `zenith-runner register`. */
export async function registerFakeAgent(plane: Plane, registerRoute: unknown, o: RegisterOptions = {}): Promise<FakeAgent> {
  const kind = o.kind ?? "runner";
  const workspaceId = o.workspaceId ?? "w-a";
  const created = await createRegistrationToken(plane.rt, { workspaceId, kind, createdBy: "user-admin", binding: o.binding });
  const key = newAgentKey();
  const req = new NextRequest(new URL(`${API}/${kind === "runner" ? "runners" : "machines"}/register`, ORIGIN), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: created.token,
      publicKey: key.publicKey,
      name: o.name ?? `test-${kind}`,
      version: "1.0.0",
      capabilities: o.capabilities ?? (kind === "runner" ? ["tofu.run", "aws.http", "probe.http", "probe.tcp", "probe.dns", "k8s.http"] : ["machine.inspect", "service.status", "process.list"]),
      labels: { region: "ap-south-1", ...(o.labels ?? {}) },
      host: { os: "linux", arch: "amd64" },
    }),
  });
  const res = await call(registerRoute, req);
  if (res.status !== 201) throw new Error(`registration failed: ${res.status} ${JSON.stringify(res.body)}`);
  return new FakeAgent(plane, kind, String(res.body.id), String(res.body.workspaceId), key, res.body.controlPlaneKeys as { kid: string; publicKey: string }[]);
}

/* ---------------------------------- grants ---------------------------------- */

/**
 * A capability grant the way the broker issues one (`signCapabilityGrant`: EdDSA JWS
 * `zenith-grant+jwt`, claims validated), signed by the plane's control-plane key.
 */
export async function issueGrant(plane: Plane, claims: Partial<CapabilityGrantClaims> & Pick<CapabilityGrantClaims, "aud" | "cap" | "op" | "ws">): Promise<string> {
  const iat = Math.floor(plane.rt.now() / 1000);
  const full: CapabilityGrantClaims = { jti: `grt_${randomBytes(6).toString("hex")}`, iss: "zenith-control-plane", sub: "user_test", iat, exp: iat + 600, digest: "sha256:test", ...claims };
  return signCapabilityGrant(full, { signer: plane.signer });
}

export const runnerGrant = (plane: Plane, a: { runnerId: string; workspaceId: string; operationId: string; capability: string; exp?: number }): Promise<string> =>
  issueGrant(plane, { aud: `runner:${a.runnerId}`, cap: a.capability, op: a.operationId, ws: a.workspaceId, ...(a.exp !== undefined ? { exp: a.exp } : {}) });

export const OPERATION = "op_1";

/** Queue a `probe.tcp` job for `agent` (a runner) and return its id; the plane's signer issues the grant. */
export async function enqueueProbeJob(
  plane: Plane,
  agent: FakeAgent,
  over: { operationId?: string; timeoutSec?: number; queueTtlSec?: number; port?: number; capability?: string } = {}
): Promise<string> {
  const { enqueueRunnerJob } = await import("@/lib/runners/dispatch");
  const operationId = over.operationId ?? OPERATION;
  const capability = over.capability ?? "infrastructure.observe";
  return enqueueRunnerJob(
    {
      workspaceId: agent.workspaceId,
      runnerId: agent.id,
      operationId,
      capability,
      kind: "probe.tcp",
      payload: { host: "10.0.0.1", port: over.port ?? 22, timeoutMs: 2000 },
      grant: await runnerGrant(plane, { runnerId: agent.id, workspaceId: agent.workspaceId, operationId, capability }),
      timeoutSec: over.timeoutSec,
      queueTtlSec: over.queueTtlSec,
    },
    plane.rt
  );
}

/* ------------------------------ a serving fake runner ------------------------------ */

export interface AgentResultBody {
  status: "succeeded" | "failed" | "rejected" | "timed_out";
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number;
  result?: unknown;
  error?: string;
}

/**
 * A fake agent that polls for jobs and answers them with `handler`, concurrently with the code under
 * test (use a "real" plane). It verifies each job with the pinned key using node:crypto only, exactly
 * as the Go agent would, and reports the result through the real result route.
 */
export class FakeRunnerService {
  readonly seen: DecodedJob[] = [];
  /** exceptions thrown by the handler (a failed assertion inside it): reported as a failed job and rethrown by `stop()` */
  readonly errors: unknown[] = [];
  private stopped = false;
  private loop: Promise<void> | undefined;

  constructor(
    private readonly agent: FakeAgent,
    private readonly routes: { poll: unknown; result: unknown },
    private readonly handler: (job: DecodedJob) => AgentResultBody | Promise<AgentResultBody>
  ) {}

  start(): this {
    this.loop = (async () => {
      while (!this.stopped) {
        const res = await this.agent.post(this.routes.poll, "/poll", { max: 5, waitSec: 0 });
        const tokens = (res.body.jobs as string[] | undefined) ?? [];
        for (const token of tokens) {
          const job = this.agent.decodeJob(token, this.agent.jobTyp());
          this.seen.push(job);
          let body: AgentResultBody;
          try {
            body = await this.handler(job);
          } catch (e) {
            this.errors.push(e);
            body = { status: "failed", error: `fake runner handler threw: ${e instanceof Error ? e.message : String(e)}` };
          }
          await this.agent.post(this.routes.result, `/jobs/${job.claims.jti}/result`, { startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), ...body }, {}, { jti: job.claims.jti });
        }
        if (tokens.length === 0) await new Promise((r) => setTimeout(r, 4));
      }
    })();
    return this;
  }

  /** Stop serving. Rethrows the first error the handler threw, so a failed assertion inside it fails the test instead of timing out. */
  async stop(): Promise<void> {
    this.stopped = true;
    await this.loop;
    if (this.errors.length > 0) throw this.errors[0];
  }
}
