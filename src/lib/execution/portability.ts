/**
 * The worker side of the four portability capabilities (PROD-LIFE-11), run by
 * `executeCapability` before the generic managed-resource check, because their
 * ownership rules differ per capability:
 *
 *   data.export       reads the source (managed or referenced), writes a
 *                     verified artifact into tenant-owned storage
 *   data.import       writes into a NEW, EMPTY, managed target, then verifies by
 *                     reading the target back through a fresh connection
 *   resource.adopt    referenced -> managed under a human claim, after a live
 *                     read proves the claimed object is the one that exists
 *   resource.release  managed -> referenced for an adopted object; never deletes
 *
 * Models propose; this code decides. Credentials are vault references resolved
 * here, inside the activity, and dropped when it ends. Failures that happen
 * before any effect are `StepFailedError`; an unexpected exception stays plain
 * so a mutating step finalizes `uncertain`.
 */
import { legacyIssueCode } from "@/lib/zod-issue-code";
import { digest } from "@/lib/controlplane/digest";
import { factsForNode } from "@/lib/ownership";
import type { CapabilityName } from "@/lib/capabilities/catalog";
import { assertClaimMatchesRegistry, assertClaimedObjectIsLive, buildBaseline, claimDigest } from "@/lib/portability/adoption";
import { openBinding, openObjectStore } from "@/lib/portability/connect";
import { allowPrivateHostsFromEnv } from "@/lib/portability/net";
import { s3ArtifactStore } from "@/lib/portability/engines/s3";
import { AdoptInputSchema, ExportInputSchema, ImportInputSchema, ReleaseInputSchema, isPortabilityCapability, type Destination, type PortabilityCapability } from "@/lib/portability/inputs";
import { portabilitySupport } from "@/lib/portability/matrix";
import { runExport, runImport, type ServiceBinding } from "@/lib/portability/service";
import { PortabilityError, isDataKind, type DataKind } from "@/lib/portability/types";
import { managedDatabaseConnectionRef } from "@/lib/providers/zenith/database";
import { SecretDeliveryError } from "@/lib/secrets/delivery";
import { createSecretResolver, type SecretResolverScope } from "@/lib/secrets/resolver";
import type { ResourceNode } from "@/lib/resources/types";
import type { LeaseRef } from "@/lib/workflows/types";
import type { ExecContext } from "./context";
import { StepFailedError } from "./errors";
import { withKeepAlive } from "./keepalive";
import type { PortabilityPort, StoredResource } from "./ports";
import type { Runtime } from "./runtime";
import { driverContext, withProviderSession } from "./session";
import { resolveConnection } from "./context";

export { isPortabilityCapability };

type Outcome = { ok: boolean; summary: string };

const refuse = (message: string): StepFailedError => new StepFailedError(message);

function asStep(err: unknown): unknown {
  return err instanceof PortabilityError ? refuse(err.message) : err;
}

interface SchemaLike<T> { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; code: string }[] } } }

function parseInput<T>(schema: SchemaLike<T>, raw: unknown, what: string): T {
  const parsed = schema.safeParse(raw ?? {});
  if (!parsed.success) throw refuse(`The ${what} input is invalid (${parsed.error.issues.slice(0, 6).map((i) => `${i.path.map(String).join(".") || "(root)"}: ${legacyIssueCode(i)}`).join(", ")}).`);
  return parsed.data;
}

function requirePort(rt: Runtime): PortabilityPort {
  if (!rt.d.portability) throw refuse("This worker has no portability store configured, so it cannot run this operation.");
  return rt.d.portability;
}

async function approvalFor(rt: Runtime, operationId: string): Promise<string> {
  const status = await rt.d.broker.approvalStatus(operationId);
  if (!status.approved || status.rejected || typeof status.approvalId !== "string" || status.approvalId.trim().length === 0) {
    throw refuse("This operation requires a current, digest-bound human approval, and none is on record.");
  }
  return status.approvalId;
}

/* --------------------------------- secrets -------------------------------- */

function secretScope(ec: ExecContext, rows: readonly StoredResource[]): SecretResolverScope {
  return { workspaceId: ec.workspaceId, environmentId: ec.environmentId, projectId: ec.product.project.id, resourceAddresses: rows.filter((r) => r.ownership === "managed").map((r) => r.address) };
}

async function readSecret(ec: ExecContext, rows: readonly StoredResource[], ref: string): Promise<string> {
  try {
    const value = await createSecretResolver(secretScope(ec, rows))(ref);
    if (!value) throw refuse("A required vault secret has no value; register it before running this operation.");
    return value;
  } catch (err) {
    if (err instanceof SecretDeliveryError) throw refuse(`A required vault secret could not be read (${err.reason}).`);
    throw err;
  }
}

/** The service's own connection secret: an explicit reference, or the generated one the Zenith-managed platform keeps. */
function connectionRef(row: StoredResource, explicit: string | undefined): string {
  return explicit ?? managedDatabaseConnectionRef(row.environmentId, row.address);
}

/* ------------------------------- destinations ------------------------------ */

const bucketNameOf = (row: StoredResource): string | undefined => {
  const raw = row.externalId ?? (typeof row.spec.bucketName === "string" ? row.spec.bucketName : typeof row.spec.name === "string" ? row.spec.name : undefined);
  if (!raw) return undefined;
  const last = raw.split(/[:/]/).filter(Boolean).pop();
  return last && last.length > 0 ? last : undefined;
};

/**
 * Tenant-owned storage: an object_store resource of THIS environment (managed or referenced in the
 * tenant's account, never `external`), reachable through the credentials the tenant registered, whose
 * bucket is the bucket that resource is. A bucket name in a secret cannot redirect an export elsewhere.
 */
async function resolveDestination(ec: ExecContext, rows: readonly StoredResource[], d: Destination, source: StoredResource | undefined) {
  const dest = rows.find((r) => r.address === d.resourceAddress);
  if (!dest || dest.kind !== "object_store" || dest.status === "deleted") throw refuse("The storage destination is not an object store resource of this environment.");
  if (dest.ownership === "external") throw refuse("The storage destination is documented only (external); exports go to storage the tenant owns.");
  if (source && dest.id === source.id) throw refuse("The storage destination cannot be the resource being exported.");
  const support = portabilitySupport("export", dest.provider, "object_store");
  if (!support.supported) throw refuse(`This storage cannot hold exports: ${support.reason}`);
  const opened = openObjectStore(await readSecret(ec, rows, d.credentialsRef), { allowPrivate: allowPrivateHostsFromEnv() });
  const bucket = bucketNameOf(dest);
  if (!bucket) throw refuse("The storage resource has no observed bucket identity yet; apply it before using it as a destination.");
  if (bucket !== opened.creds.bucket) throw refuse("The storage credentials do not belong to the destination resource's bucket.");
  return { resource: dest, ...opened };
}

const artifactPrefix = (ec: ExecContext): string => `zenith-portability/${ec.workspaceId}/${ec.environmentId}/${ec.op.id}/`;
const labelOf = (bucket: string, prefix: string): string => `s3://${bucket}/${prefix}`;

/* --------------------------------- export ---------------------------------- */

function sourceKind(row: StoredResource, operation: "export" | "import"): DataKind {
  if (!isDataKind(row.kind)) throw refuse(`${row.address} is a ${row.kind}, not a data service (postgres, mysql, object_store, volume).`);
  const support = portabilitySupport(operation, row.provider, row.kind);
  if (!support.supported) throw refuse(support.reason);
  return row.kind;
}

async function runDataExport(rt: Runtime, ec: ExecContext, row: StoredResource, lease: LeaseRef): Promise<Outcome> {
  const port = requirePort(rt);
  const input = parseInput(ExportInputSchema, ec.op.proposal.input, "data.export");
  const kind = sourceKind(row, "export");
  if (kind === "volume") throw refuse("Volumes cannot be exported."); // narrowed by the matrix; keeps the type honest
  if (row.ownership === "external" || row.status === "deleted") throw refuse(`${row.address} is not a service Zenith can read.`);
  const rows = await rt.d.resources.list(ec.workspaceId, ec.environmentId);
  const dest = await resolveDestination(ec, rows, input.destination, row);
  const allowPrivate = allowPrivateHostsFromEnv();
  const secret = await readSecret(ec, rows, connectionRef(row, input.connectionRef));
  if (kind === "object_store" && openObjectStore(secret, { allowPrivate }).creds.bucket === dest.creds.bucket) throw refuse("The destination bucket is the bucket being exported.");
  const prefix = artifactPrefix(ec);
  const store = s3ArtifactStore(dest.store, prefix, labelOf(dest.creds.bucket, prefix));

  let open: Awaited<ReturnType<typeof openBinding>> | undefined;
  try {
    open = await openBinding(kind, secret, { allowPrivate }).catch((e) => { throw asStep(e); });
    await rt.d.leases.assertFence(lease.scope, lease.fenceToken);
    await rt.emit(ec.scope, "resource.applying", `capability:${ec.op.id}`, { capability: "data.export", address: row.address });
    const outcome = await withKeepAlive(rt, { lease, detail: "export data service", operation: { workspaceId: ec.workspaceId, operationId: ec.op.id } }, () =>
      runExport({ workspaceId: ec.workspaceId, environmentId: ec.environmentId, operationId: ec.op.id, now: rt.now(), source: { provider: row.provider, nativeType: row.nativeType, address: row.address, ...(row.externalId ? { externalId: row.externalId } : {}) }, binding: open!.binding as ServiceBinding, store })
    ).catch((e) => { throw asStep(e); });
    await rt.d.leases.assertFence(lease.scope, lease.fenceToken);
    const record = await port.recordExport({
      workspaceId: ec.workspaceId, ...(ec.op.projectId ? { projectId: ec.op.projectId } : {}), environmentId: ec.environmentId, operationId: ec.op.id, resourceId: row.id, address: row.address,
      kind, provider: row.provider, engine: outcome.engine, ...(outcome.engineVersion ? { engineVersion: outcome.engineVersion } : {}), destinationLabel: store.label, artifactPrefix: prefix,
      manifestDigest: outcome.manifestDigest, contentDigest: outcome.contentDigest, fileCount: outcome.fileCount, byteSize: outcome.byteSize, coverage: outcome.coverage, verifiedAt: rt.iso(),
    });
    const summary = `Exported ${row.address} to tenant storage: ${outcome.fileCount} files, ${outcome.byteSize} bytes, artifact verified by reading it back (export ${record.id}).`;
    await rt.evidence(ec.scope, { kind: "observation", digest: digest({ op: ec.op.id, capability: "data.export", export: record.id, manifest: record.manifestDigest }), summary: { kind: "capability", capability: "data.export", address: row.address, ok: true, exportId: record.id, manifestDigest: record.manifestDigest, contentDigest: record.contentDigest, fileCount: record.fileCount, byteSize: record.byteSize, coverage: record.coverage }, simulated: false, key: `capability:${ec.op.id}` }, { critical: true });
    await rt.emit(ec.scope, "resource.applied", `capability:${ec.op.id}`, { capability: "data.export", address: row.address });
    return { ok: true, summary };
  } finally {
    await open?.close().catch(() => undefined);
  }
}

/* --------------------------------- import ---------------------------------- */

async function runDataImport(rt: Runtime, ec: ExecContext, row: StoredResource, lease: LeaseRef): Promise<Outcome> {
  const port = requirePort(rt);
  const input = parseInput(ImportInputSchema, ec.op.proposal.input, "data.import");
  const kind = sourceKind(row, "import");
  if (kind === "volume") throw refuse("Volumes cannot be imported.");
  if (row.ownership !== "managed" || row.status === "deleted") throw refuse(`${row.address} is ${row.ownership}: restores are written only into a new target Zenith manages.`);
  const recorded = await port.getExport(ec.workspaceId, input.exportId);
  if (!recorded) throw refuse("That export does not exist in this workspace.");
  if (recorded.kind !== kind) throw refuse(`An export of ${recorded.kind} cannot be restored into a ${kind} target.`);
  if (recorded.resourceId === row.id) throw refuse("A restore never overwrites the resource the export came from; restore into a new target.");
  const rows = await rt.d.resources.list(ec.workspaceId, ec.environmentId);
  const dest = await resolveDestination(ec, rows, input.destination, row);
  if (labelOf(dest.creds.bucket, recorded.artifactPrefix) !== recorded.destinationLabel) throw refuse("The storage credentials do not reach the location this export was written to.");
  const allowPrivate = allowPrivateHostsFromEnv();
  const targetSecret = await readSecret(ec, rows, connectionRef(row, input.connectionRef));
  const readbackSecret = input.readbackConnectionRef ? await readSecret(ec, rows, input.readbackConnectionRef) : targetSecret;
  if (kind === "object_store") {
    const t = openObjectStore(targetSecret, { allowPrivate }).creds.bucket;
    if (t === dest.creds.bucket) throw refuse("The restore target is the bucket holding the export.");
  }
  const store = s3ArtifactStore(dest.store, recorded.artifactPrefix, recorded.destinationLabel);

  let open: Awaited<ReturnType<typeof openBinding>> | undefined;
  try {
    open = await openBinding(kind, targetSecret, { allowPrivate }).catch((e) => { throw asStep(e); });
    await rt.d.leases.assertFence(lease.scope, lease.fenceToken);
    await rt.emit(ec.scope, "resource.applying", `capability:${ec.op.id}`, { capability: "data.import", address: row.address });
    const result = await withKeepAlive(rt, { lease, detail: "restore data service", operation: { workspaceId: ec.workspaceId, operationId: ec.op.id } }, () =>
      runImport({
        recorded: { manifestDigest: recorded.manifestDigest, contentDigest: recorded.contentDigest, kind: recorded.kind, engine: recorded.engine },
        store, target: { provider: row.provider, kind }, binding: open!.binding as ServiceBinding,
        // A second connection, optionally with a different (read-only) credential: the restore's own session never vouches for itself.
        openReadback: () => openBinding(kind, readbackSecret, { allowPrivate }),
      })
    ).catch((e) => { throw asStep(e); });
    await rt.d.leases.assertFence(lease.scope, lease.fenceToken);
    const restore = await port.recordRestore({
      workspaceId: ec.workspaceId, ...(ec.op.projectId ? { projectId: ec.op.projectId } : {}), environmentId: ec.environmentId, operationId: ec.op.id, exportId: recorded.id,
      targetResourceId: row.id, targetAddress: row.address, kind, provider: row.provider, expectedContentDigest: result.expectedContentDigest, observedContentDigest: result.observedContentDigest,
      readback: result.coverage, restored: result.restored, verifiedAt: rt.iso(),
    });
    await rt.evidence(ec.scope, { kind: "observation", digest: digest({ op: ec.op.id, capability: "data.import", restore: restore.id, status: restore.status }), summary: { kind: "capability", capability: "data.import", address: row.address, ok: restore.status === "verified", restoreId: restore.id, exportId: recorded.id, status: restore.status, expectedContentDigest: restore.expectedContentDigest, observedContentDigest: restore.observedContentDigest, coverage: result.coverage }, simulated: false, key: `capability:${ec.op.id}` }, { critical: true });
    if (restore.status !== "verified") {
      return { ok: false, summary: `Restore into ${row.address} did NOT verify: the target read back differently from the export (restore ${restore.id}). Discard the target; its data is not the exported data.` };
    }
    await rt.emit(ec.scope, "resource.applied", `capability:${ec.op.id}`, { capability: "data.import", address: row.address });
    return { ok: true, summary: `Restored export ${recorded.id} into ${row.address} and verified it by reading the target back through a fresh connection (restore ${restore.id}).` };
  } finally {
    await open?.close().catch(() => undefined);
  }
}

/* --------------------------------- adopt ----------------------------------- */

async function runAdopt(rt: Runtime, ec: ExecContext, row: StoredResource, node: ResourceNode, lease: LeaseRef): Promise<Outcome> {
  const port = requirePort(rt);
  const { claim } = parseInput(AdoptInputSchema, ec.op.proposal.input, "resource.adopt");
  if (!isDataKind(row.kind)) throw refuse(`${row.address} is a ${row.kind}; adoption supports data services (postgres, mysql, object_store, volume).`);
  if (row.ownership !== "referenced") throw refuse(`${row.address} is ${row.ownership}; only a referenced resource (one that already exists and is not yet managed) can be adopted.`);
  if (row.status === "deleted") throw refuse(`${row.address} was deleted.`);
  const support = portabilitySupport("adopt", row.provider, row.kind);
  if (!support.supported) throw refuse(support.reason);
  const driver = rt.drivers(node.provider, node.nativeType);
  if (!driver?.observe) throw refuse(`No driver can read ${node.nativeType} on ${node.provider}, so a claim over it cannot be verified.`);
  const facts = factsForNode(node);
  const owners = (() => {
    try { return assertClaimMatchesRegistry(node.nativeType, node.address, facts, claim); }
    catch (e) { throw asStep(e); }
  })();
  const approvalId = await approvalFor(rt, ec.op.id);
  const connection = await resolveConnection(rt, ec);
  await rt.d.leases.assertFence(lease.scope, lease.fenceToken);

  const observation = await withKeepAlive(rt, { lease, detail: "verify adoption claim", operation: { workspaceId: ec.workspaceId, operationId: ec.op.id } }, (signal) =>
    withProviderSession(rt, ec, { purpose: "observe", capability: "infrastructure.observe", connection, fence: lease }, (session) =>
      driver.observe!(driverContext(rt, ec, session, AbortSignal.any([signal, AbortSignal.timeout(rt.limits.nodeTimeoutMs)]), { node, fence: lease, connection }), node, claim.externalId)
    )
  );
  await rt.d.leases.assertFence(lease.scope, lease.fenceToken);
  try {
    if (observation.address !== node.address) throw new PortabilityError("ownership_unproven", "The driver returned an observation for a different resource.");
    assertClaimedObjectIsLive({ claim, ...(row.externalId ? { rowExternalId: row.externalId } : {}), observation, sandbox: ec.product.environment.class === "sandbox" });
  } catch (e) { throw asStep(e); }

  const identity = { workspaceId: ec.workspaceId, environmentId: ec.environmentId, address: row.address, provider: row.provider, nativeType: row.nativeType };
  const baseline = buildBaseline({ nativeType: node.nativeType, address: node.address, attributes: observation.attributes, facts, observedAt: observation.observedAt });
  await rt.emit(ec.scope, "resource.applying", `capability:${ec.op.id}`, { capability: "resource.adopt", address: row.address });
  const adoption = await port.adopt({
    workspaceId: ec.workspaceId, environmentId: ec.environmentId, resourceId: row.id, operationId: ec.op.id, approvalId, externalId: claim.externalId, lifecycle: claim.lifecycle,
    claim: { externalId: claim.externalId, lifecycle: claim.lifecycle, fields: claim.fields, ...(claim.note ? { note: claim.note } : {}) }, claimDigest: claimDigest(identity, claim), fieldOwners: owners,
    baseline: { v: baseline.v, observedAt: baseline.observedAt, attributes: baseline.attributes, excluded: baseline.excluded }, baselineDigest: baseline.digest,
  });
  await rt.evidence(ec.scope, { kind: "observation", digest: digest({ op: ec.op.id, capability: "resource.adopt", adoption: adoption.id, baseline: baseline.digest }), summary: { kind: "capability", capability: "resource.adopt", address: row.address, ok: true, adoptionId: adoption.id, lifecycle: adoption.lifecycle, claimDigest: adoption.claimDigest, baselineDigest: adoption.baselineDigest, baselineFields: Object.keys(baseline.attributes).length, excludedFields: baseline.excluded.length }, simulated: observation.simulated, key: `capability:${ec.op.id}` }, { critical: true });
  await rt.emit(ec.scope, "resource.applied", `capability:${ec.op.id}`, { capability: "resource.adopt", address: row.address });
  return { ok: true, summary: `Adopted ${row.address} (${adoption.lifecycle}): ownership claim ${adoption.id}, drift baseline of ${Object.keys(baseline.attributes).length} fields recorded.` };
}

/* --------------------------------- release --------------------------------- */

async function runRelease(rt: Runtime, ec: ExecContext, row: StoredResource, lease: LeaseRef): Promise<Outcome> {
  const port = requirePort(rt);
  const input = parseInput(ReleaseInputSchema, ec.op.proposal.input, "resource.release");
  const adoption = await port.getAdoption(ec.workspaceId, input.adoptionId);
  if (!adoption || adoption.resourceId !== row.id || adoption.environmentId !== ec.environmentId) throw refuse("That adoption claim does not belong to this resource.");
  if (adoption.status !== "active") throw refuse("That adoption claim is already released.");
  const approvalId = await approvalFor(rt, ec.op.id);
  await rt.d.leases.assertFence(lease.scope, lease.fenceToken);
  await rt.emit(ec.scope, "resource.applying", `capability:${ec.op.id}`, { capability: "resource.release", address: row.address });
  const released = await port.release({ workspaceId: ec.workspaceId, environmentId: ec.environmentId, resourceId: row.id, adoptionId: adoption.id, operationId: ec.op.id, approvalId, releasedBy: ec.op.principal.id });
  await rt.evidence(ec.scope, { kind: "observation", digest: digest({ op: ec.op.id, capability: "resource.release", adoption: released.id }), summary: { kind: "capability", capability: "resource.release", address: row.address, ok: true, adoptionId: released.id }, simulated: false, key: `capability:${ec.op.id}` }, { critical: true });
  await rt.emit(ec.scope, "resource.applied", `capability:${ec.op.id}`, { capability: "resource.release", address: row.address });
  return { ok: true, summary: `Released ${row.address}: Zenith no longer manages it and did not touch the object.` };
}

/* --------------------------------- entry ----------------------------------- */

export async function executePortabilityCapability(rt: Runtime, ec: ExecContext, row: StoredResource, node: ResourceNode, name: PortabilityCapability & CapabilityName, lease: LeaseRef): Promise<Outcome> {
  switch (name) {
    case "data.export":
      return runDataExport(rt, ec, row, lease);
    case "data.import":
      return runDataImport(rt, ec, row, lease);
    case "resource.adopt":
      return runAdopt(rt, ec, row, node, lease);
    case "resource.release":
      return runRelease(rt, ec, row, lease);
  }
}
