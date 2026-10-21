/**
 * J4 A2: prepare one actual, owned local Kubernetes target for the A1 consent
 * and B registered-agent adapters. This module is deliberately not a fixture
 * seeder: every target identifier comes from an authenticated product response,
 * the ordinary deploy.apply workflow, or a read-only query to the verified J1
 * database. It never returns credentials.
 */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { load as yamlLoad } from "js-yaml";
import {
  action,
  browserRequest,
  command,
  docker,
  ensure,
  kindReadback,
  kubeconfig,
  ok,
  until,
} from "../../../tests/e2e/default/support.mjs";

const ADDRESS = "service/witness";
const SERVICE_ID = "witness";
const SHA256 = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9_.:-]{1,200}$/;

function sha256(value) {
  return createHash("sha256").update(Buffer.isBuffer(value) ? value : typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("j4-target:nonfinite-binding");
  return JSON.stringify(value);
}

function requireValue(value, id) {
  if (!value) throw new Error(`j4-target:${id}`);
  return value;
}

function readPinnedPrivate(file, expectedSha256, privateRoot, { maxBytes = 1024 * 1024, modes = [0o600] } = {}) {
  if (typeof process.getuid !== "function" || !path.isAbsolute(file) || !SHA256.test(expectedSha256 ?? "")
    || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 4 * 1024 * 1024 || !Array.isArray(modes))
    throw new Error("j4-target:private-pin-arguments");
  const root = fs.realpathSync(privateRoot);
  const parent = path.dirname(file);
  const parentReal = fs.realpathSync(parent);
  const relative = path.relative(root, parentReal);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("j4-target:private-pin-scope");
  for (let current = file; current !== path.dirname(current); current = path.dirname(current)) {
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error("j4-target:private-pin-symlink");
  }
  const before = fs.lstatSync(file);
  const mode = before.mode & 0o777;
  if (!before.isFile() || before.isSymbolicLink() || before.uid !== process.getuid() || !modes.includes(mode)
    || before.nlink !== 1 || before.size > maxBytes) throw new Error("j4-target:private-pin-stat");
  const noFollow = fs.constants.O_NOFOLLOW;
  if (!Number.isInteger(noFollow)) throw new Error("j4-target:nofollow-unavailable");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.uid !== process.getuid()
      || (opened.mode & 0o777) !== mode || opened.nlink !== 1 || opened.size !== before.size || opened.size > maxBytes)
      throw new Error("j4-target:private-pin-open-identity");
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || sha256(bytes) !== expectedSha256)
      throw new Error("j4-target:private-pin-read-identity");
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}

function parseObserverKubeconfig(text, expectedCaData) {
  const value = yamlLoad(text);
  const keys = (object, names) => object && typeof object === "object" && !Array.isArray(object)
    && Object.keys(object).sort().join("\u0000") === [...names].sort().join("\u0000");
  if (!keys(value, ["apiVersion", "kind", "clusters", "contexts", "current-context", "users", "preferences"])
    || value.apiVersion !== "v1" || value.kind !== "Config" || value["current-context"] !== "kind-zenith-j2"
    || !Array.isArray(value.clusters) || value.clusters.length !== 1 || !Array.isArray(value.contexts) || value.contexts.length !== 1
    || !Array.isArray(value.users) || value.users.length !== 1 || !keys(value.preferences, []))
    throw new Error("j4-target:observer-kubeconfig-shape");
  const clusterEntry = value.clusters[0], contextEntry = value.contexts[0], userEntry = value.users[0];
  if (!keys(clusterEntry, ["name", "cluster"]) || clusterEntry.name !== "kind-zenith-j2"
    || !keys(clusterEntry.cluster, ["server", "certificate-authority-data"])
    || clusterEntry.cluster["certificate-authority-data"] !== expectedCaData
    || !/^https:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(clusterEntry.cluster.server)
    || Number(clusterEntry.cluster.server.slice(clusterEntry.cluster.server.lastIndexOf(":") + 1)) > 65535)
    throw new Error("j4-target:observer-cluster-binding");
  if (!keys(contextEntry, ["name", "context"]) || contextEntry.name !== "kind-zenith-j2"
    || !keys(contextEntry.context, ["cluster", "user"]) || contextEntry.context.cluster !== clusterEntry.name
    || typeof contextEntry.context.user !== "string" || !contextEntry.context.user
    || !keys(userEntry, ["name", "user"]) || userEntry.name !== contextEntry.context.user
    || !keys(userEntry.user, ["client-certificate-data", "client-key-data"])
    || ![userEntry.user["client-certificate-data"], userEntry.user["client-key-data"]].every(value =>
      typeof value === "string" && value.length > 0
      && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)))
    throw new Error("j4-target:observer-static-client-identity");
  return { server: clusterEntry.cluster.server, caData: clusterEntry.cluster["certificate-authority-data"],
    context: "kind-zenith-j2", userIdentity: "static-client-certificate-and-key" };
}

function assertKubeconfigPins(binding, owner, privateDir) {
  const files = [
    ["deployment", binding.kubeconfigFile],
    ["rotation", binding.rotationKubeconfigFile],
    ["observer", binding.observerKubeconfigFile],
  ];
  const contents = {};
  for (const [name, file] of files) {
    const ref = owner.kubeconfigs?.[name];
    if (!ref || ref.path !== file || !SHA256.test(ref.sha256 ?? "")) throw new Error(`j4-target:kind-${name}-kubeconfig-ref`);
    contents[name] = readPinnedPrivate(file, ref.sha256, privateDir, { maxBytes: 1024 * 1024, modes: [0o600, 0o400] }).toString("utf8");
  }
  const deployment = kubeconfig(binding.kubeconfigFile, { kind: binding });
  const rotation = kubeconfig(binding.rotationKubeconfigFile, { kind: binding });
  const observer = parseObserverKubeconfig(contents.observer, deployment.caData);
  if (deployment.text !== contents.deployment || rotation.text !== contents.rotation
    || deployment.caData !== observer.caData || deployment.caData !== binding.caData
    || rotation.caData !== deployment.caData || rotation.text === deployment.text)
    throw new Error("j4-target:kind-kubeconfig-byte-bind");
  for (const [name, file] of files) {
    const ref = owner.kubeconfigs[name];
    readPinnedPrivate(file, ref.sha256, privateDir, { maxBytes: 1024 * 1024, modes: [0o600, 0o400] });
  }
  return { deploymentText: deployment.text, rotationText: rotation.text, observerText: observer.text,
    deploymentCaData: deployment.caData, observerCaData: observer.caData, observerServer: observer.server };
}

function assertPrivateDirectory(directory, ownerRoot) {
  if (!path.isAbsolute(directory) || path.resolve(directory) !== directory) throw new Error("j4-target:private-path");
  const stat = fs.lstatSync(directory);
  if (typeof process.getuid !== "function" || !stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()
    || (stat.mode & 0o777) !== 0o700) throw new Error("j4-target:private-owner-mode");
  const real = fs.realpathSync(directory);
  const root = fs.realpathSync(ownerRoot);
  if (real !== root) throw new Error("j4-target:private-root-binding");
  for (let current = real; current !== path.dirname(current); current = path.dirname(current)) {
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error("j4-target:private-path-ancestor-symlink");
  }
  return real;
}

function safeR9Binding(binding) {
  const hasExactKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join("\u0000") === [...keys].sort().join("\u0000");
  const fileRef = value => hasExactKeys(value, ["path", "sha256"]) && path.isAbsolute(value.path) && SHA256.test(value.sha256 ?? "");
  const rootKeys = ["schemaVersion", "kind", "runId", "source", "r16SourceFreezeSha256", "evidence", "r9", "cleanupEpoch",
    "privateDir", "apiOrigin", "supabaseOrigin", "runtime", "bindingSha256"];
  const sourceKeys = ["head", "contentSha256", "dirty"];
  const evidenceKeys = ["r16Summary", "r16Execution", "witnessR10"];
  const r9Keys = ["privateRuntime", "stackDirectory", "joined", "state", "ownership", "preapi", "prestart", "completion", "readiness"];
  const runtimeKeys = ["installationId", "applicationInstallationId", "supabaseProjectId", "applicationProjectName", "apiContainerId",
    "databaseContainerId", "workerContainerId", "apiOwnerLabels", "databaseOwnerLabels", "workerOwnerLabels", "databaseIdentitySha256",
    "apiEnvironment", "workerEnvironment", "hostEnvironment"];
  const r9Refs = ["joined", "state", "ownership", "preapi", "prestart", "completion", "readiness"];
  if (!hasExactKeys(binding, rootKeys) || !hasExactKeys(binding?.source, sourceKeys)
    || !hasExactKeys(binding?.evidence, evidenceKeys) || !hasExactKeys(binding?.r9, r9Keys)
    || !hasExactKeys(binding?.runtime, runtimeKeys) || !evidenceKeys.every(key => fileRef(binding.evidence[key]))
    || !r9Refs.every(key => fileRef(binding.r9[key]))
    || !["apiEnvironment", "workerEnvironment", "hostEnvironment"].every(key => fileRef(binding.runtime[key])))
    throw new Error("j4-target:binding-closed-shape");
  const validId = value => typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);
  const runIdValid = /^[a-z0-9][a-z0-9-]{3,19}$/.test(binding?.runId ?? "");
  const source = binding?.source, runtime = binding?.runtime;
  const { bindingSha256: _bindingSha256, ...bindingWithoutHash } = binding ?? {};
  if (binding?.schemaVersion !== 1 || binding.kind !== "j4_fixture_binding" || !runIdValid
    || !source || !/^[a-f0-9]{40}$/.test(source.head ?? "") || !SHA256.test(source.contentSha256 ?? "") || source.dirty !== false
    || !SHA256.test(binding.r16SourceFreezeSha256 ?? "") || !binding.r9 || !path.isAbsolute(binding.r9.privateRuntime ?? "")
    || !path.isAbsolute(binding.r9.stackDirectory ?? "") || !validId(binding.r9.joined?.path) || !SHA256.test(binding.r9.joined?.sha256 ?? "")
    || !path.isAbsolute(binding.privateDir ?? "") || binding.privateDir !== path.join(binding.r9.privateRuntime, "signed-delivery")
    || typeof binding.cleanupEpoch !== "string" || !Number.isFinite(Date.parse(binding.cleanupEpoch))
    || !SHA256.test(binding.bindingSha256 ?? "") || sha256(stableJson(bindingWithoutHash)) !== binding.bindingSha256
    || !validId(runtime?.installationId) || !validId(runtime?.applicationInstallationId)
    || !validId(runtime?.supabaseProjectId) || !/^[a-f0-9]{64}$/.test(runtime?.apiContainerId ?? "")
    || !/^[a-f0-9]{64}$/.test(runtime?.databaseContainerId ?? "") || !/^[a-f0-9]{64}$/.test(runtime?.workerContainerId ?? "")) {
    throw new Error("j4-target:binding-schema-invalid");
  }
  const joinedBytes = readPinnedPrivate(binding.r9.joined.path, binding.r9.joined.sha256, binding.r9.privateRuntime,
    { maxBytes: 4 * 1024 * 1024, modes: [0o600, 0o400] });
  const joined = JSON.parse(joinedBytes.toString("utf8"));
  const expectedJ2Counts = { failed: 0, not_run: 0, passed: 18, skipped: 0 };
  if (!hasExactKeys(joined.j2Counts, Object.keys(expectedJ2Counts))
    || !Object.values(joined.j2Counts).every(Number.isSafeInteger)
    || Object.keys(expectedJ2Counts).some(key => joined.j2Counts[key] !== expectedJ2Counts[key]))
    throw new Error("j4-target:j2-joined-counts");
  if (joined.status !== "j1-j4-j2-passed-trust-restore-required" || joined.j1Ready !== true || joined.j4Complete !== true
    || joined.j2Ready !== true || joined.wrapperTrustMutationPerformed !== false || joined.j2RunId !== binding.runId
    || joined.source?.head !== source.head || joined.source?.contentSha256 !== source.contentSha256 || joined.source?.dirty !== false)
    throw new Error("j4-target:r9-joined-binding");
  const api = new URL(binding.apiOrigin);
  if (api.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(api.hostname) || api.username || api.password || api.origin !== binding.apiOrigin) throw new Error("j4-target:api-origin");
  return { source, runtime, apiUrl: api.origin, cleanupEpoch: binding.cleanupEpoch,
    runId: binding.runId, bindingSha256: binding.bindingSha256, privateRoot: binding.privateDir, joined };
}

function assertKindBinding(binding, r9Binding, privateDir) {
  if (!binding || binding.clusterName !== "zenith-j2" || binding.namespace !== "zenith-j2"
    || binding.server !== "https://zenith-j2-control-plane:6443"
    || !/^[a-f0-9]{64}$/.test(binding.clusterContainerId ?? "")
    || !/^[A-Za-z0-9][A-Za-z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(binding.image ?? "")
    || typeof binding.context !== "string" || !binding.context
    || !path.isAbsolute(binding.kubeconfigFile ?? "") || !path.isAbsolute(binding.rotationKubeconfigFile ?? "")
    || !path.isAbsolute(binding.observerKubeconfigFile ?? "")) throw new Error("j4-target:local-kind-binding");
  const ref = binding.ownerReceipt;
  if (!ref || !path.isAbsolute(ref.path) || !SHA256.test(ref.sha256 ?? "")) throw new Error("j4-target:kind-owner-receipt-ref");
  const bytes = readPinnedPrivate(ref.path, ref.sha256, privateDir, { maxBytes: 1024 * 1024, modes: [0o600] });
  const owner = JSON.parse(bytes.toString("utf8"));
  if (owner.schemaVersion !== 1 || owner.kind !== "j4_owned_kind_fixture" || owner.status !== "observed"
    || owner.runId !== r9Binding.runId || owner.bindingSha256 !== r9Binding.bindingSha256
    || owner.clusterContainerId !== binding.clusterContainerId || owner.clusterName !== binding.clusterName
    || owner.namespace !== binding.namespace || owner.server !== binding.server || owner.image !== binding.image
    || !SHA256.test(owner.configSha256 ?? "") || !/^[a-f0-9]{64}$/.test(owner.controlPlaneContainerId ?? "")
    || !/^[a-f0-9]{64}$/.test(owner.buildContainerId ?? "") || !owner.kubeconfigs
    || !owner.containerImages || typeof owner.containerImages.cluster !== "string"
    || typeof owner.containerImages.controlPlane !== "string" || typeof owner.containerImages.build !== "string"
    || owner.kubeconfigs.deployment?.path !== binding.kubeconfigFile
    || owner.kubeconfigs.rotation?.path !== binding.rotationKubeconfigFile
    || owner.kubeconfigs.observer?.path !== binding.observerKubeconfigFile
    || !SHA256.test(owner.kubeconfigs.deployment?.sha256 ?? "") || !SHA256.test(owner.kubeconfigs.rotation?.sha256 ?? "")
    || !SHA256.test(owner.kubeconfigs.observer?.sha256 ?? "") || !owner.controlPlaneOwnerLabels
    || !owner.buildOwnerLabels) throw new Error("j4-target:kind-owner-receipt-binding");
  return owner;
}

function writeCheckpoint(privateDir, runId, ordinal, state) {
  const file = path.join(privateDir, `j4-target-${runId}-${String(ordinal).padStart(2, "0")}.private.json`);
  const body = { schemaVersion: 1, runId, ...state };
  fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1) throw new Error("j4-target:checkpoint-private");
  return { path: file, sha256: sha256(fs.readFileSync(file)) };
}

async function inspectOwnedRuntime(r9, kind, kindOwner) {
  const [apiRaw, dbRaw, workerRaw, kindRaw, controlPlaneRaw, buildRaw] = await Promise.all([
    docker(["inspect", r9.runtime.apiContainerId]),
    docker(["inspect", r9.runtime.databaseContainerId]),
    docker(["inspect", r9.runtime.workerContainerId]),
    docker(["inspect", kind.clusterContainerId]),
    docker(["inspect", kindOwner.controlPlaneContainerId]),
    docker(["inspect", kindOwner.buildContainerId]),
  ]);
  const [api] = JSON.parse(apiRaw), [db] = JSON.parse(dbRaw), [worker] = JSON.parse(workerRaw), [node] = JSON.parse(kindRaw);
  const [controlPlane] = JSON.parse(controlPlaneRaw), [build] = JSON.parse(buildRaw);
  ensure(api.Id === r9.runtime.apiContainerId && db.Id === r9.runtime.databaseContainerId
    && worker.Id === r9.runtime.workerContainerId && node.Id === kind.clusterContainerId
    && controlPlane.Id === kindOwner.controlPlaneContainerId && build.Id === kindOwner.buildContainerId, "j4-target-exact-container-ids");
  const apiLabels = api.Config?.Labels ?? {};
  const dbLabels = db.Config?.Labels ?? {};
  ensure(apiLabels["io.zenith.installation"] === r9.runtime.applicationInstallationId
    || apiLabels["io.zenith.installation"] === r9.runtime.installationId, "j4-target-api-owner");
  ensure(dbLabels["com.supabase.cli.project"] === r9.runtime.supabaseProjectId
    && dbLabels["io.zenith.installation"] === r9.runtime.installationId, "j4-target-db-owner");
  for (const [key, value] of Object.entries(r9.runtime.apiOwnerLabels)) ensure(apiLabels[key] === value, "j4-target-api-owner-labels");
  for (const [key, value] of Object.entries(r9.runtime.databaseOwnerLabels)) ensure(dbLabels[key] === value, "j4-target-db-owner-labels");
  for (const [key, value] of Object.entries(r9.runtime.workerOwnerLabels)) ensure(worker.Config?.Labels?.[key] === value, "j4-target-worker-owner-labels");
  for (const [key, value] of Object.entries(kindOwner.controlPlaneOwnerLabels)) ensure(controlPlane.Config?.Labels?.[key] === value, "j4-target-kind-control-plane-owner");
  for (const [key, value] of Object.entries(kindOwner.buildOwnerLabels)) ensure(build.Config?.Labels?.[key] === value, "j4-target-kind-build-owner");
  ensure(node.Config?.Labels?.["io.x-k8s.kind.cluster"] === kind.clusterName, "j4-target-kind-owner");
  ensure(node.Config?.Image === kindOwner.containerImages.cluster && controlPlane.Config?.Image === kindOwner.containerImages.controlPlane
    && build.Config?.Image === kindOwner.containerImages.build, "j4-target-kind-image-owner");
  return {
    api: { id: api.Id, image: api.Config?.Image, running: api.State?.Running === true },
    database: { id: db.Id, running: db.State?.Running === true, projectLabel: dbLabels["com.supabase.cli.project"], installationLabel: dbLabels["io.zenith.installation"] },
    worker: { id: worker.Id, running: worker.State?.Running === true },
    kind: { id: node.Id, running: node.State?.Running === true, clusterLabel: node.Config?.Labels?.["io.x-k8s.kind.cluster"] },
    kindControlPlane: { id: controlPlane.Id, image: controlPlane.Config?.Image, running: controlPlane.State?.Running === true },
    kindBuild: { id: build.Id, image: build.Config?.Image, running: build.State?.Running === true },
  };
}

async function getOperation(page, apiUrl, workspaceId, operationId) {
  const detail = ok(await browserRequest(page, `/api/platform/v1/operations/${encodeURIComponent(operationId)}`, undefined, "GET", workspaceId));
  return detail;
}

async function approveOperation({ page, apiUrl, workspaceId, operationId, approverUserId }) {
  const before = await getOperation(page, apiUrl, workspaceId, operationId);
  ensure(before.operation.status === "awaiting_approval" && before.decision?.approval?.separationOfDuties === true
    && before.operation.principal.id !== approverUserId, "j4-target-independent-approval-required");
  await page.goto(`${apiUrl}/platform/operations/${encodeURIComponent(operationId)}`);
  const response = page.waitForResponse(value => value.url().endsWith(`/operations/${operationId}/approve`) && value.request().method() === "POST");
  await page.getByRole("button", { name: /^Approve / }).click();
  const approved = await response;
  ensure(approved.ok() && (await approved.json()).operation?.status === "approved", "j4-target-browser-approval");
  const after = await getOperation(page, apiUrl, workspaceId, operationId);
  ensure(after.approvals.some(value => value.approverId === approverUserId && value.decision === "approve"), "j4-target-approver-readback");
  return after;
}

/**
 * Create and read back a fresh actual J2 local target. `actualBrowserContext`
 * is supplied by the R9/Auth owner and must contain two distinct real pages.
 * The fixed source-pinned coordinator is responsible for holding this call and
 * its helper descendants under R17 custody. This function does not authenticate,
 * mint agent consent or start zenithd.
 */
export async function prepareTarget({ r9Binding, actualBrowserContext, ownedLocalKindBinding }) {
  const r9 = safeR9Binding(r9Binding);
  const directory = assertPrivateDirectory(r9Binding.privateDir, r9.privateRoot);
  const kindOwner = assertKindBinding(ownedLocalKindBinding, r9Binding, directory);
  const { requesterPage, approverPage, requesterUserId, approverUserId, approverEmail } = actualBrowserContext ?? {};
  if (!requesterPage || !approverPage || requesterPage === approverPage || !ID.test(requesterUserId ?? "")
    || !ID.test(approverUserId ?? "") || requesterUserId === approverUserId || !/^\S+@\S+\.\S+$/.test(approverEmail ?? ""))
    throw new Error("j4-target:actual-browser-context");
  const runId = r9.runId;
  const inputBinding = {
    runId,
    sourceHead: r9.source.head,
    sourceContentSha256: r9.source.contentSha256,
    r16SourceFreezeSha256: r9Binding.r16SourceFreezeSha256,
    bindingSha256: r9.bindingSha256,
    r9JoinedSha256: r9Binding.r9.joined.sha256,
    cleanupEpoch: r9.cleanupEpoch,
    installationId: r9.runtime.installationId,
    applicationInstallationId: r9.runtime.applicationInstallationId,
    apiContainerId: r9.runtime.apiContainerId,
    databaseContainerId: r9.runtime.databaseContainerId,
    supabaseProjectId: r9.runtime.supabaseProjectId,
    kindClusterContainerId: ownedLocalKindBinding.clusterContainerId,
    kindImage: ownedLocalKindBinding.image,
    namespace: ownedLocalKindBinding.namespace,
  };
  const inputBindingSha256 = sha256(inputBinding);
  let ordinal = 0;
  const created = { workspaceId: null, projectId: null, projectSlug: null, connectionId: null, environmentId: null, deploymentId: null, operationId: null, resourceId: null };
  const facts = [];
  const checkpoint = (id, status, readback = null) => {
    facts.push({ id, status, ...(readback ? { readback } : {}) });
    return writeCheckpoint(directory, runId, ++ordinal, {
      inputBindingSha256,
      sourceBinding: r9.source,
      bindingSha256: r9.bindingSha256,
      cleanupEpoch: r9.cleanupEpoch,
      runtimeBinding: { installationId: r9.runtime.installationId, applicationInstallationId: r9.runtime.applicationInstallationId,
        apiContainerId: r9.runtime.apiContainerId, databaseContainerId: r9.runtime.databaseContainerId, supabaseProjectId: r9.runtime.supabaseProjectId },
      status: status === "failed" ? "incomplete" : "in_progress",
      lastStep: { id, status },
      created,
      facts: [...facts],
    });
  };
  const lifecycleHandle = {
    runId, bindingSha256: r9.bindingSha256, status: "preparing", cleanupBlocked: false,
    ownedRuntime: { apiContainerId: r9.runtime.apiContainerId, databaseContainerId: r9.runtime.databaseContainerId,
      workerContainerId: r9.runtime.workerContainerId, kindContainerId: ownedLocalKindBinding.clusterContainerId },
    partialTarget: created, checkpointFacts: facts, cleanupAuthority: "orchestrator-only",
  };
  let activeStep = "runtime-owner-check";
  try {
    checkpoint(activeStep, "attempting");
    const runtimeReadback = await inspectOwnedRuntime(r9, ownedLocalKindBinding, kindOwner);
    ensure(runtimeReadback.api.running && runtimeReadback.database.running && runtimeReadback.worker.running
      && runtimeReadback.kind.running && runtimeReadback.kindControlPlane.running && runtimeReadback.kindBuild.running, "j4-target-runtime-running");
    checkpoint(activeStep, "observed", sha256(runtimeReadback));

    activeStep = "kind-config-binding"; checkpoint(activeStep, "attempting");
    const kubeconfigs = assertKubeconfigPins(ownedLocalKindBinding, kindOwner, directory);
    ensure(kubeconfigs.deploymentCaData === kubeconfigs.observerCaData && kubeconfigs.deploymentCaData === ownedLocalKindBinding.caData,
      "j4-target-kind-ca-binding");
    checkpoint(activeStep, "observed", sha256({ server: ownedLocalKindBinding.server, namespace: ownedLocalKindBinding.namespace,
      context: ownedLocalKindBinding.context, caData: kubeconfigs.deploymentCaData, image: ownedLocalKindBinding.image,
      kubeconfigs: Object.fromEntries(Object.entries(kindOwner.kubeconfigs).map(([key, value]) => [key, value.sha256])),
      observerServer: kubeconfigs.observerServer }));

    activeStep = "workspace-created"; checkpoint(activeStep, "attempting");
    const workspace = ok(await browserRequest(requesterPage, "/api/workspace", { name: `J4 ${runId.slice(0, 8)}` }));
    created.workspaceId = requireValue(workspace.workspace?.id, "workspace-id");
    ensure(ID.test(created.workspaceId), "j4-target-workspace-id");
    const requesterBootstrap = ok(await browserRequest(requesterPage, "/api/bootstrap"));
    ensure(requesterBootstrap.user?.id === requesterUserId && requesterBootstrap.role === "admin"
      && requesterBootstrap.workspace?.id === created.workspaceId
      && requesterBootstrap.members?.some(member => member.id === requesterUserId && member.role === "admin"), "j4-target-requester-admin-readback");
    checkpoint(activeStep, "observed", sha256({ workspaceId: created.workspaceId, requesterUserId, role: requesterBootstrap.role }));

    activeStep = "approver-invited"; checkpoint(activeStep, "attempting");
    const invite = ok(await browserRequest(requesterPage, "/api/workspace/invites", {
      email: approverEmail, role: "admin", workspaceId: created.workspaceId,
    }, "POST", created.workspaceId));
    const accepted = ok(await browserRequest(approverPage, `/api/workspace/invites/${encodeURIComponent(invite.invite.id)}/accept`, {}, "POST"));
    ensure(accepted.member?.id === approverUserId && accepted.member?.role === "admin", "j4-target-approver-membership");
    const approverBootstrap = ok(await browserRequest(approverPage, "/api/bootstrap"));
    ensure(approverBootstrap.user?.id === approverUserId && approverBootstrap.role === "admin"
      && approverBootstrap.workspace?.id === created.workspaceId
      && approverBootstrap.members?.some(member => member.id === approverUserId && member.role === "admin"), "j4-target-approver-admin-readback");
    checkpoint(activeStep, "observed", sha256({ workspaceId: created.workspaceId, requesterUserId, approverUserId,
      requesterRole: requesterBootstrap.role, approverRole: approverBootstrap.role }));

    activeStep = "project-created"; checkpoint(activeStep, "attempting");
    const project = await action(requesterPage, "project.create", { name: `J4 target ${runId.slice(0, 8)}`, withEnvironment: false });
    created.projectId = requireValue(project.projectId, "project-id"); created.projectSlug = requireValue(project.slug, "project-slug");
    ensure(ID.test(created.projectId) && /^[a-z0-9][a-z0-9-]{0,60}$/.test(created.projectSlug), "j4-target-project-identity");
    checkpoint(activeStep, "observed", sha256({ projectId: created.projectId, projectSlug: created.projectSlug }));

    activeStep = "manifest-created"; checkpoint(activeStep, "attempting");
    const witnessNonce = randomUUID();
    const manifest = {
      version: 2,
      placement: { provider: "kubernetes", regions: ["in-cluster"] },
      providerConfig: { kubernetes: { namespace: ownedLocalKindBinding.namespace } },
      services: [{ id: SERVICE_ID, name: "witness", kind: "web", source: { type: "image", image: ownedLocalKindBinding.image },
        size: "small", replicas: 1, port: 8080, healthPath: "/", ownership: "managed",
        env: [{ key: "WITNESS_NONCE", value: witnessNonce }] }],
      resources: [], routes: [], bindings: [],
    };
    const manifestResult = await action(requesterPage, "project.updateManifest", { projectId: created.projectId, manifest });
    ensure(manifestResult && typeof manifestResult === "object", "j4-target-manifest-write");
    const manifestSha256 = sha256(manifest);
    checkpoint(activeStep, "observed", manifestSha256);

    activeStep = "local-kind-credential-bound"; checkpoint(activeStep, "attempting");
    const oldKubeconfig = kubeconfigs.deploymentText;
    ensure(kubeconfigs.deploymentCaData === kubeconfigs.observerCaData && kubeconfigs.rotationText !== oldKubeconfig,
      "j4-target-rotation-identity");
    const secret = await action(requesterPage, "system.setSecret", { projectId: created.projectId, serviceId: SERVICE_ID,
      key: "J4_KIND_DEPLOYER", secretRef: "vault:J4_KIND_DEPLOYER", secretValue: oldKubeconfig });
    ensure(secret !== undefined, "j4-target-vault-secret-write");
    await action(requesterPage, "project.updateManifest", { projectId: created.projectId, manifest });
    checkpoint(activeStep, "observed", sha256({ projectId: created.projectId, key: "J4_KIND_DEPLOYER", secretRef: "vault:J4_KIND_DEPLOYER" }));

    activeStep = "local-kind-connection-created"; checkpoint(activeStep, "attempting");
    const connection = await action(requesterPage, "connection.createKubernetes", {
      label: `J4 kind ${runId.slice(0, 8)}`, server: ownedLocalKindBinding.server, caData: kubeconfigs.deploymentCaData,
      namespaces: [ownedLocalKindBinding.namespace], credentialRef: "vault:J4_KIND_DEPLOYER", scopedGuest: false,
    });
    created.connectionId = requireValue(connection.connectionId, "connection-id");
    ensure(ID.test(created.connectionId), "j4-target-connection-id");
    await requesterPage.goto(`${r9.apiUrl}/platform/connections`);
    const card = requesterPage.getByRole("listitem").filter({ hasText: `J4 kind ${runId.slice(0, 8)}` });
    const verifyResponse = requesterPage.waitForResponse(value => value.url().endsWith(`/connections/${created.connectionId}/verify`) && value.request().method() === "POST");
    await card.getByRole("button", { name: "Verify", exact: true }).click();
    ensure((await verifyResponse).ok(), "j4-target-connection-verify-ui");
    const connectionReadback = ok(await browserRequest(requesterPage, `/api/platform/v1/connections/${created.connectionId}`, undefined, "GET", created.workspaceId));
    ensure(connectionReadback.connection?.id === created.connectionId && connectionReadback.connection.status === "verified"
      && connectionReadback.connection.provider === "kubernetes" && connectionReadback.connection.server === ownedLocalKindBinding.server,
      "j4-target-connection-readback");
    checkpoint(activeStep, "observed", sha256({ id: created.connectionId, status: connectionReadback.connection.status,
      provider: connectionReadback.connection.provider, server: ownedLocalKindBinding.server }));

    activeStep = "environment-created"; checkpoint(activeStep, "attempting");
    const environment = await action(requesterPage, "env.create", { projectId: created.projectId, name: "production", class: "production",
      connectionId: created.connectionId, approvalRequired: true });
    created.environmentId = requireValue(environment.environmentId, "environment-id");
    ensure(ID.test(created.environmentId), "j4-target-environment-id");
    const bootstrap = ok(await browserRequest(requesterPage, "/api/bootstrap"));
    const environmentRow = bootstrap.environments?.find(value => value.id === created.environmentId && value.projectId === created.projectId);
    ensure(environmentRow && typeof environmentRow.createdAt === "string" && Number.isFinite(Date.parse(environmentRow.createdAt)), "j4-target-environment-readback");
    const environmentCreatedAt = environmentRow.createdAt;
    checkpoint(activeStep, "observed", sha256({ environmentId: created.environmentId, projectId: created.projectId, connectionId: created.connectionId }));

    activeStep = "deploy-apply-proposed"; checkpoint(activeStep, "attempting");
    // The system map (and its deploy dock) is the project page itself; there is no /system route.
    await requesterPage.goto(`${r9.apiUrl}/p/${encodeURIComponent(created.projectSlug)}?env=${encodeURIComponent(created.environmentId)}`);
    await requesterPage.getByRole("button", { name: /pending change.*Review/ }).click();
    await requesterPage.getByLabel("Type production to confirm deploying to production", { exact: true }).fill("production");
    const applyResponse = requesterPage.waitForResponse(value => value.url().endsWith("/api/actions/deploy.apply") && value.request().method() === "POST");
    await requesterPage.getByRole("button", { name: "Request approval for production", exact: true }).click();
    const apply = await (await applyResponse).json();
    ensure(apply.result?.ok === true, "j4-target-deploy-apply-ui");
    created.deploymentId = requireValue(apply.result.data?.deploymentId, "deployment-id");
    created.operationId = requireValue(apply.result.data?.operationId, "operation-id");
    const proposed = await getOperation(requesterPage, r9.apiUrl, created.workspaceId, created.operationId);
    ensure(proposed.operation.status === "awaiting_approval" && proposed.operation.approvalRequired === true
      && proposed.operation.workspaceId === created.workspaceId && proposed.operation.projectId === created.projectId
      && proposed.operation.environmentId === created.environmentId && proposed.operation.principal.id === requesterUserId,
      "j4-target-deploy-proposal-binding");
    checkpoint(activeStep, "observed", sha256({ deploymentId: created.deploymentId, operationId: created.operationId,
      status: proposed.operation.status, workspaceId: proposed.operation.workspaceId, projectId: proposed.operation.projectId,
      environmentId: proposed.operation.environmentId, requesterUserId }));

    activeStep = "deploy-independent-approval"; checkpoint(activeStep, "attempting");
    await approveOperation({ page: approverPage, apiUrl: r9.apiUrl, workspaceId: created.workspaceId,
      operationId: created.operationId, approverUserId });
    await action(approverPage, "deploy.approve", { deploymentId: created.deploymentId },
      { projectId: created.projectId, environmentId: created.environmentId });
    const replanned = await until(() => getOperation(requesterPage, r9.apiUrl, created.workspaceId, created.operationId),
      value => value.operation?.status === "awaiting_approval" && value.operation.approvalRound > 0, 30_000);
    ensure(replanned.operation.approvalRequired === true && replanned.operation.projectId === created.projectId
      && replanned.operation.environmentId === created.environmentId, "j4-target-reapproval-binding");
    await approveOperation({ page: approverPage, apiUrl: r9.apiUrl, workspaceId: created.workspaceId,
      operationId: created.operationId, approverUserId });
    const terminal = await until(() => getOperation(requesterPage, r9.apiUrl, created.workspaceId, created.operationId),
      value => ["succeeded", "failed", "uncertain", "cancelled", "expired"].includes(value.operation?.status), 180_000);
    ensure(terminal.operation.status === "succeeded" && terminal.operation.workspaceId === created.workspaceId
      && terminal.operation.projectId === created.projectId && terminal.operation.environmentId === created.environmentId,
      "j4-target-deploy-terminal");
    checkpoint(activeStep, "observed", sha256({ operationId: created.operationId, status: terminal.operation.status,
      approvalRound: terminal.operation.approvalRound, deploymentId: created.deploymentId }));

    activeStep = "kind-deployment-readback"; checkpoint(activeStep, "attempting");
    const kindReadbackSha256 = await kindReadback({ kind: ownedLocalKindBinding }, 1, witnessNonce);
    checkpoint(activeStep, "observed", kindReadbackSha256);

    activeStep = "persisted-resource-readback"; checkpoint(activeStep, "attempting");
    const dbName = `supabase_db_${r9.runtime.supabaseProjectId}`;
    const [db] = JSON.parse(await docker(["inspect", r9.runtime.databaseContainerId]));
    ensure(db.Id === r9.runtime.databaseContainerId && db.Name?.replace(/^\//, "") === dbName
      && db.Config?.Labels?.["com.supabase.cli.project"] === r9.runtime.supabaseProjectId
      && db.Config?.Labels?.["io.zenith.installation"] === r9.runtime.installationId, "j4-target-sql-owner-recheck");
    const sql = "select coalesce(json_agg(json_build_object('id',id,'workspaceId',workspace_id,'projectId',project_id,'environmentId',environment_id,'address',address,'kind',kind,'provider',provider,'nativeType',native_type,'ownership',ownership,'status',status,'revisionId',revision_id,'createdAt',created_at::text)), '[]'::json)::text from platform.resources where workspace_id=:'workspace_id' and project_id=:'project_id' and environment_id=:'environment_id' and address=:'address' and ownership='managed' and status='active'";
    const rowsText = await command("docker", ["exec", "-i", r9.runtime.databaseContainerId, "psql", "-X", "-U", "postgres", "-d", "postgres",
      "-v", "ON_ERROR_STOP=1", "-v", `workspace_id=${created.workspaceId}`, "-v", `project_id=${created.projectId}`,
      "-v", `environment_id=${created.environmentId}`, "-v", `address=${ADDRESS}`, "-At", "-f", "-"], { input: sql });
    const rows = JSON.parse(rowsText);
    const epochText = await command("docker", ["exec", r9.runtime.databaseContainerId, "psql", "-X", "-U", "postgres", "-d", "postgres", "-At", "-c",
      "select installed_at::text from platform.cleanup_writer_epoch where singleton"]);
    ensure(epochText === r9.cleanupEpoch, "j4-target-live-cleanup-epoch");
    ensure(rows.length === 1, "j4-target-persisted-resource-cardinality");
    const resource = rows[0]; created.resourceId = requireValue(resource.id, "persisted-resource-id");
    ensure(/^res_[A-Za-z0-9_.:-]+$/.test(created.resourceId) && resource.workspaceId === created.workspaceId && resource.projectId === created.projectId
      && resource.environmentId === created.environmentId && resource.address === ADDRESS && resource.ownership === "managed"
      && resource.kind === "container_service" && resource.nativeType === "k8s:Deployment"
      && resource.status === "active" && resource.provider === "kubernetes"
      && typeof resource.revisionId === "string" && resource.revisionId.length > 0
      && typeof resource.createdAt === "string" && Number.isFinite(Date.parse(resource.createdAt)),
      "j4-target-persisted-resource-binding");
    const createdAfterEpoch = Date.parse(environmentCreatedAt) > Date.parse(r9.cleanupEpoch)
      && Date.parse(resource.createdAt) > Date.parse(r9.cleanupEpoch);
    ensure(createdAfterEpoch, "j4-target-created-after-epoch");
    checkpoint(activeStep, "observed", sha256({ id: resource.id, workspaceId: resource.workspaceId, projectId: resource.projectId,
      environmentId: resource.environmentId, address: resource.address, kind: resource.kind, nativeType: resource.nativeType,
      ownership: resource.ownership, status: resource.status,
      createdAt: resource.createdAt, environmentCreatedAt,
      provider: resource.provider, revisionId: resource.revisionId }));

    const resourceReadbackSha256 = facts.find(value => value.id === "persisted-resource-readback")?.readback;
    const ownerRecord = {
      schemaVersion: 1, kind: "j4_target_owner_receipt", runId, bindingSha256: r9.bindingSha256,
      source: r9.source, r16SourceFreezeSha256: r9Binding.r16SourceFreezeSha256, cleanupEpoch: r9.cleanupEpoch,
      target: { workspaceId: created.workspaceId, projectId: created.projectId, environmentId: created.environmentId,
        resourceId: created.resourceId, address: ADDRESS, connectionId: created.connectionId,
        deploymentId: created.deploymentId, operationId: created.operationId },
      resource: { provider: resource.provider, kind: resource.kind, nativeType: resource.nativeType,
        ownership: resource.ownership, status: resource.status, revisionId: resource.revisionId },
      timestamps: { environmentCreatedAt, resourceCreatedAt: resource.createdAt, createdAfterEpoch },
      readbacks: { runtimeOwnershipSha256: sha256(runtimeReadback), kindBindingSha256: facts.find(value => value.id === "kind-config-binding")?.readback,
        connectionSha256: facts.find(value => value.id === "local-kind-connection-created")?.readback,
        deploymentSha256: kindReadbackSha256, resourceReadbackSha256 },
      cleanupOwner: "j4-orchestrator-retain-until-joined-settlement",
      credentials: "not-included",
    };
    const outputFile = path.join(directory, `j4-target-${runId}-complete.private.json`);
    fs.writeFileSync(outputFile, `${JSON.stringify(ownerRecord, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    const outputStat = fs.lstatSync(outputFile);
    ensure(outputStat.isFile() && !outputStat.isSymbolicLink() && outputStat.uid === process.getuid?.()
      && (outputStat.mode & 0o777) === 0o600 && outputStat.nlink === 1, "j4-target-output-private");
    const targetFacts = {
      schemaVersion: 1, kind: "j4_target_facts", runId, bindingSha256: r9.bindingSha256,
      workspaceId: created.workspaceId, projectId: created.projectId, environmentId: created.environmentId,
      resourceId: created.resourceId, address: ADDRESS, environmentCreatedAt, resourceCreatedAt: resource.createdAt,
      createdAfterEpoch, deploymentId: created.deploymentId, operationId: created.operationId,
      resourceReadbackSha256, ownerReceipt: { path: outputFile, sha256: sha256(fs.readFileSync(outputFile)) },
    };
    lifecycleHandle.status = "target_observed";
    lifecycleHandle.targetFacts = targetFacts;
    return { targetFacts, lifecycleHandle };
  } catch {
    lifecycleHandle.status = "failed_retained_uncertain";
    lifecycleHandle.cleanupBlocked = true;
    lifecycleHandle.cleanupBlockedAtStep = activeStep;
    try { checkpoint(activeStep, "failed"); } catch { /* preserve the original fixed failure boundary */ }
    const error = new Error(`j4-target:${activeStep}`);
    error.lifecycleHandle = lifecycleHandle;
    throw error;
  }
}
