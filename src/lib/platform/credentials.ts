/**
 * Provider credential composition. All exchanges and vault reads stay inside
 * broker callbacks; audit failure refuses a session. Onboarding permits pending
 * connections only for an observe read, never for general withSession use.
 * OCI verification checks runner registration only, not live cloud access.
 * Evidence is contract only: no cloud connection was exercised live here.
 */
import { capability, isCapability } from "@/lib/capabilities/catalog";
import { randomUUID } from "node:crypto";
import { canonical, digest } from "@/lib/controlplane/digest";
import { repos, isOpenedPlatformDbHandle, assertPlatformSchemaCurrent } from "@/lib/controlplane/db";
import type { Sql, CapabilityGrantClaims } from "@/lib/controlplane/types";
import { AwsCredentialBroker, type AwsBrokerOptions } from "@/lib/credentials/aws";
import { mintWorkloadToken, type WorkloadTokenDeps } from "@/lib/credentials/oidc/issuer";
import { CredentialDeniedError, type CredentialBroker, type CredentialRequest, type DenialReason, type ProviderConnection, type ProviderSession } from "@/lib/credentials/types";
import { createGcpSession } from "@/lib/providers/gcp";
import { createAzureSession } from "@/lib/providers/azure";
import { azureCloud } from "@/lib/providers/azure/cloud";
import { AzureSourceStorageRefusedError } from "@/lib/providers/azure/release/source-storage";
import { createAzureSourceStorageResolver } from "@/lib/providers/azure/release/source-binding";
import { createKubernetesSession } from "@/lib/providers/kubernetes";
import { assertVaultKubeconfigTarget } from "@/lib/providers/kubernetes/vault-target";
import { createK8sClient } from "@/lib/providers/kubernetes/client";
import { isDnsLabel } from "@/lib/providers/kubernetes/naming";
import { K8sError } from "@/lib/providers/kubernetes/types";
import { DeployerCredentialError, verifyDeployerCredential, deployerScopeOf } from "@/lib/providers/kubernetes/deployer";
import { GuestCredentialError, assertGuestNamespace, buildGuestKubeConfig, createGuestClusterPort, mintGuestCredential, revokeGuestBindings, verifyGuestMinter, type GuestRevocationOutcome } from "@/lib/providers/kubernetes/guest";
import { createGuestStore } from "@/lib/providers/kubernetes/guest-store";
import type { KubernetesSessionDeps } from "@/lib/providers/kubernetes/session";
import { GcpAuthError, GcpSessionError } from "@/lib/providers/gcp/errors";
import { AzureTokenError, AzureRequestRefusedError } from "@/lib/providers/azure/credentials";
import { ApiException } from "@kubernetes/client-node";
import { RUNNER_PROTOCOL } from "@/lib/runners/types";
import { createRunnerAwsTransportFactory } from "@/lib/runners/aws-runner-transport";
import { isVaultRef, readSecretValueAsync } from "@/lib/secrets";
import { signCapabilityGrant } from "@/lib/credentials/grants";
import { createRunnerOciTransport, type OciHttpJobResult } from "@/lib/providers/oci/runner-transport";
import { isOcid, isRegionId } from "@/lib/providers/oci/services";
import { awaitRunnerJob, enqueueRunnerJob } from "@/lib/runners/dispatch";
import { createEffectLedger } from "@/lib/effects/ledger";
import { runProxyJob } from "@/lib/effects/proxy";
import { getRunnerRuntime } from "@/lib/runners/runtime";
import type { OciSession, KubernetesConnectionConfig } from "@/lib/credentials/types";
import { awsBootstrapPreflightSessionPolicy, preflightAwsBootstrap, type AwsBootstrapPreflight } from "@/lib/credentials/aws/bootstrap-preflight";
import { StepFailedError } from "@/lib/execution/errors";

export interface AwsBootstrapReadiness {
  readonly status: AwsBootstrapPreflight["status"] | "incomplete";
  readonly readbackStatus: AwsBootstrapPreflight["status"];
  readonly code: AwsBootstrapPreflight["code"];
  readonly roleCoverage: "incomplete";
  readonly declaredRoleRows: number;
  readonly inspectedRoleRows: number;
  readonly unresolvedRoleRows: number;
  readonly legacyPolicy: AwsBootstrapPreflight["legacyPolicy"];
  readonly families: readonly { family: string; status: AwsBootstrapPreflight["status"]; code: AwsBootstrapPreflight["code"] }[];
}
interface AwsReadinessRequest { readonly connectionId: string; readonly grant: CapabilityGrantClaims }
const awsReadinessOwners = new WeakMap<CredentialBroker, {
  withSession: CredentialBroker["withSession"];
  read: (request: AwsReadinessRequest) => Promise<AwsBootstrapReadiness>;
}>();
function readinessRefused(): never { throw new StepFailedError("Native AWS bootstrap readiness is unavailable or changed; no bootstrap readback was admitted."); }

/** Internal worker read service. No caller configuration, inventory, client or registration input. */
export async function readNativeAwsBootstrapReadiness(broker: CredentialBroker, request: AwsReadinessRequest): Promise<AwsBootstrapReadiness> {
  const owner = awsReadinessOwners.get(broker);
  if (!owner || broker.withSession !== owner.withSession) readinessRefused();
  return owner.read(request);
}

async function nativeAwsReadiness(db: Sql, broker: CredentialBroker, original: CredentialBroker["withSession"], request: AwsReadinessRequest): Promise<AwsBootstrapReadiness> {
  const deadline = Date.now() + 30_000;
  const currentOwner = () => {
    if (!isOpenedPlatformDbHandle(db,"postgres") || broker.withSession !== original || Date.now() >= deadline) readinessRefused();
  };
  currentOwner();
  const input = Object.freeze({ connectionId: request.connectionId, grant: Object.freeze({ ...request.grant }) });
  const g = input.grant;
  if (g.cap !== "infrastructure.observe" || g.aud !== "worker" || !g.proj || !g.env
    || ![g.ws,g.op,g.proj,g.env,input.connectionId].every(value => typeof value === "string" && value.length > 0 && value.length <= 200)
    || typeof g.jti !== "string" || !g.jti || typeof g.digest !== "string" || !/^[a-f0-9]{64}$/.test(g.digest)
    || !Number.isSafeInteger(g.exp) || !Number.isSafeInteger(g.fence) || g.fence! < 1) readinessRefused();
  const workspaceId = g.ws, operationId = g.op, projectId = g.proj, environmentId = g.env;
  await assertPlatformSchemaCurrent(db);
  const capture = () => db.tx(async tx => {
    currentOwner();
    const live = await tx.query<{ id: string; lease_holder: string }>(`select o.id,o.lease_holder from platform.operations o where o.workspace_id=$1 and o.id=$2
      and o.project_id=$3 and o.environment_id=$4 and o.proposal_digest=$5 and o.status='running'
      and o.lease_holder='workflow:' || o.id and o.lease_until>clock_timestamp() and o.expires_at>clock_timestamp()
      and o.lease_scope='env:' || o.environment_id and o.fence_token=$6
      and exists(select 1 from platform.leases l where l.workspace_id=$1 and l.scope=o.lease_scope and l.fence_token=$6
        and right(l.holder,length(o.id)+1)=':' || o.id and left(l.holder,length(l.holder)-length(o.id)-1) ~ '^worker:[A-Za-z0-9._-]{1,64}$'
        and l.expires_at>clock_timestamp() and l.released_at is null)
      and exists(select 1 from platform.capability_grants cg where cg.workspace_id=$1 and cg.operation_id=$2 and cg.jti=$7
        and cg.capability='infrastructure.observe' and cg.audience='worker' and cg.revoked_at is null and cg.consumed_at is null
        and cg.expires_at>clock_timestamp() and cg.expires_at=to_timestamp($8))`,
      [workspaceId,operationId,projectId,environmentId,g.digest,g.fence,g.jti,g.exp]);
    if (live.length !== 1) readinessRefused();
    const leaseHolder = live[0].lease_holder;
    const op = await repos.operations.get(tx,workspaceId,operationId);
    const connection = await repos.connections.get(tx,workspaceId,input.connectionId);
    if (!op || op.status !== "running" || op.proposalDigest !== g.digest || op.projectId !== projectId || op.environmentId !== environmentId
      || leaseHolder !== `workflow:${op.id}` || op.leaseScope !== `env:${environmentId}` || op.fenceToken !== g.fence
      || !connection || connection.status !== "verified" || connection.revokedAt || connection.config.provider !== "aws") readinessRefused();
    const binding = await tx.query<{ workspace_id:string; project_id:string; environment_id:string; connection_id:string; provider:string; region:string }>(
      `select workspace_id,project_id,environment_id,connection_id,provider,region from platform.reconcile_state
        where workspace_id=$1 and project_id=$2 and environment_id=$3 and connection_id=$4 and provider='aws' and region=$5`,
      [workspaceId,projectId,environmentId,connection.id,connection.config.region]);
    if (binding.length !== 1) readinessRefused();
    const rows = await repos.resources.listByEnvironment(tx,workspaceId,environmentId,{includeDeleted:true});
    if (rows.length > 1_000) readinessRefused();
    const observations = await repos.observations.latestObservationsByEnvironment(tx,workspaceId,environmentId);
    // All native rows/observations are captured, including unknown, deleted,
    // external and compiler parents. A filtered list cannot prove absence.
    const frame = canonical({ operation: { id:op.id, workspaceId:op.workspaceId, projectId:op.projectId, environmentId:op.environmentId,
      proposal:op.proposal, inputDigest:op.inputDigest, proposalDigest:op.proposalDigest, planDigest:op.planDigest, workflowId:op.workflowId, leaseHolder,
      leaseScope:op.leaseScope, fenceToken:op.fenceToken, approvalRound:(op as { approvalRound?: number }).approvalRound },
      connection, binding, rows, observations });
    currentOwner();
    return { op, connection, rows, observations, frame };
  });
  const before = await capture();
  if (before.connection.config.provider !== "aws") readinessRefused();
  const config = before.connection.config;
  const roleRows = before.rows.filter(row => row.nativeType === "aws:iam_role" || row.kind === "identity");
  if (roleRows.length > 32) readinessRefused();
  const roleArns: string[] = [];
  let unresolved = 0;
  for (const row of roleRows) {
    const observed = before.observations.find(value => value.resourceId === row.id);
    const age = observed ? Date.now() - Date.parse(observed.observedAt) : Number.NaN;
    if (row.workspaceId !== workspaceId || row.projectId !== projectId || row.environmentId !== environmentId || row.provider !== "aws"
      || row.region !== config.region || row.nativeType !== "aws:iam_role" || row.ownership !== "managed"
      || !["planned","provisioning","active","updating"].includes(row.status)
      || !observed || observed.address !== row.address || observed.simulated || observed.error
      || observed.presence !== "present" || observed.source !== "aws.iam_role@1" || !Number.isFinite(age) || age < 0 || age > 15 * 60_000
      || !observed.externalId || (row.externalId !== undefined && row.externalId !== observed.externalId)) {
      unresolved++; continue;
    }
    roleArns.push(observed.externalId);
  }
  const inventory = Object.freeze({ workspaceId, environmentId, roleArns:Object.freeze(roleArns) });
  let sessionPolicy: Readonly<Record<string, unknown>>;
  try { sessionPolicy = awsBootstrapPreflightSessionPolicy(config,inventory); }
  catch { readinessRefused(); }
  currentOwner();
  const readback = await original({ connectionId:before.connection.id, grant:g, purpose:"observe", sessionPolicy },async session => {
    if ((await capture()).frame !== before.frame || session.provider !== "aws") readinessRefused();
    return preflightAwsBootstrap(session,config,inventory);
  });
  if ((await capture()).frame !== before.frame) readinessRefused();
  // The store does not enumerate all compiler-created ECS/Lambda/VPC, build,
  // machine, scheduler and EKS child roles. Never promote this bounded read to
  // complete environment inventory, even with zero explicit role rows.
  const readiness: AwsBootstrapReadiness = Object.freeze({
    status:readback.status === "readback_compatible" ? "incomplete" : readback.status,
    readbackStatus:readback.status, code:readback.code, roleCoverage:"incomplete", declaredRoleRows:roleRows.length,
    inspectedRoleRows:roleArns.length, unresolvedRoleRows:unresolved, legacyPolicy:readback.legacyPolicy,
    families:Object.freeze(readback.families.map(({family,status,code}) => Object.freeze({family,status,code}))),
  });
  await repos.evidence.insert(db,{ workspaceId, operationId, kind:"observation", digest:digest(readiness),
    summary:{ stage:"aws_bootstrap_readiness", ...readiness, authorization:"unverified", migration:"not_performed" }, simulated:false });
  return readiness;
}

/**
 * The workspace-vault Kubernetes session for a connection's stored credential (for a
 * `scoped_guest` connection: the MINTER). Same target-bound, exec-plugin-refusing path
 * as every other Kubernetes session; there is no other source for it.
 */
async function kubernetesVaultSession(connection: ProviderConnection, config: KubernetesConnectionConfig, now: () => Date, ttlSec: number, deps?: Pick<KubernetesSessionDeps, "eksToken" | "oidcToken">, part: "minter" | "deployer" = "minter") {
  if (part === "deployer") {
    // PROD-K8S-CONN: the deployer is a distinct credential of a scoped_guest connection. It is only ever read here, for the
    // deploy/observe path; the minter reference is never substituted for it (and vice versa), whatever is missing.
    if (config.mode !== "scoped_guest" || !config.deployerCredentialRef || config.deployerCredentialRef === config.credentialRef) throw new DeployerCredentialError("not_configured");
    config = { ...config, mode: "kubeconfig_ref", credentialRef: config.deployerCredentialRef, deployerCredentialRef: undefined };
  }
  return createKubernetesSession(config, { ...deps, now, ttlSec, resolveCredential: async (ref) => {
    if (!isVaultRef(ref)) throw new K8sError("session_invalid", "Only Zenith vault references are supported.");
    const value = await readSecretValueAsync(connection.workspaceId, ref);
    if (!value) throw new K8sError("session_invalid", "Vault credential is unavailable in this workspace.");
    assertVaultKubeconfigTarget(config, value);
    return value;
  } });
}

/** The deployer and the minter must resolve to different credentials (PROD-K8S-CONN). Compares the resolved vault values in memory. */
async function assertSeparateCredentials(connection: ProviderConnection, config: KubernetesConnectionConfig): Promise<void> {
  if (!config.credentialRef || !config.deployerCredentialRef || config.credentialRef === config.deployerCredentialRef) throw new DeployerCredentialError("same_as_minter");
  const [minter, deployer] = await Promise.all([config.credentialRef, config.deployerCredentialRef].map((ref) => isVaultRef(ref) ? readSecretValueAsync(connection.workspaceId, ref) : Promise.resolve(undefined)));
  if (typeof minter === "string" && typeof deployer === "string" && minter.trim() === deployer.trim()) throw new DeployerCredentialError("same_as_minter");
}

/**
 * Connection revocation (LIFE-01) for `scoped_guest`: after the SQL revoke committed (bindings are
 * already `revoking`, so nothing can mint), delete the cluster objects with the minter. A binding whose
 * deletion cannot be completed stays `revoking` and is reported as pending; it is retried by the next
 * call. Other connections are a no-op.
 */
export async function revokeKubernetesGuestBindings(db: Sql, connection: ProviderConnection, options: { now?: () => Date } = {}): Promise<GuestRevocationOutcome & { attempted: boolean }> {
  const config = connection.config;
  if (config.provider !== "kubernetes" || config.mode !== "scoped_guest") return { revoked: 0, pending: 0, attempted: false };
  const store = createGuestStore(db, connection.workspaceId);
  const open = await store.listOpen(connection.id);
  if (!open.length) return { revoked: 0, pending: 0, attempted: true };
  try {
    const session = await kubernetesVaultSession(connection, config, options.now ?? (() => new Date()), 300);
    const outcome = await revokeGuestBindings({ cluster: createGuestClusterPort(session, AbortSignal.timeout(60_000)), store }, { workspaceId: connection.workspaceId, connectionId: connection.id });
    return { ...outcome, attempted: true };
  } catch {
    // Minter unavailable (vault value removed, cluster unreachable): bindings stay revoking and unmintable.
    return { revoked: 0, pending: open.length, attempted: true };
  }
}

export interface PlatformCredentialOptions {
  aws?: Pick<AwsBrokerOptions, "stsClient" | "oidc">;
  oidc?: WorkloadTokenDeps;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** Trusted worker token minters; vault resolution remains workspace-scoped. */
  kubernetes?: Pick<KubernetesSessionDeps, "eksToken" | "oidcToken">;
  /**
   * Rotation verification only (PROD-LIFE-01): present the staged candidate config
   * under the live connection's id, so the same workload subject, vault scope and
   * provider checks run against the candidate while the stored connection keeps
   * serving. A broker built with this option is used for `verifyConnection` only
   * and is never handed to a deploy path.
   */
  verifyCandidate?: { workspaceId: string; connectionId: string; config: ProviderConnection["config"] };
}

type ConnectionVerification = Awaited<ReturnType<CredentialBroker["verifyConnection"]>>;

/** Static local descriptions only: cloud error bodies and exception text are secret-bearing data. */
function verificationFailure(error: unknown): string {
  const http = (status: number | undefined) => Number.isInteger(status) && status! >= 100 && status! <= 599 ? ` (HTTP ${status})` : "";
  if (error instanceof GcpAuthError) {
    const reasons: Record<GcpAuthError["code"], string> = {
      invalid_connection: "GCP federation configuration is invalid",
      unsupported_mode: "GCP runner verification is unavailable",
      subject_token_unavailable: "Zenith OIDC token could not be minted",
      sts_exchange_failed: "GCP STS rejected the OIDC token; check issuer, audience and subject trust",
      sts_unavailable: "GCP STS is unavailable or timed out",
      impersonation_failed: "GCP observe service-account impersonation was denied; check workloadIdentityUser binding",
      impersonation_unavailable: "GCP IAM Credentials is unavailable or timed out",
      malformed_response: "GCP token exchange returned an unusable response",
    };
    return `${reasons[error.code]}${http(error.status)}.`;
  }
  if (error instanceof GcpSessionError) return "GCP observe session is expired, closed or refused the identity read.";
  if (error instanceof AzureTokenError) return `Azure Entra token exchange failed${http(error.status)}; check tenant, client and federated issuer/audience/subject trust.`;
  if (error instanceof AzureRequestRefusedError) return "Azure observe session refused the identity read (expired session or endpoint policy).";
  if (error instanceof K8sError) {
    const reasons: Partial<Record<K8sError["code"], string>> = {
      session_invalid: "Kubernetes credential or token minter is missing or invalid",
      session_expired: "Kubernetes credential has expired",
      unauthorized: "Kubernetes API rejected the credential",
      forbidden: "Kubernetes identity lacks get access to the default ServiceAccount in an allowlisted namespace",
      not_found: "Kubernetes allowlisted namespace or default ServiceAccount was not found",
      timeout: "Kubernetes API timed out", unreachable: "Kubernetes API could not be reached",
    };
    return `${reasons[error.code] ?? "Kubernetes connection configuration or API read failed"}.`;
  }
  if (error instanceof ApiException) {
    if (error.code === 401) return "Kubernetes API rejected the credential (HTTP 401).";
    if (error.code === 403) return "Kubernetes identity lacks get access to the default ServiceAccount in an allowlisted namespace (HTTP 403).";
    if (error.code === 404) return "Kubernetes allowlisted namespace or default ServiceAccount was not found (HTTP 404).";
    return `Kubernetes namespace identity read failed${http(error.code)}.`;
  }
  if (error instanceof CredentialDeniedError) return "Provider federation configuration or Zenith OIDC issuer is unavailable.";
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return "Provider identity verification timed out or was aborted.";
  return "Provider identity verification could not reach the provider or received an unusable response.";
}

export function platformCredentialBroker(db: Sql, options: PlatformCredentialOptions = {}): CredentialBroker {
  const now = options.now ?? (() => new Date());
  // The fixed resolver contract takes only an id. Use the scoped repository
  // after a trusted system lookup; no connection is exposed before ws checks.
  const candidate = options.verifyCandidate;
  const adopt = (c: ProviderConnection | null): ProviderConnection | null =>
    c && candidate && c.id === candidate.connectionId && c.workspaceId === candidate.workspaceId ? { ...c, config: candidate.config } : c;
  const resolveConnection = async (id: string): Promise<ProviderConnection | null> => {
    const rows = await db.query<{ workspace_id: string }>("select workspace_id from platform.provider_connections where id = $1", [id]);
    return rows[0] ? adopt(await repos.connections.get(db, rows[0].workspace_id, id)) : null;
  };
  const emit: NonNullable<AwsBrokerOptions["emit"]> = async (event) => {
    // authorizeRead deliberately has no operation row; verification likewise
    // uses a synthetic id. Keep correlation while respecting the event FK.
    const operation = event.operationId ? await repos.operations.get(db, event.workspaceId, event.operationId) : null;
    await repos.events.append(db, { ...event, operationId: operation?.id });
  };
  const effects = createEffectLedger(db);
  const aws = new AwsCredentialBroker({ ...options.aws, now, resolveConnection, emit, runnerTransport: createRunnerAwsTransportFactory({ effects }) });

  // One capability per session. Only unsigned REST payloads leave this callback;
  // the runner authenticates locally. C4 is supplied by the read-jobs workstream.
  const withOciSession = async <T>(connection: ProviderConnection, req: CredentialRequest, ttlSec: number, assumed: () => Promise<void>, fn: (session: ProviderSession) => Promise<T>): Promise<T> => {
    const config = connection.config;
    if (config.provider !== "oci" || config.mode !== "runner" || !isRegionId(config.region) || !isOcid(config.tenancyOcid) || !isOcid(config.compartmentOcid)) throw new CredentialDeniedError("OCI runner configuration is invalid.", { reason: "runner_unavailable" });
    const runner = await repos.runners.getRunner(db, connection.workspaceId, config.runnerId);
    if (!runner || runner.status === "revoked" || runner.stale || runner.protocol !== RUNNER_PROTOCOL || !runner.capabilities.includes("oci.http")) throw new CredentialDeniedError("An active OCI runner is unavailable in this workspace.", { reason: "runner_unavailable" });
    const grant = Object.freeze({ ...req.grant });
    const rt = await getRunnerRuntime();
    const expires = Math.min(now().getTime() + ttlSec * 1000, grant.exp * 1000);
    const iat = Math.floor(now().getTime() / 1000);
    const runnerGrant = await signCapabilityGrant({ ...grant, aud: `runner:${config.runnerId}`, jti: `grt_${randomUUID()}`, iat, exp: Math.floor(expires / 1000) }, { signer: rt.signer });
    const resources: OciSession["scope"]["resources"][number][] = [];
    if (grant.env) {
      const rows = await repos.resources.listByEnvironment(db, grant.ws, grant.env);
      const observations = await repos.observations.latestObservationsByEnvironment(db, grant.ws, grant.env);
      const observed = new Map(observations.map((o) => [o.resourceId, o]));
      for (const row of rows) {
        const observation = observed.get(row.id);
        const externalId = observation ? observation.presence === "present" && !observation.simulated ? observation.externalId : undefined : row.externalId;
        if (row.provider === "oci" && row.ownership !== "external" && row.status !== "deleted" && (!grant.proj || row.projectId === grant.proj) && (!row.region || row.region === config.region) && (!grant.res || row.id === grant.res) && isOcid(externalId)) resources.push(Object.freeze({ address: row.address, nativeType: row.nativeType, externalId }));
      }
    }
    const lifecycle = new AbortController();
    const active = () => !lifecycle.signal.aborted && now().getTime() < expires;
    const transport = createRunnerOciTransport(async (payload, opts) => {
      if (!active()) throw new CredentialDeniedError("The OCI session has ended.", { reason: "session_ended" });
      if (payload.region !== config.region || payload.query.some(([name, value]) => name.toLowerCase() === "compartmentid" && value !== config.compartmentOcid)) throw new CredentialDeniedError("The OCI request is outside the session's region or compartment.", { reason: "grant_invalid" });
      const signal = AbortSignal.any([lifecycle.signal, AbortSignal.timeout(Math.max(1, expires - now().getTime())), ...(opts.signal ? [opts.signal] : [])]);
      signal.throwIfAborted();
      try {
        // Signing is asynchronous: check the connection again before each job.
        const current = await repos.connections.get(db, grant.ws, connection.id);
        if (!current || current.status !== "verified" || canonical(current.config) !== canonical(config)) throw new CredentialDeniedError("The OCI connection changed or was revoked.", { reason: "session_ended" });
        signal.throwIfAborted();
        const timeoutSec = Math.max(1, Math.min(60, Math.floor((expires - now().getTime()) / 1000)));
        const common = { workspaceId: grant.ws, runnerId: config.runnerId, bindingConnectionId: connection.id, capability: grant.cap, kind: "oci.http" as const, payload, grant: runnerGrant, timeoutSec, maxOutputBytes: 1024 * 1024 };
        const settle = (id: string) => awaitRunnerJob<OciHttpJobResult>(id, { workspaceId: grant.ws, signal, deadlineMs: Math.min(expires, now().getTime() + 90_000) }, rt);
        let done;
        // Mutating requests (everything outside the OCI observe allowlist) are recorded before they are queued; the
        // POST's opc-retry-token is the provider's idempotency key and is stored with the effect.
        if (capability(grant.cap).mutates) done = await runProxyJob<OciHttpJobResult>({ ledger: effects, kind: "oci.http", payload, scope: { workspaceId: grant.ws, operationId: grant.op, capability: grant.cap, mutates: true },
          enqueue: () => enqueueRunnerJob({ ...common, operationId: grant.op }, rt), settle });
        else {
          if (!grant.env) throw new CredentialDeniedError("OCI read jobs require an environment grant.", { reason: "grant_invalid" });
          const { enqueueReadJob } = await import("@/lib/runners/read-jobs");
          signal.throwIfAborted();
          const { bindingConnectionId, ...readCommon } = common;
          const jobId = await enqueueReadJob({ ...readCommon, connectionId: bindingConnectionId, environmentId: grant.env });
          done = await settle(jobId);
        }
        signal.throwIfAborted();
        if (done.status !== "succeeded" || done.uncertain || !done.result || typeof done.result !== "object" || !Number.isInteger(done.result.status) || done.result.status < 100 || done.result.status > 599 || done.result.truncated || (done.result.bodyB64 !== undefined && (typeof done.result.bodyB64 !== "string" || done.result.bodyB64.length > Math.ceil(1024 * 1024 / 3) * 4 || Buffer.from(done.result.bodyB64, "base64").toString("base64") !== done.result.bodyB64)) || !done.result.headers || typeof done.result.headers !== "object" || Array.isArray(done.result.headers)) throw new CredentialDeniedError("The OCI runner did not return a complete successful job result.", { reason: "runner_unavailable" });
        return done.result;
      } catch (error) {
        // Never echo runner/provider error text: it can include a request body.
        if (error instanceof CredentialDeniedError) throw error;
        throw new CredentialDeniedError(signal.aborted ? "The OCI runner request was cancelled or expired." : "The OCI runner request is unavailable.", { reason: signal.aborted ? "session_ended" : "runner_unavailable" });
      }
    }, { capability: grant.cap, maxRequestBytes: 1024 * 1024, maxResponseBytes: 1024 * 1024 });
    const session: OciSession = Object.freeze({ provider: "oci", region: config.region, tenancyOcid: config.tenancyOcid, compartmentOcid: config.compartmentOcid, expiresAt: new Date(expires).toISOString(), capability: grant.cap, scope: Object.freeze({ workspaceId: grant.ws, projectId: grant.proj, environmentId: grant.env, resources: Object.freeze(resources) }), transport: Object.freeze(transport) });
    try { await assumed(); return await fn(session); } finally { lifecycle.abort(); }
  };

  // One private callback lifecycle for regular operations and onboarding.
  // The public broker still refuses pending connections for general use.
  const withProviderSession = async <T>(connection: ProviderConnection, purpose: "observe" | "deploy", ttlSec: number, operationId: string, cap: string, assumed: () => void | Promise<void>, fn: (session: ProviderSession) => Promise<T>, sourceScope?: { environmentId: string; resourceId?: string }, kubernetesGuest?: NonNullable<CredentialRequest["kubernetesGuest"]> | "verify_minter" | "verify_deployer"): Promise<T> => {
    const mint = (audience: string) => mintWorkloadToken({ workspaceId: connection.workspaceId, connectionId: connection.id, operationId, capability: cap, audience, ttlSec: Math.min(120, ttlSec) }, { ...options.oidc, now: now() });
    const c = connection.config;
    // Capture before any asynchronous vault/token/audit work. No caller proof
    // can substitute the current scoped SQL connection at callback admission.
    const kubernetesConfigDigest = c.provider === "kubernetes" ? digest(c) : undefined;
    let session: ProviderSession;
    let close: () => void;
    switch (c.provider) {
      case "gcp": {
        const handle = await createGcpSession({ connection: c, purpose, mintSubjectToken: mint, fetchImpl: options.fetchImpl, now, lifetimeSec: ttlSec });
        session = handle; close = () => handle.close(); break;
      }
      case "azure": {
        // Missing/unready source storage disables Blob access without blocking the
        // infrastructure session needed to create that account in the first place.
        const sourceStorage = sourceScope && purpose === "deploy" && c.sourceStorage && Object.hasOwn(c.sourceStorage, sourceScope.environmentId)
          ? await createAzureSourceStorageResolver(db)({ workspaceId: connection.workspaceId, environmentId: sourceScope.environmentId, resourceId: sourceScope.resourceId, connectionId: connection.id, subscriptionId: c.subscriptionId, region: c.region }).catch((error: unknown) => {
            if (error instanceof AzureSourceStorageRefusedError) return null;
            throw error;
          }) : null;
        const handle = await createAzureSession({ connection: c, sourceStorage: sourceStorage ?? undefined, purpose, mintClientAssertion: mint, fetchImpl: options.fetchImpl, now, durationSec: ttlSec });
        session = handle; close = () => handle.revoke(); break;
      }
      case "kubernetes": {
        if (c.mode === "scoped_guest" && (!kubernetesGuest || kubernetesGuest === "verify_deployer")) {
          // PROD-K8S-CONN: deploy/observe (and deployer verification) use ONLY the connection's separate deployer credential.
          // No deployer part, an unverified connection (the broker already required status verified) or any failure here is a
          // refusal: never the minter, a guest token, a kubeconfig of another connection or a runner identity.
          if (!c.deployerCredentialRef) throw new CredentialDeniedError("This scoped Kubernetes connection has no deployer credential; it serves guest machine sessions only.", { reason: "deployer_credential_refused" });
          let deployer;
          try { deployer = await kubernetesVaultSession(connection, c, now, ttlSec, options.kubernetes, "deployer"); }
          catch { throw new CredentialDeniedError("The Kubernetes deployer credential is unavailable.", { reason: "deployer_credential_refused" }); }
          let deployerEnded = false;
          session = { provider: "kubernetes", server: deployer.server, expiresAt: deployer.expiresAt, namespaces: deployer.namespaces, kubeConfig: () => {
            if (deployerEnded) throw new CredentialDeniedError("The session has ended.", { reason: "session_ended" });
            return deployer.kubeConfig();
          } } as ProviderSession;
          close = () => { deployerEnded = true; }; break;
        }
        // A guest request is served only by a minted scoped token, never by another connection mode's credential.
        if (kubernetesGuest && kubernetesGuest !== "verify_minter" && kubernetesGuest !== "verify_deployer" && c.mode !== "scoped_guest") {
          throw new CredentialDeniedError("This Kubernetes connection is not scoped for guest sessions.", { reason: "guest_credential_refused" });
        }
        const handle = await kubernetesVaultSession(connection, c, now, ttlSec, options.kubernetes);
        if (c.mode === "scoped_guest" && kubernetesGuest && kubernetesGuest !== "verify_minter" && kubernetesGuest !== "verify_deployer") {
          // The minter stays inside this block. Guest callers receive only the scoped TokenRequest token.
          try {
            assertGuestNamespace(kubernetesGuest.namespace, c.namespaces);
            const minter = createGuestClusterPort(handle, AbortSignal.timeout(30_000));
            const guest = await mintGuestCredential({ cluster: minter, store: createGuestStore(db, connection.workspaceId), now },
              { workspaceId: connection.workspaceId, connectionId: connection.id, namespace: kubernetesGuest.namespace, profile: kubernetesGuest.profile, namespaces: c.namespaces, audiences: c.guestAudiences });
            const kc = buildGuestKubeConfig({ server: handle.server, caData: c.caData, token: guest.token });
            const guestExpiresAt = new Date(Math.min(Date.parse(guest.expiresAt), now().getTime() + ttlSec * 1000)).toISOString();
            let guestEnded = false;
            session = { provider: "kubernetes", server: handle.server, expiresAt: guestExpiresAt, namespaces: [kubernetesGuest.namespace], kubeConfig: () => {
              if (guestEnded || now().getTime() >= Date.parse(guestExpiresAt)) throw new CredentialDeniedError("The session has ended.", { reason: "session_ended" });
              return kc;
            } } as ProviderSession;
            close = () => { guestEnded = true; };
          } catch (error) {
            throw new CredentialDeniedError(error instanceof GuestCredentialError ? error.message : "The scoped Kubernetes guest credential could not be minted.", { reason: "guest_credential_refused" });
          }
          break;
        }
        let ended = false;
        session = { provider: "kubernetes", server: handle.server, expiresAt: handle.expiresAt, namespaces: handle.namespaces, kubeConfig: () => {
          if (ended) throw new CredentialDeniedError("The session has ended.", { reason: "session_ended" });
          return handle.kubeConfig();
        } } as ProviderSession;
        close = () => { ended = true; }; break;
      }
      default: throw new CredentialDeniedError("This provider does not expose direct sessions.");
    }
    try {
      await assumed();
      if (kubernetesConfigDigest !== undefined) {
        // This shared path also serves onboarding: its captured pending/failed
        // status must stay unchanged; regular withSession already requires verified.
        let current: ProviderConnection | null;
        try { current = adopt(await repos.connections.get(db, connection.workspaceId, connection.id)); }
        catch { throw new CredentialDeniedError("The current Kubernetes connection is unavailable.", { reason: "session_ended" }); }
        if (!current || current.id !== connection.id || current.workspaceId !== connection.workspaceId
          || current.status === "revoked" || current.status !== connection.status
          || digest(current.config) !== kubernetesConfigDigest) {
          throw new CredentialDeniedError("The Kubernetes connection changed or was revoked before session admission.", { reason: "session_ended" });
        }
        if (now().getTime() >= Date.parse(session.expiresAt)) {
          throw new CredentialDeniedError("The Kubernetes session expired before admission.", { reason: "session_ended" });
        }
      }
      return await fn(session);
    } finally { close(); }
  };

  const broker: CredentialBroker = {
    async withSession<T>(req: CredentialRequest, fn: (session: ProviderSession) => Promise<T>): Promise<T> {
      // Workspace is available here, so non-AWS lookups are tenant-scoped in SQL.
      const grant = req?.grant;
      if (!grant?.ws || !grant.op) throw new CredentialDeniedError("No usable capability grant.", { reason: "grant_invalid" });
      const connection = await repos.connections.get(db, grant.ws, req.connectionId);
      const base = { workspaceId: grant.ws, operationId: grant.op, projectId: grant.proj, environmentId: grant.env, resourceId: grant.res, correlationId: grant.op };
      const deny = async (reason: DenialReason, message: string): Promise<never> => {
        await Promise.resolve(emit({ ...base, type: "credential.denied", data: { connectionId: req.connectionId, reason } })).catch(() => undefined);
        throw new CredentialDeniedError(message, { reason });
      };
      // A grant revoked since issue (cancel, lease loss, field-ownership change) gets no provider session.
      // shortcut: a grant with no stored row (signed outside the broker) is not refused here; production grants are stored at issue.
      if (typeof grant.jti === "string" && grant.jti && await repos.grants.status(db, grant.ws, grant.jti) === "revoked")
        return deny("grant_revoked", "The capability grant was revoked.");
      // AWS sessions are minted by their own broker, after the shared revocation gate.
      if (connection?.config.provider === "aws") return aws.withSession(req, fn);
      if (!Number.isFinite(grant.exp) || grant.exp <= Math.floor(now().getTime() / 1000)) return deny("grant_expired", "The capability grant expired.");
      if (!isCapability(grant.cap)) return deny("unknown_capability", "Unknown capability.");
      if (!connection) return deny("connection_not_found", "Connection not found in this workspace.");
      if (connection.status === "revoked") return deny("connection_revoked", "Connection revoked.");
      if (connection.status !== "verified") return deny("connection_not_verified", "Connection has not been verified.");
      // Only AWS has a separate, scoped value-writer session today. Never use
      // another provider's observe/deploy identity for a secret-write request.
      if (req.purpose === "secret.write") return deny("provider_unsupported", "Secret-write sessions are currently supported only for AWS connections.");
      if (grant.cap === "secret.write") return deny("purpose_capability_mismatch", "secret.write requires its separate writer purpose and role.");
      if ((req.purpose === "deploy") !== capability(grant.cap).mutates) return deny("purpose_capability_mismatch", "Credential purpose does not match capability.");
      if (connection.config.provider !== "oci" && connection.config.mode === "runner") return deny("mode_unsupported", "This provider's runner transport is not configured.");
      const remaining = grant.exp - Math.floor(now().getTime() / 1000);
      const duration = req.durationSec ?? 900;
      if (!Number.isInteger(duration) || duration < 1) return deny("duration_invalid", "Session duration must be positive integer seconds.");
      const ttlSec = Math.min(900, duration, remaining);
      const minimum = connection.config.provider === "kubernetes" ? 30 : 60;
      if (ttlSec < minimum) return deny("grant_expired", "Grant has too little lifetime for this provider session.");
      let created = false;
      try {
        if (connection.config.provider === "oci") return await withOciSession(connection, req, ttlSec, async () => {
          created = true;
          try { await emit({ ...base, type: "credential.assumed", data: { connectionId: connection.id, provider: "oci", purpose: req.purpose } }); }
          catch { return deny("audit_failed", "Credential audit could not be recorded; session refused."); }
        }, fn);
        return await withProviderSession(connection, req.purpose, ttlSec, grant.op, grant.cap, async () => {
          created = true;
          try { await emit({ ...base, type: "credential.assumed", data: { connectionId: connection.id, provider: connection.config.provider, purpose: req.purpose } }); }
          catch { return deny("audit_failed", "Credential audit could not be recorded; session refused."); }
        }, fn, grant.env ? { environmentId: grant.env, resourceId: grant.res } : undefined, req.kubernetesGuest);
      } catch (error) {
        if (!created && connection.config.provider === "oci" && error instanceof CredentialDeniedError) return deny(error.reason ?? "runner_unavailable", error.message);
        if (!created && connection.config.provider === "kubernetes" && connection.config.mode === "scoped_guest") {
          const part = req.kubernetesGuest ? "guest_credential_refused" as const : "deployer_credential_refused" as const;
          return error instanceof CredentialDeniedError
            ? deny(error.reason ?? part, error.message)
            : deny(part, part === "guest_credential_refused" ? "The scoped Kubernetes guest credential could not be minted." : "The Kubernetes deployer credential could not be used.");
        }
        if (!created && error instanceof CredentialDeniedError && error.reason === "guest_credential_refused") return deny("guest_credential_refused", error.message);
        if (!created) return deny("not_supported", "Provider session could not be created; check federation or vault configuration.");
        throw error;
      }
    },
    async verifyConnection(id, opts) {
      let connection: ProviderConnection | null;
      try { connection = opts?.workspaceId !== undefined ? adopt(await repos.connections.get(db, opts.workspaceId, id)) : await resolveConnection(id); }
      catch { return { ok: false, detail: "The connection could not be loaded." }; }
      if (!connection) return { ok: false, detail: "Connection not found." };
      if (connection.config.provider === "aws") return aws.verifyConnection(id, opts);
      if (connection.status === "revoked") return { ok: false, detail: "Connection revoked." };
      const config = connection.config;
      let result: ConnectionVerification;
      try {
        if (config.provider === "oci") {
          const runner = await repos.runners.getRunner(db, connection.workspaceId, config.runnerId);
          if (!runner) return { ok: false, detail: "OCI runner is not registered in this workspace." };
          if (runner.status === "revoked") return { ok: false, detail: "OCI runner is revoked." };
          if (runner.stale) return { ok: false, detail: "OCI runner heartbeat is stale." };
          if (runner.protocol !== RUNNER_PROTOCOL) return { ok: false, detail: "OCI runner protocol is unsupported." };
          if (!runner.capabilities.includes("oci.http")) return { ok: false, detail: "OCI runner does not advertise the oci.http kind." };
          result = { ok: true, detail: "Registered OCI runner advertises oci.http for this connection. OCI cloud identity and permissions are unverified." };
        } else {
          if (config.mode === "runner") return { ok: false, detail: "This provider's runner verification transport is unavailable." };
          if (config.provider === "kubernetes" && (!config.namespaces.length || config.namespaces.some((ns) => !isDnsLabel(ns)))) return { ok: false, detail: "Kubernetes verification requires valid allowlisted namespaces for a namespaced get." };
          // PROD-K8S-CONN: a scoped_guest connection verifies EACH part with that part's own credential (minter, then deployer
          // when one is configured); the connection verifies only when every part does. Other connections have one part.
          const parts: Array<"verify_minter" | "verify_deployer" | undefined> = config.provider === "kubernetes" && config.mode === "scoped_guest"
            ? ["verify_minter", ...(config.deployerCredentialRef ? ["verify_deployer" as const] : [])] : [undefined];
          const details: string[] = [];
          result = { ok: false, detail: "Provider identity verification is unsupported." };
          for (const part of parts) {
          const operationId = `verify-${randomUUID()}`;
          result = await withProviderSession(connection, "observe", 900, operationId, "connection.verify", async () => {
            try { await emit({ workspaceId: connection.workspaceId, operationId, correlationId: operationId, type: "credential.assumed", data: { connectionId: id, provider: config.provider, purpose: "observe" } }); }
            catch { throw new VerificationAuditError(); }
          }, async (session): Promise<ConnectionVerification> => {
            const signal = AbortSignal.timeout(30_000);
            if (session.provider === "gcp" || session.provider === "azure") {
              const url = session.provider === "gcp" ? `https://cloudresourcemanager.googleapis.com/v3/projects/${session.projectId}` : `${azureCloud(session.cloud).armOrigin}/subscriptions/${session.subscriptionId}?api-version=2022-12-01`;
              const response = await session.authorizedFetch(url, { method: "GET", signal });
              if (!response.ok) {
                await response.body?.cancel().catch(() => undefined);
                const reason = response.status === 401 ? "credential was rejected" : response.status === 403 ? "observe identity lacks read permission" : response.status === 404 ? "configured project/subscription was not found" : "identity read failed";
                return { ok: false, detail: `${session.provider === "gcp" ? "GCP project" : "Azure subscription"} ${reason} (HTTP ${response.status}).` };
              }
              const body: unknown = await response.json();
              const field = session.provider === "gcp" ? "projectId" : "subscriptionId";
              const expected = session.provider === "gcp" ? session.projectId : session.subscriptionId;
              const actual = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>)[field] : undefined;
              if (typeof actual !== "string" || (session.provider === "azure" ? actual.toLowerCase() !== expected.toLowerCase() : actual !== expected)) return { ok: false, detail: "Provider identity read returned a missing or mismatched project/subscription identifier." };
              return { ok: true, detail: `${session.provider === "gcp" ? "GCP observe service account read the configured project" : "Azure federated identity read the configured subscription"}.`, accountId: expected };
            }
            if (session.provider === "kubernetes" && config.provider === "kubernetes" && config.mode === "scoped_guest" && part === "verify_deployer") {
              // Creates nothing: the DEPLOYER credential (never the minter) is separate, and namespaced-only when declared so.
              try {
                await assertSeparateCredentials(connection, config);
                await verifyDeployerCredential(createGuestClusterPort(session, signal), { scope: deployerScopeOf(config), namespaces: config.namespaces });
              } catch (error) { return { ok: false, detail: `Deployer credential: ${error instanceof DeployerCredentialError ? error.message : "verification failed."}` }; }
              return { ok: true, detail: `Kubernetes deployer (${deployerScopeOf(config)}) credential can read and deploy in every allowlisted namespace${deployerScopeOf(config) === "namespaced" ? " and holds no cluster-wide or system-namespace privilege" : ""}.` };
            }
            if (session.provider === "kubernetes" && config.provider === "kubernetes" && config.mode === "scoped_guest") {
              // Creates nothing: proves the minter is namespaced-only and can manage guest objects in each namespace.
              try { await verifyGuestMinter(createGuestClusterPort(session, signal), config.namespaces); }
              catch (error) { return { ok: false, detail: `Guest minter: ${error instanceof GuestCredentialError ? error.message : "Kubernetes minter verification failed."}` }; }
              return { ok: true, detail: "Kubernetes minter is namespaced-only and can manage guest ServiceAccounts and Roles in every allowlisted namespace. Guest tokens are minted per dispatch." };
            }
            if (session.provider === "kubernetes" && config.provider === "kubernetes") {
              const client = createK8sClient(session, { signal });
              for (const namespace of [...new Set(config.namespaces)].sort()) {
                const account = await client.core.readNamespacedServiceAccount({ name: "default", namespace });
                if (account.metadata?.name !== "default" || account.metadata.namespace !== namespace) return { ok: false, detail: "Kubernetes namespace read returned an unusable or mismatched ServiceAccount." };
              }
              return { ok: true, detail: "Kubernetes credential read the default ServiceAccount in every allowlisted namespace. Additional permissions are unverified." };
            }
            return { ok: false, detail: "Provider identity verification is unsupported." };
          }, undefined, part);
          details.push(result.detail);
          if (!result.ok) break;
          }
          if (parts.length > 1) result = { ...result, detail: details.join(" ") };
        }
        if (result.ok) {
          const current = adopt(await repos.connections.get(db, connection.workspaceId, id));
          if (!current || current.status === "revoked" || canonical(current.config) !== canonical(config)) return { ok: false, detail: "Connection was revoked, removed or changed during verification; verify the current configuration again." };
        }
        return result;
      } catch (error) {
        return { ok: false, detail: error instanceof VerificationAuditError ? "Credential verification audit could not be recorded; verification refused." : verificationFailure(error) };
      }
    },
  };
  if (isOpenedPlatformDbHandle(db,"postgres")) {
    const original = broker.withSession;
    awsReadinessOwners.set(broker,{withSession:original,read:request => nativeAwsReadiness(db,broker,original,request)});
  }
  return broker;
}

class VerificationAuditError extends Error {}
