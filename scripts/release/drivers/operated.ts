/** Real operated J1/J2 plumbing. Every caller must opt in before credentials or engines are touched. */
import fs, { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, unlinkSync, rmSync, realpathSync } from "node:fs";
import postgres from "postgres";
import { createHash } from "node:crypto";
import { z } from "zod";
import path from "node:path";
import type { Browser, Page } from "@playwright/test";
import { chromium } from "@playwright/test";
import { load as yamlLoad } from "js-yaml";
import { readPrepared, sourceBinding, privateLocation, assertPrivate } from "../../deploy/installation.mjs";
import { readState, compose, docker, cleanup as cleanupStack } from "../../acceptance/default-stack/runtime.mjs";
import { Config, action, adminHeaders, browserRequest, command, ensure, jsonRequest, kindReadback, kubeconfig, linkedAgent, mcp, nonce, ok, operator, prerequisites, privateFile, sha256, until as journeyUntil, nativeHost } from "../../../tests/e2e/default/support.mjs";
import { enrollOperator } from "../../../tests/e2e/default/mfa.mjs";
import { localPaths, assertLocalDocker, waitFor } from "../local-environment";
import { requiredChecks, validateLocalReceipt, type LocalReceipt, type SourceBoundLocalReceipt, localEnvironment } from "../local-targets";
import { DRIVER_CHECKS, OPERATED_LABEL, OwnedCleanup, driverPlan, operatedReceipt, observerBinding, type DriverScenario } from "./operated-contract";

import { DRIVER_CHECKS as TENANT_EXPORT_CHECKS, DRIVER_LIMITS as TENANT_EXPORT_LIMITS, CleanupBlocker as TenantExportCleanupBlocker, OwnedCleanup as TenantExportCleanup, receiptExit, settleAfterQuiescence, validateOperatedReceipt, type DriverScenario as TenantExportScenario, type OperatedReceipt as TenantExportReceipt } from "./protocol";

import { ports } from "../../acceptance/default-stack/config.mjs";
import { hostEnvironment } from "../../acceptance/default-stack/env.mjs";
import { seededEpoch } from "../../acceptance/maintenance/preconditions";
import { openPlatformDb } from "@/lib/controlplane/db";
import type { PlatformDb } from "@/lib/controlplane/types";
import type { OperationDetail } from "@/lib/capabilities/operations";
import type { OperationProjection } from "@/lib/controlplane/authority";
import { defaultExec, classifyVitest } from "../acceptance-orchestrator";

export type Detail = OperationStatusView;
export interface Deployment {
  metadata: { uid: string; generation: number; annotations: Record<string, string>; labels: Record<string, string> };
  spec: { replicas: number; template: { metadata: { annotations?: Record<string, string> }; spec: { containers: { image: string; env?: { name: string; value?: string }[] }[] } } };
}
type JourneyConfig = ReturnType<typeof Config.parse>;
type Stack = Awaited<ReturnType<typeof prerequisites>>;

export class OperatedSession {
  readonly faults = new OwnedCleanup();
  readonly cleanup = new OwnedCleanup();
  readonly users: string[] = [];
  readonly witnessNonce = nonce();
  readonly readbacks: Record<string, string> = {};
  config!: JourneyConfig;
  stack!: Stack;
  a!: Page;
  b!: Page;
  browser?: Browser;
  workspaceId = "";
  environmentId = "";
  project?: { id: string; slug: string; name: string };
  linked?: { token: string; credentialId: string };
  private targetId?: string;
  private stackCleanup?: () => Promise<void>;

  async prepare(env: NodeJS.ProcessEnv, binding: ReturnType<typeof sourceBinding>): Promise<void> {
    this.config = Config.parse(JSON.parse(privateFile(env.ZENITH_LOCAL_JOURNEY_CONFIG_FILE)));
    ensure(fs.realpathSync(this.config.stackDirectory) === fs.realpathSync(env.ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR!), "stack-config-binding");
    const ownedStack = readState(this.config.stackDirectory);
    ensure(ownedStack.profile === "lean", "owned-lean-stack");
    this.stackCleanup = async () => { await cleanupStack(ownedStack); };
    const targetDirectory = path.dirname(fs.realpathSync(env.ZENITH_LOCAL_JOURNEY_CONFIG_FILE!));
    ensure([this.config.kind.observerKubeconfigFile, this.config.kind.kubeconfigFile, this.config.kind.rotationKubeconfigFile].every(file => path.dirname(fs.realpathSync(file)) === targetDirectory), "owned-config-directory");
    const targets = JSON.parse(privateFile(path.join(targetDirectory, "targets.json"))) as { kind?: string; createdBy?: string; status?: string; containerId?: string };
    ensure(targets.kind === "zenith-j2" && targets.createdBy === "J2-DEFAULT-JOURNEY" && targets.status === "created" && /^[a-f0-9]{64}$/.test(targets.containerId ?? ""), "owned-kind-receipt");
    const [node] = JSON.parse(await command("docker", ["inspect", "zenith-j2-control-plane"])) as { Id: string; Config: { Labels: Record<string, string> } }[];
    ensure(node.Id === targets.containerId && node.Config.Labels["io.x-k8s.kind.cluster"] === "zenith-j2", "owned-kind-identity");
    this.targetId = node.Id;
    // This invocation takes responsibility for the fresh prepared J2 fixture. J1 is borrowed.
    this.cleanup.add(async () => {
      const clusters = await command("kind", ["get", "clusters"]);
      if (clusters.split(/\s+/).includes("zenith-j2")) {
        const [current] = JSON.parse(await command("docker", ["inspect", "zenith-j2-control-plane"])) as { Id: string; Config: { Labels: Record<string, string> } }[];
        ensure(current.Id === this.targetId && current.Config.Labels["io.x-k8s.kind.cluster"] === "zenith-j2", "cleanup-kind-identity");
        await command("kind", ["delete", "cluster", "--name", "zenith-j2"], { timeout: 120_000 });
      }
      ensure(!(await command("kind", ["get", "clusters"])).split(/\s+/).includes("zenith-j2"), "cleanup-kind-absence");
      const credentials = new OwnedCleanup();
      for (const name of ["observer.json", "deployer-old.json", "deployer-new.json", "kind-bootstrap.yaml"]) credentials.add(async () => {
        const file = path.join(targetDirectory, name);
        if (fs.existsSync(file)) { privateFile(file); fs.unlinkSync(file); }
      });
      await credentials.run();
    });
    const deployer = kubeconfig(this.config.kind.kubeconfigFile, this.config);
    const observer = observerBinding(yamlLoad(privateFile(this.config.kind.observerKubeconfigFile)), deployer.caData);
    const actual = observerBinding(yamlLoad(await command("kind", ["get", "kubeconfig", "--name", "zenith-j2"])), deployer.caData);
    ensure(observer === actual, "observer-exact-owned-cluster");
    this.stack = await prerequisites(this.config, { commit: binding.head, sourceDigest: binding.contentSha256, dirty: binding.dirty });
    const ready = await this.stack.modules.compose(this.stack.state, ["ps", "-q", "execution-worker"]);
    ensure(ready.trim() === this.stack.worker, "owned-worker");
    // A prepared target must be fresh; never run faults against another journey's workload.
    const objects = JSON.parse(await this.kubectl(["get", "deployments", "-o", "json"])) as { items: unknown[] };
    ensure(objects.items.length === 0, "fresh-kind-workload");
    kubeconfig(this.config.kind.kubeconfigFile, this.config);
    this.browser = await chromium.launch({ headless: true });
    this.a = await (await this.browser.newContext({ ignoreHTTPSErrors: false })).newPage();
    this.b = await (await this.browser.newContext({ ignoreHTTPSErrors: false })).newPage();
    // Register user/link cleanup before the first partially successful creation.
    this.cleanup.add(async () => {
      if (this.linked) ok(await browserRequest(this.a, "/api/integrations/agent/link/revoke", { credentialId: this.linked.credentialId }));
    });
    this.cleanup.add(async () => {
      const tasks = new OwnedCleanup();
      for (const id of this.users) tasks.add(async () => {
        ok(await jsonRequest(this.stack.supabaseUrl + "/auth/v1/admin/users/" + id, { method: "DELETE", headers: adminHeaders(this.stack) }));
        const absent = await jsonRequest(this.stack.supabaseUrl + "/auth/v1/admin/users/" + id, { headers: adminHeaders(this.stack) });
        ensure(absent.status === 404, "cleanup-auth-absence");
      });
      await tasks.run();
    });
    const operatorA = await operator(this.stack, this.config.mailpitUrl, "a", this.users);
    const operatorB = await operator(this.stack, this.config.mailpitUrl, "b", this.users);
    // Fresh operators have no workspace yet, so /api/bootstrap is a 404 by design; sign in as J2 does.
    await authenticateBeforeWorkspace(this.a, this.stack, operatorA); await authenticateBeforeWorkspace(this.b, this.stack, operatorB);
    await enrollOperator(this.a, this.stack); await enrollOperator(this.b, this.stack);
    const workspace = ok(await browserRequest(this.a, "/api/workspace", { name: "Zenith DRV2 " + nonce() })).workspace as { id: string };
    this.workspaceId = workspace.id;
    const invite = ok(await browserRequest(this.a, "/api/workspace/invites", { email: operatorB.email, role: "admin", workspaceId: workspace.id })).invite as { id: string };
    const accepted = ok(await browserRequest(this.b, "/api/workspace/invites/" + invite.id + "/accept", {}));
    ensure(accepted.member?.id === operatorB.id && accepted.member?.role === "admin", "independent-member");
  }

  async deploy(): Promise<void> {
    const name = "DRV2 witness " + nonce();
    const created = await action(this.a, "project.create", { name, withEnvironment: false });
    this.project = { id: created.projectId, slug: created.slug, name };
    const manifest = { version: 2, placement: { provider: "kubernetes", regions: ["in-cluster"] },
      providerConfig: { kubernetes: { namespace: this.config.kind.namespace } },
      services: [{ id: "witness", name: "witness", kind: "web", source: { type: "image", image: this.config.kind.image },
        size: "small", replicas: 1, port: 8080, healthPath: "/", ownership: "managed", env: [{ key: "WITNESS_NONCE", value: this.witnessNonce }] }],
      resources: [], routes: [], bindings: [] };
    await action(this.a, "project.updateManifest", { projectId: this.project.id, manifest });
    await action(this.a, "system.setSecret", { projectId: this.project.id, serviceId: "witness", key: "DRV2_KUBE", secretRef: "vault:DRV2_KUBE", secretValue: privateFile(this.config.kind.kubeconfigFile) });
    await action(this.a, "project.updateManifest", { projectId: this.project.id, manifest });
    const target = kubeconfig(this.config.kind.kubeconfigFile, this.config);
    const connection = await action(this.a, "connection.createKubernetes", { label: name, server: this.config.kind.server,
      caData: target.caData, namespaces: [this.config.kind.namespace], credentialRef: "vault:DRV2_KUBE", scopedGuest: false });
    const verified = ok(await browserRequest(this.a, "/api/platform/v1/connections/" + connection.connectionId + "/verify", {}, "POST", this.workspaceId));
    ensure(verified.ok === true, "connection-verified");
    const environment = await action(this.a, "env.create", { projectId: this.project.id, name: "production", class: "production", connectionId: connection.connectionId, approvalRequired: true });
    this.environmentId = environment.environmentId;
    this.linked = await linkedAgent(this.a, this.stack, this.project, this.workspaceId);
    await this.a.goto(this.stack.apiUrl + "/p/" + this.project.slug + "/system?env=" + this.environmentId);
    await this.a.getByRole("button", { name: /pending change.*Review/ }).click();
    await this.a.getByLabel("Type production to confirm deploying to production", { exact: true }).fill("production");
    const response = this.a.waitForResponse(value => value.url().endsWith("/api/actions/deploy.apply") && value.request().method() === "POST");
    await this.a.getByRole("button", { name: "Request approval for production", exact: true }).click();
    const answer = await (await response).json();
    ensure(answer.result?.ok && answer.result.data.operationId && answer.result.data.deploymentId, "browser-deploy-proposal");
    const { operationId, deploymentId } = answer.result.data as { operationId: string; deploymentId: string };
    await this.approve(operationId);
    await action(this.b, "deploy.approve", { deploymentId }, { projectId: this.project.id, environmentId: this.environmentId });
    await until(() => this.detail(operationId), value => value.operation.status === "awaiting_approval" && (value.operation.approvalRound ?? 0) > 0);
    await this.approve(operationId);
    await this.terminal(operationId);
    this.readbacks.baseline = await this.readback(1);
  }
  async detail(id: string): Promise<Detail> { return ok(await browserRequest(this.a, "/api/platform/v1/operations/" + id, undefined, "GET", this.workspaceId)); }
  async approve(id: string): Promise<void> {
    const before = await this.detail(id);
    ensure(before.operation.status === "awaiting_approval" && before.decision?.approval?.separationOfDuties === true, "approval-required");
    const body = { proposalDigest: before.operation.proposalDigest, ...(before.operation.planDigest ? { planDigest: before.operation.planDigest } : {}), ...(before.planReview?.semantics?.digest ? { semanticsDigest: before.planReview.semantics.digest } : {}) };
    const self = await browserRequest(this.a, "/api/platform/v1/operations/" + id + "/approve", body, "POST", this.workspaceId);
    ensure(self.status === 403 && self.data.error?.code === "separation_of_duties", "self-approval-refused");
    await this.b.goto(this.stack.apiUrl + "/platform/operations/" + id);
    const response = this.b.waitForResponse(value => value.url().endsWith("/operations/" + id + "/approve") && value.request().method() === "POST");
    await this.b.getByRole("button", { name: /^Approve / }).click();
    const approvedResponse = await response;
    ensure(approvedResponse.ok() && (await approvedResponse.json()).operation?.status === "approved", "browser-approval");
    const after = await this.detail(id);
    ensure(after.operation.proposalDigest === before.operation.proposalDigest && after.approvals.some(value => value.approverId === this.users[1] && value.decision === "approve"), "independent-approved-digest");
  }
  async propose(replicas: number, surface: "rest" | "mcp" = "mcp"): Promise<string> {
    ensure(this.project && this.linked, "deployed-scope");
    if (surface === "rest") {
      const options = { method: "POST",
        headers: { authorization: "Bearer " + this.linked!.token, "x-zenith-workspace": this.workspaceId },
        body: { capability: "service.scale", scope: { workspaceId: this.workspaceId, projectId: this.project!.id, environmentId: this.environmentId, resourceId: "witness" },
          input: { operation: "scale", serviceId: "witness", replicas }, idempotencyKey: nonce() } };
      const result = ok(await jsonRequest(this.stack.apiUrl + "/api/platform/v1/capabilities/propose", options));
      ensure(result.operation?.status === "awaiting_approval", "rest-proposal-gated");
      return result.operation.id as string;
    }
    const result = await mcp(this.stack, this.linked!.token, "tools/call", { name: "zenith_scale_service",
      arguments: { target: { workspaceId: this.workspaceId, projectId: this.project!.id, environmentId: this.environmentId }, serviceId: "witness", replicas, idempotencyKey: nonce() } });
    ensure(result.data.status === "awaiting_approval" && result.data.executed === false, "mcp-proposal-gated");
    return result.data.operationId as string;
  }
  async execute(id: string): Promise<string> {
    const detail = await this.detail(id);
    const result = await mcp(this.stack, this.linked!.token, "tools/call", { name: "zenith_execute_approved_operation",
      arguments: { workspaceId: this.workspaceId, operationId: id, expectedDigest: detail.operation.proposalDigest } });
    ensure(result.data.workflow?.id, "durable-workflow");
    return result.data.workflow.id as string;
  }
  async terminal(id: string): Promise<Detail> {
    const result = await until(() => this.detail(id), value => ["succeeded", "failed", "denied", "uncertain", "cancelled", "expired"].includes(value.operation.status), 300_000);
    ensure(result.operation.status === "succeeded", "terminal-success-required");
    return result;
  }
  kubectl(args: string[]): Promise<string> { return command("kubectl", ["--kubeconfig", this.config.kind.observerKubeconfigFile, "--context", this.config.kind.context, "-n", this.config.kind.namespace, ...args]); }
  async deployment(): Promise<Deployment> {
    const object = JSON.parse(await this.kubectl(["get", "deployment", "witness", "-o", "json"])) as Deployment;
    ensure(object.metadata.labels["app.kubernetes.io/managed-by"] === "zenith" && object.metadata.annotations["zenith.dev/environment"] === this.environmentId && object.metadata.annotations["zenith.dev/resource"] === "service/witness", "owned-workload");
    ensure(object.spec.template.spec.containers[0].env?.some(value => value.name === "WITNESS_NONCE" && value.value === this.witnessNonce), "owned-workload-nonce");
    return object;
  }
  async readback(replicas: number): Promise<string> { await this.deployment(); return kindReadback(this.config, replicas, this.witnessNonce); }
  async finish(): Promise<void> {
    let failed = false;
    try { await this.faults.run(); } catch { failed = true; }
    // Drain the real worker before removing its provider target. Keep browser/API alive for revocation.
    if (this.stack) {
      try { await this.stack.modules.compose(this.stack.state, ["stop", "--timeout", "660", "execution-worker"]); }
      catch { failed = true; }
    }
    // Browser credentials remain alive until link/project/user cleanup finishes.
    try { await this.cleanup.run(); } catch { failed = true; }
    try { await this.browser?.close(); } catch { failed = true; }
    // The explicit DRV-2 gate transfers the disposable J1 stack to this run.
    // Its existing labelled cleanup also removes all local product/audit data.
    try { await this.stackCleanup?.(); } catch { failed = true; }
    if (failed) throw new Error("Owned operated cleanup incomplete");
  }
}

export type DriverStep = (id: string, work: () => Promise<void>) => Promise<void>;
async function runDriftCrashOperated(input: { scenarioId: DriverScenario; receiptFile: string; env: NodeJS.ProcessEnv }, work: (session: OperatedSession, step: DriverStep) => Promise<void>): Promise<number> {
  if (driverPlan(input.scenarioId, input.env).missing.length) return 2;
  const { runId } = localPaths(input.env);
  ensure(nativeHost() && process.versions.node.startsWith("22."), "native-host-node22");
  const parent = fs.realpathSync(path.dirname(input.receiptFile));
  ensure(path.isAbsolute(input.receiptFile) && !fs.existsSync(input.receiptFile) && parent === path.dirname(input.receiptFile) && !parent.startsWith(path.resolve(process.cwd()) + path.sep) && parent !== process.cwd() && (fs.statSync(parent).mode & 0o077) === 0, "private-fresh-receipt");
  const binding = sourceBinding();
  // Existing J2 subprocess helpers read process.env. Contain them to the same closed local environment.
  const previousEnvironment = process.env;
  process.env = localEnvironment(input.env);
  const abort = new AbortController();
  const interrupted = () => abort.abort();
  process.on("SIGINT", interrupted); process.on("SIGTERM", interrupted);
  const session = new OperatedSession();
  const facts: { id: string; status: "passed" | "failed" | "skipped" }[] = [];
  const step: DriverStep = async (id, operation) => {
    ensure((DRIVER_CHECKS[input.scenarioId] as readonly string[]).includes(id) && !facts.some(fact => fact.id === id), "owned-step-inventory");
    try {
      if (id !== "cleanup") abort.signal.throwIfAborted();
      await operation();
      if (id !== "cleanup") abort.signal.throwIfAborted();
      facts.push({ id, status: "passed" });
    }
    catch (error) {
      facts.push({ id, status: "failed" });
      // Opt-in diagnosis for disposable CI: only a fixed-vocabulary code (no free text, values or paths) reaches stderr.
      const code = error instanceof Error ? error.message : "";
      if (input.env.ZENITH_OPERATED_DIAGNOSTICS === "1") process.stderr.write(`operated step ${id} failed: ${/^[a-z0-9:._-]{1,80}$/.test(code) ? code : "unclassified " + (error instanceof Error && /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : "value")}\n`);
      throw new Error("Operated step failed");
    }
  };
  try { await step("prerequisites", async () => { await assertLocalDocker(process.env); await session.prepare(process.env, binding); }); await step("approved-workload", () => session.deploy()); await work(session, step); }
  catch { /* Only fixed vocabulary escapes; remaining checks become skipped. */ }
  finally {
    try { await step("cleanup", () => session.finish()); } catch { /* All registered cleanup has been attempted. */ }
    process.off("SIGINT", interrupted); process.off("SIGTERM", interrupted);
    process.env = previousEnvironment;
    if (JSON.stringify(sourceBinding()) !== JSON.stringify(binding)) {
      const prerequisite = facts.find(fact => fact.id === "prerequisites");
      if (prerequisite) prerequisite.status = "failed";
    }
  }
  const receipt = operatedReceipt({ scenarioId: input.scenarioId, runId, sourceCommit: binding.head, sourceDigest: binding.contentSha256, dirty: binding.dirty, checks: facts, readbacks: session.readbacks });
  fs.writeFileSync(input.receiptFile, JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  return receipt.checks.some(check => check.status === "failed") ? 1 : receipt.checks.some(check => check.status !== "passed") ? 3 : 0;
}
/** Preserve the J2 polling implementation while supplying its generic TypeScript contract. */
export function until<T>(read: () => Promise<T>, predicate: (value: T) => boolean, timeout = 180_000): Promise<T> { return journeyUntil(read, predicate, timeout); }
export { command, ensure, sha256 };

// J2's JS helper accepts JSON bodies; its inferred default-argument declaration
// omits that optional field. Preserve the actual helper contract explicitly.
const productRequest = jsonRequest as (url: string, options?: { method?: string; body?: unknown; headers?: Record<string, string> }) => Promise<{ status: number; data: unknown }>;
// GET /api/platform/v1/operations/:id returns the broker's OperationDetail.
// Keep its optional review/round metadata; missing metadata cannot admit approval.
type OperationStatusView = OperationDetail & { authority?: OperationProjection };

export type OperatedScenario = "upgrade" | "restore";
export interface DriverInput { scenarioId: OperatedScenario | TenantExportScenario; runId: string; sourceCommit: string; receiptFile: string; env: NodeJS.ProcessEnv }

/** Always attempt every owned cleanup in dependency order, preserving failure. */
export async function finishOwned(actions: readonly (() => Promise<void>)[]): Promise<void> {
  const failures: unknown[] = [];
  for (const action of actions) { try { await action(); } catch (error) { failures.push(error); } }
  if (failures.length) throw new Error("operated:owned-cleanup-failed");
}
export function assertOperatedGate(input: DriverInput): void {
  if (input.scenarioId !== "upgrade" && input.scenarioId !== "restore") throw new Error("operated:scenario-binding");
  localPaths(input.env);
  if (input.env.ZENITH_LOCAL_OPERATED !== "1" || input.env.ZENITH_LOCAL_JOINED_DRIVERS !== "1"
    || input.env.ZENITH_ACCEPTANCE_DEFAULT_STACK !== "1" || input.env.ZENITH_DEFAULT_JOURNEY !== "1") throw new Error("operated:explicit-gates-required");
  if (input.runId !== input.env.ZENITH_LOCAL_RUN_ID || !/^[a-f0-9]{40}$/.test(input.sourceCommit)
    || !path.isAbsolute(input.receiptFile) || existsSync(input.receiptFile)) throw new Error("operated:input-binding");
}
function upgradeRestoreReceiptFor(input: DriverInput, checks: LocalReceipt["checks"]): LocalReceipt {
  const receipt: LocalReceipt = { schema: 1, scenarioId: input.scenarioId, runId: input.runId, sourceCommit: input.sourceCommit,
    evidenceLabel: "local_operated_rehearsal", checks,
    limits: ["Owned local operated rehearsal. No live cloud, production acceptance or release approval.",
      "Lean profile: one API and one worker; pauses are observable, no high availability claim.",
      "J2 kind target and real browser identities; local Kubernetes credentials stay in the tenant vault."] };
  return validateLocalReceipt(receipt, { scenarioId: input.scenarioId as OperatedScenario, runId: input.runId, sourceCommit: input.sourceCommit });
}

export class UpgradeRestoreSession {
  readonly facts: LocalReceipt["checks"] = [];
  private cleanupBlocked = false;
  readonly privateFiles: string[] = [];
  readonly finalizers: (() => Promise<void>)[] = [];
  state!: ReturnType<typeof readState>;
  prepared!: ReturnType<typeof readPrepared>;
  config!: z.infer<typeof Config>;
  stack!: Awaited<ReturnType<typeof prerequisites>>;
  browser?: Browser;
  a!: Page; b!: Page;
  db!: PlatformDb;
  environment!: NodeJS.ProcessEnv;
  workspaceId!: string;
  project!: { id: string; slug: string; name: string; connectionId?: string };
  environmentId!: string;
  linked!: Awaited<ReturnType<typeof linkedAgent>>;
  readonly marker = nonce();
  activeState!: ReturnType<typeof readState>;
  constructor(readonly input: DriverInput) {}
  async step(id: string, work: () => Promise<void>): Promise<void> {
    try { await work(); this.facts.push({ id, status: "passed" }); }
    catch {
      if (id === "operator-cli-route" || id === "fresh-restore") this.cleanupBlocked = true;
      this.facts.push({ id, status: "failed" }); throw new Error("operated:" + id);
    }
  }
  privateJson(name: string, value: unknown): string {
    const file = path.join(this.input.env.ZENITH_LOCAL_ROOT!, `${this.input.scenarioId}-${name}.json`);
    writeFileSync(file, JSON.stringify(value), { flag: "wx", mode: 0o600 }); this.privateFiles.push(file); return file;
  }
  async prepare(): Promise<void> {
    ensure(nativeHost() && process.versions.node.startsWith("22."), "native-host-node22");
    await assertLocalDocker(this.input.env);
    const root = this.input.env.ZENITH_LOCAL_ROOT!;
    ensure(lstatSync(root).isDirectory() && !lstatSync(root).isSymbolicLink() && (lstatSync(root).mode & 0o077) === 0, "private-scratch");
    const file = this.input.env.ZENITH_LOCAL_JOURNEY_CONFIG_FILE;
    ensure(file && path.isAbsolute(file), "journey-config");
    this.config = Config.parse(JSON.parse(privateFile(file!)));
    ensure(this.config.stackDirectory === this.input.env.ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR, "stack-config-binding");
    this.state = readState(this.config.stackDirectory);
    this.activeState = this.state;
    ensure(this.state.profile === "lean" && this.state.source.head === this.input.sourceCommit, "lean-source-binding");
    this.finalizers.push(async () => {
      const result = await cleanupStack(this.state);
      ensure(result.ownedResourcesRemaining === 0, "j1-absence");
    });
    const targetFile = path.join(path.dirname(file!), "targets.json");
    const targets = JSON.parse(privateFile(targetFile));
    const [node] = JSON.parse(await docker(["inspect", "zenith-j2-control-plane"]));
    ensure(targets.schemaVersion === 1 && targets.createdBy === "J2-DEFAULT-JOURNEY" && targets.status === "created"
      && targets.kind === "zenith-j2" && targets.containerId === node.Id && node.Config.Labels?.["io.x-k8s.kind.cluster"] === "zenith-j2", "owned-j2-target");
    // Ownership is admitted before readiness/setup can fail. This invocation takes
    // custody of the fresh J1/J2 fixtures, including on every later failure.
    this.finalizers.unshift(async () => {
      const [current] = JSON.parse(await docker(["inspect", "zenith-j2-control-plane"]));
      ensure(current.Id === targets.containerId && current.Config.Labels?.["io.x-k8s.kind.cluster"] === "zenith-j2", "cleanup-kind-owner");
      await this.exec(["kind", "delete", "cluster", "--name", "zenith-j2"]);
      ensure(!(await this.exec(["kind", "get", "clusters"])).split(/\s+/).includes("zenith-j2"), "kind-absence");
    });
    this.prepared = readPrepared(path.join(this.state.directory, "installation"));
    this.environment = { ...this.input.env, ...hostEnvironment(this.state) };
    this.stack = await prerequisites(this.config, { commit: this.state.source.head, sourceDigest: this.state.source.contentSha256, dirty: this.state.source.dirty });
    const direct = new URL(this.prepared.environment.ZENITH_PLATFORM_MIGRATION_URL);
    ensure(direct.hostname === "supabase-db" && direct.port === "5432" && direct.pathname === "/postgres", "j1-direct-database");
    direct.hostname = "127.0.0.1"; direct.port = String(ports.db);
    this.environment.ZENITH_PLATFORM_DB_URL = direct.href;
    this.db = await openPlatformDb({ kind: "postgres", url: direct.href, max: 2, migrate: false });
    await seededEpoch(this.db); // J4's actual migration-seeded epoch, no repair.
    const counts = await this.db.query<{ n: number }>("select count(*)::int as n from platform.provider_connections");
    ensure(counts[0].n === 0, "fresh-driver-stack");
    kubeconfig(this.config.kind.kubeconfigFile, this.config);
    this.browser = await chromium.launch({ headless: true });
    this.a = await (await this.browser.newContext()).newPage(); this.b = await (await this.browser.newContext()).newPage();
    const users: string[] = [];
    const userA = await operator(this.stack, this.config.mailpitUrl, "a", users);
    const userB = await operator(this.stack, this.config.mailpitUrl, "b", users);
    await authenticateBeforeWorkspace(this.a, this.stack, userA); await authenticateBeforeWorkspace(this.b, this.stack, userB);
    await enrollOperator(this.a, this.stack); await enrollOperator(this.b, this.stack);
    this.workspaceId = ok(await browserRequest(this.a, "/api/workspace", { name: `DRV3 ${this.input.runId}` })).workspace.id;
    const invite = ok(await browserRequest(this.a, "/api/workspace/invites", { email: userB.email, role: "admin", workspaceId: this.workspaceId })).invite;
    ensure(ok(await browserRequest(this.b, `/api/workspace/invites/${invite.id}/accept`, {})).member.id === userB.id, "independent-admin");
    const name = `DRV3 witness ${this.input.runId}`;
    const project = await action(this.a, "project.create", { name, withEnvironment: false });
    this.project = { id: project.projectId, slug: project.slug, name };
    const manifest = { version: 2, placement: { provider: "kubernetes", regions: ["in-cluster"] },
      providerConfig: { kubernetes: { namespace: this.config.kind.namespace } }, services: [{ id: "witness", name: "witness", kind: "web",
        source: { type: "image", image: this.config.kind.image }, size: "small", replicas: 1, port: 8080, healthPath: "/", ownership: "managed",
        env: [{ key: "WITNESS_NONCE", value: this.marker }] }], resources: [], routes: [], bindings: [] };
    await action(this.a, "project.updateManifest", { projectId: this.project.id, manifest });
    await action(this.a, "system.setSecret", { projectId: this.project.id, serviceId: "witness", key: "DRV3_KUBE", secretRef: "vault:DRV3_KUBE", secretValue: privateFile(this.config.kind.kubeconfigFile) });
    await action(this.a, "project.updateManifest", { projectId: this.project.id, manifest });
    this.project.connectionId = (await action(this.a, "connection.createKubernetes", { label: `DRV3 ${this.input.runId}`, server: this.config.kind.server,
      caData: kubeconfig(this.config.kind.kubeconfigFile, this.config).caData, namespaces: [this.config.kind.namespace], credentialRef: "vault:DRV3_KUBE", scopedGuest: false })).connectionId;
    await this.a.goto(this.stack.apiUrl + "/platform/connections");
    const card = this.a.getByRole("listitem").filter({ hasText: `DRV3 ${this.input.runId}` });
    const verified = this.a.waitForResponse(r => r.url().endsWith(`/connections/${this.project.connectionId}/verify`) && r.request().method() === "POST");
    await card.getByRole("button", { name: "Verify", exact: true }).click(); ensure((await verified).ok(), "connection-verify");
    this.environmentId = (await action(this.a, "env.create", { projectId: this.project.id, name: "production", class: "production", connectionId: this.project.connectionId, approvalRequired: true })).environmentId;
    this.linked = await linkedAgent(this.a, this.stack, this.project, this.workspaceId);
  }
  async exec(argv: readonly string[]): Promise<string> {
    const result = await defaultExec(argv, { cwd: process.cwd(), env: this.environment ?? this.input.env, timeoutMs: 1_080_000 });
    ensure(result.code === 0, "owned-command"); return result.stdout;
  }
  async gates(files: readonly string[], env: Partial<NodeJS.ProcessEnv> = {}): Promise<void> {
    const report = path.join(this.input.env.ZENITH_LOCAL_ROOT!, `${this.input.scenarioId}-gates.json`);
    ensure(!existsSync(report), "fresh-gate-report"); this.privateFiles.push(report);
    const run = await defaultExec([process.execPath, "node_modules/vitest/vitest.mjs", "run", ...files, "--project=node", "--no-file-parallelism", "--maxWorkers=2", "--reporter=json", `--outputFile=${report}`],
      { cwd: process.cwd(), env: { ...this.environment, ...env }, timeoutMs: 1_080_000 });
    ensure(classifyVitest(run.code, JSON.parse(readFileSync(report, "utf8"))).status === "passed", "strict-gate-result");
  }
  async detail(id: string): Promise<OperationStatusView> { return ok(await browserRequest(this.a, `/api/platform/v1/operations/${id}`, undefined, "GET", this.workspaceId)); }
  async approve(id: string): Promise<void> {
    const detail = await this.detail(id);
    ensure(detail.operation.status === "awaiting_approval" && detail.decision?.approval?.separationOfDuties === true, "human-review-required");
    await this.b.goto(this.stack.apiUrl + `/platform/operations/${id}`);
    const response = this.b.waitForResponse(r => r.url().endsWith(`/operations/${id}/approve`) && r.request().method() === "POST");
    await this.b.getByRole("button", { name: /^Approve / }).click();
    ensure((await response).ok(), "browser-approval");
    ensure((await this.detail(id)).approvals.some((v: { decision: string }) => v.decision === "approve"), "approval-readback");
  }
  async deployReview(): Promise<{ operationId: string; deploymentId: string }> {
    await this.a.goto(this.stack.apiUrl + `/p/${this.project.slug}/system?env=${this.environmentId}`);
    await this.a.getByRole("button", { name: /pending change.*Review/ }).click();
    await this.a.getByLabel("Type production to confirm deploying to production", { exact: true }).fill("production");
    const response = this.a.waitForResponse(r => r.url().endsWith("/api/actions/deploy.apply") && r.request().method() === "POST");
    await this.a.getByRole("button", { name: "Request approval for production", exact: true }).click();
    const answer = await (await response).json();
    ensure(answer.result?.ok && answer.result.data.operationId, "browser-deploy");
    const result = answer.result.data;
    await this.approve(result.operationId);
    await action(this.b, "deploy.approve", { deploymentId: result.deploymentId }, { projectId: this.project.id, environmentId: this.environmentId });
    const review = await until(() => this.detail(result.operationId), (v: OperationStatusView) => v.operation.status === "awaiting_approval" && (v.operation.approvalRound ?? 0) > 0);
    ensure(review.operation.planDigest && review.planReview?.semantics?.digest, "immutable-plan-review");
    return result;
  }
  async completeDeploy(id: string): Promise<void> {
    await this.approve(id);
    const terminal = await until(() => this.detail(id), (v: OperationStatusView) => ["succeeded", "failed", "uncertain"].includes(v.operation.status));
    ensure(terminal.operation.status === "succeeded", "deployment-terminal");
    await kindReadback(this.config, 1, this.marker);
  }
  async proposeScale(replicas: number): Promise<string> {
    const proposed = ok(await productRequest(this.stack.apiUrl + "/api/platform/v1/capabilities/propose", { method: "POST",
      headers: { authorization: "Bearer " + this.linked.token, "x-zenith-workspace": this.workspaceId },
      body: { capability: "service.scale", scope: { workspaceId: this.workspaceId, projectId: this.project.id, environmentId: this.environmentId, resourceId: "witness" },
        input: { operation: "scale", serviceId: "witness", replicas }, idempotencyKey: nonce() } }));
    ensure(proposed.operation.status === "awaiting_approval", "rest-approval-gate"); return proposed.operation.id;
  }
  async execute(id: string, allowError = false) {
    return mcp(this.stack, this.linked.token, "tools/call", { name: "zenith_execute_approved_operation",
      arguments: { workspaceId: this.workspaceId, operationId: id, expectedDigest: (await this.detail(id)).operation.proposalDigest } }, allowError);
  }
  async scaleComplete(id: string, replicas: number): Promise<void> {
    await this.execute(id);
    const terminal = await until(() => this.detail(id), (v: OperationStatusView) => ["succeeded", "failed", "uncertain"].includes(v.operation.status));
    ensure(terminal.operation.status === "succeeded", "scale-terminal"); await kindReadback(this.config, replicas, this.marker);
  }
  async replacement(images?: { api: string; worker: string; migration: string }, database?: string): Promise<ReturnType<typeof readState>> {
    const text = privateFile(path.join(this.state.directory, "installation/stack.compose.json"));
    // privateFile trims its return; hash the exact raw file instead.
    ensure(createHash("sha256").update(readFileSync(path.join(this.state.directory, "installation/stack.compose.json"))).digest("hex") === this.activeState.compositionSha256, "composition-drift");
    const document = JSON.parse(text);
    for (const [service, image] of [["api", images?.api], ["execution-worker", images?.worker], ["platform-migrate", images?.migration]]) {
      if (image) document.services[service!].image = image;
      if (database) {
        const pooled = new URL(this.prepared.environment.SUPABASE_DB_URL); pooled.pathname = `/${database}`;
        const direct = new URL(this.prepared.environment.ZENITH_PLATFORM_MIGRATION_URL); direct.pathname = `/${database}`;
        Object.assign(document.services[service!].environment, { SUPABASE_DB_URL: pooled.href, ZENITH_PLATFORM_DB_URL: service === "platform-migrate" ? direct.href : pooled.href,
          ...(service === "platform-migrate" ? { ZENITH_PLATFORM_MIGRATION_URL: direct.href } : {}), ZENITH_PLATFORM_DB_MAX: "2" });
      }
    }
    // runtime.compose preserves all J1 labels/network/health/limits and verifies
    // this invocation's private composition bytes before each Docker operation.
    const file = path.join(this.state.directory, "installation/stack.compose.json");
    this.privateFiles.push(file); // removed by J1 cleanup, not by file finalizer
    writeFileSync(file, JSON.stringify(document), { mode: 0o600 });
    this.activeState = { ...this.state, compositionSha256: createHash("sha256").update(readFileSync(file)).digest("hex") };
    return this.activeState;
  }
  async healthy(state: ReturnType<typeof readState>, service: string, image?: string): Promise<void> {
    await waitFor(async () => {
      const id = (await compose(state, ["ps", "-q", service])).trim(); if (!id) return false;
      const [item] = JSON.parse(await docker(["inspect", id]));
      return item.Config.Labels?.["io.zenith.installation"] === this.state.applicationInstallationId
        && item.State.Health?.Status === "healthy" && (!image || item.Config.Image === image);
    }, 360_000);
  }
  async finish(): Promise<void> {
    // Keep the entire owned fixture and private evidence for parent settlement after uncertain restore CLI activity.
    if (this.cleanupBlocked) throw new Error("operated:cleanup-retained-for-parent-settlement");
    await finishOwned([
      async () => { if (this.browser) await this.browser.close(); },
      ...this.finalizers,
      async () => { if (this.db) await this.db.close(); },
      async () => { for (const file of this.privateFiles) if (!file.startsWith(this.state?.directory + path.sep) && existsSync(file)) unlinkSync(file); },
    ]);
  }
}

async function upgradeRestoreDriverCli(scenarioId: OperatedScenario, run: (input: DriverInput) => Promise<number>, argv = process.argv.slice(2), env = process.env): Promise<number> {
  // Standalone drivers share the runner's explicit gates. No gate means no I/O.
  if (env.ZENITH_LOCAL_OPERATED !== "1") return 2;
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i], value = argv[i + 1];
    if (!key || !["--run-id", "--source-commit", "--receipt"].includes(key) || !value || key in values) return 2;
    values[key] = value;
  }
  if (!values["--run-id"] || !values["--source-commit"] || !values["--receipt"]) return 2;
  try { return await run({ scenarioId, runId: values["--run-id"], sourceCommit: values["--source-commit"], receiptFile: values["--receipt"], env }); }
  catch { process.stderr.write("Operated driver refused; no evidence accepted.\n"); return 1; }
}

export async function operatedRun(input: DriverInput, work: (session: UpgradeRestoreSession) => Promise<void>): Promise<number> {
  assertOperatedGate(input); // no credentials, engines or files before opt-in
  const session = new UpgradeRestoreSession(input);
  let failed = false;
  try {
    await session.step("preconditions", () => session.prepare());
    await work(session);
    await session.step("source-bound", async () => ensure(JSON.stringify(sourceBinding()) === JSON.stringify(session.state.source), "source-drift"));
  } catch { failed = true; }
  finally {
    try { await session.step("cleanup", () => session.finish()); } catch { failed = true; }
  }
  for (const id of requiredChecks(input.scenarioId)) if (!session.facts.some(c => c.id === id)) session.facts.push({ id, status: "skipped" });
  const receipt = upgradeRestoreReceiptFor(input, session.facts);
  writeFileSync(input.receiptFile, JSON.stringify(receipt, null, 2), { mode: 0o600, flag: "wx" });
  return failed || receipt.checks.some(c => c.status !== "passed") ? 1 : 0;
}

// DRV-1 owns a separate source-bound protocol and borrows its prepared J1/J2 targets.
export type ScenarioId = "private-source" | "update-rollback";
type SourceStack = Awaited<ReturnType<typeof prerequisites>>;
type ConfigValue = ReturnType<typeof Config.parse>;
export const TERMINAL = ["succeeded", "failed", "uncertain", "denied", "rejected", "cancelled", "expired"];
export function enabled(env: Readonly<Record<string, string | undefined>>) {
  return env.ZENITH_LOCAL_DRV1 === "1" && env.ZENITH_LOCAL_TARGETS === "1"
    && env.ZENITH_DEFAULT_JOURNEY === "1" && env.ZENITH_ACCEPTANCE_DEFAULT_STACK === "1";
}
function sourceReceiptFor(id: ScenarioId, source: { head: string; contentSha256: string; dirty: boolean }, runId: string,
  facts: LocalReceipt["checks"], limits: string[]): SourceBoundLocalReceipt {
  const known = requiredChecks(id);
  if (facts.some(f => !known.includes(f.id)) || new Set(facts.map(f => f.id)).size !== facts.length) throw new Error("Invalid operated facts");
  return validateLocalReceipt({ schema: 1, evidenceLabel: OPERATED_LABEL, scenarioId: id, runId,
    sourceCommit: source.head, sourceDigest: source.contentSha256, dirty: source.dirty,
    checks: known.map(check => facts.find(f => f.id === check) ?? { id: check, status: "skipped" }),
    limits }, { scenarioId: id, runId, sourceCommit: source.head }) as SourceBoundLocalReceipt;
}
/** Cleanup is always attempted in authority -> effects -> credentials -> engines order, even after failures. */
export async function cleanupAll(tasks: readonly { id: string; run: () => Promise<void> }[]): Promise<string[]> {
  const failures: string[] = [];
  for (const task of tasks) { try { await task.run(); } catch { failures.push(task.id); } }
  return failures;
}
export interface OwnedObject {
  apiVersion: string; kind: string;
  metadata: { name: string; namespace?: string; uid?: string; annotations?: Record<string, string> };
}
/** Bind the observer to the actual owned container socket/CA, never a remote or exec-auth context. */
export function assertObserver(raw: unknown, target: { caData: string; containerId: string; recordedId: string; ports: { HostIp: string; HostPort: string }[] }) {
  const parsed = raw as { "current-context"?: string; contexts?: { name: string; context?: { cluster?: string; user?: string } }[];
    clusters?: { name: string; cluster?: { server?: string; "certificate-authority-data"?: string; "insecure-skip-tls-verify"?: boolean; "proxy-url"?: string } }[];
    users?: { name: string; user?: Record<string, unknown> }[] };
  ensure(target.containerId === target.recordedId && /^[a-f0-9]{64}$/.test(target.recordedId), "observer-container-identity");
  ensure(parsed?.["current-context"] === "kind-zenith-j2" && Array.isArray(parsed.contexts) && parsed.contexts.length === 1
    && Array.isArray(parsed.clusters) && parsed.clusters.length === 1 && Array.isArray(parsed.users) && parsed.users.length === 1, "observer-single-local-context");
  const context = parsed.contexts![0]!, cluster = parsed.clusters![0]!, user = parsed.users![0]!;
  ensure(context.name === "kind-zenith-j2" && context.context?.cluster === cluster.name && context.context?.user === user.name
    && cluster.cluster?.["certificate-authority-data"] === target.caData && !cluster.cluster?.["insecure-skip-tls-verify"]
    && !cluster.cluster?.["proxy-url"], "observer-context-ca-binding");
  const server = new URL(cluster.cluster!.server!);
  ensure(server.protocol === "https:" && server.hostname === "127.0.0.1" && !server.username && !server.password && !server.search && !server.hash
    && server.pathname === "/" && target.ports.some(port => port.HostIp === "127.0.0.1" && port.HostPort === server.port), "observer-owned-loopback-socket");
  const auth = user.user;
  ensure(auth && Object.keys(auth).sort().join(",") === "client-certificate-data,client-key-data"
    && [auth["client-certificate-data"], auth["client-key-data"]].every(value => typeof value === "string" && /^[A-Za-z0-9+/]+={0,2}$/.test(value)), "observer-static-local-auth");
}
export function cleanupObjects(items: readonly OwnedObject[], environmentId: string, namespace: string) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(environmentId) || namespace !== "zenith-j2") throw new Error("Invalid owned scope");
  const allowed = new Set(["Deployment", "StatefulSet", "CronJob", "Job", "Service", "Ingress", "ConfigMap", "Secret", "PersistentVolumeClaim", "NetworkPolicy"]);
  return items.filter(item => item.metadata?.annotations?.["zenith.dev/environment"] === environmentId).map(item => {
    if (!allowed.has(item.kind) || item.metadata.namespace !== namespace || !/^[a-z0-9][a-z0-9.-]{0,252}$/.test(item.metadata.name)
      || !item.metadata.uid) throw new Error("Owned object inventory refused");
    return item;
  }).sort((a, b) => Number(["Secret", "PersistentVolumeClaim"].includes(a.kind)) - Number(["Secret", "PersistentVolumeClaim"].includes(b.kind)));
}

export class Operated {
  browser?: Browser; a?: Page; b?: Page; stack?: SourceStack; config?: ConfigValue;
  workspaceId = ""; project?: { id: string; slug: string; name: string; connectionId?: string };
  environmentId = ""; users: string[] = []; operations: string[] = []; linked?: Awaited<ReturnType<typeof linkedAgent>>;
  deployments: string[] = []; cleaners: { id: string; run: () => Promise<void> }[] = [];
  recoveries: { id: string; run: () => Promise<void> }[] = [];
  constructor(readonly scenario: ScenarioId, readonly env: NodeJS.ProcessEnv, readonly scratch: string) {}
  async start(source: ReturnType<typeof sourceBinding>) {
    const configFile = this.env.ZENITH_LOCAL_JOURNEY_CONFIG_FILE;
    ensure(configFile && path.isAbsolute(configFile), "private-j2-config");
    this.config = Config.parse(JSON.parse(privateFile(configFile)));
    ensure(this.config.stackDirectory === this.env.ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR, "j1-directory-join");
    await assertLocalDocker(this.env);
    this.stack = await prerequisites(this.config, { commit: source.head, sourceDigest: source.contentSha256, dirty: source.dirty });
    const target = kubeconfig(this.config.kind.kubeconfigFile, this.config);
    const targets = JSON.parse(privateFile(path.join(path.dirname(configFile!), "targets.json")));
    const [kindNode] = JSON.parse(await this.stack.modules.docker(["inspect", "zenith-j2-control-plane"]));
    ensure(targets.kind === "zenith-j2" && targets.createdBy === "J2-DEFAULT-JOURNEY" && targets.status === "created", "j2-target-journal");
    assertObserver(yamlLoad(privateFile(this.config.kind.observerKubeconfigFile)), { caData: target.caData, containerId: kindNode.Id,
      recordedId: targets.containerId, ports: kindNode.NetworkSettings.Ports["6443/tcp"] ?? [] });
    Object.assign(this.env, hostEnvironment(this.stack.state));
    // DNS/TLS trust remains the actual J1 CA. No browser certificate bypass.
    this.browser = await (await import("@playwright/test")).chromium.launch({ headless: true });
    this.a = await (await this.browser.newContext()).newPage(); this.b = await (await this.browser.newContext()).newPage();
    // Refuse browser navigation/fetch to any real provider. Private-source adds a LOCAL provider emulator route.
    const origins = new Set([this.stack.apiUrl, this.stack.supabaseUrl]);
    for (const page of [this.a, this.b]) await page.route("**/*", route => {
      const url = new URL(route.request().url());
      return origins.has(url.origin) ? route.continue() : route.abort();
    });
    const userA = await operator(this.stack, this.config.mailpitUrl, "drv1-a", this.users);
    const userB = await operator(this.stack, this.config.mailpitUrl, "drv1-b", this.users);
    await authenticateBeforeWorkspace(this.a, this.stack, userA); await authenticateBeforeWorkspace(this.b, this.stack, userB);
    await enrollOperator(this.a, this.stack); await enrollOperator(this.b, this.stack);
    const workspace = ok(await browserRequest(this.a, "/api/workspace", { name: "DRV-1 " + this.scenario + " " + nonce() })).workspace;
    this.workspaceId = workspace.id;
    const invite = ok(await browserRequest(this.a, "/api/workspace/invites", { email: userB.email, role: "admin", workspaceId: workspace.id })).invite;
    ensure(ok(await browserRequest(this.b, "/api/workspace/invites/" + invite.id + "/accept", {})).member?.id === userB.id, "independent-membership");
    for (const page of [this.a, this.b]) await page.setExtraHTTPHeaders({ "x-zenith-workspace": workspace.id });
    const name = "DRV-1 " + this.scenario + " " + nonce();
    const project = await this.action("project.create", { name, withEnvironment: false });
    this.project = { id: project.projectId, slug: project.slug, name };
    await this.action("project.updateManifest", { projectId: this.project.id, manifest: this.manifest(nonce()) });
    await this.action("system.setSecret", { projectId: this.project.id, serviceId: "witness", key: "DRV_KUBE", secretRef: "vault:DRV_KUBE", secretValue: target.text });
    await this.action("project.updateManifest", { projectId: this.project.id, manifest: this.manifest(nonce()) });
    const connection = await this.action("connection.createKubernetes", { label: name, server: this.config.kind.server,
      caData: target.caData, namespaces: [this.config.kind.namespace], credentialRef: "vault:DRV_KUBE", scopedGuest: false });
    this.project.connectionId = connection.connectionId;
    ok(await this.request("/api/platform/v1/connections/" + connection.connectionId + "/verify", {}));
    const environment = await this.action("env.create", { projectId: this.project.id, name: "production", class: "production",
      connectionId: connection.connectionId, approvalRequired: true });
    this.environmentId = environment.environmentId;
    this.linked = await linkedAgent(this.a, this.stack, this.project, this.workspaceId);
    // An existing deployment is a collision, even if it happens to contain our image.
    const live = await this.kubectl(["get", "deployments", "-o", "json"]);
    ensure(!(JSON.parse(live).items ?? []).some((item: OwnedObject) => item.metadata.name === "witness"), "owned-witness-name-collision");
  }
  manifest(marker: string, healthPath = "/") {
    return { version: 2, placement: { provider: "kubernetes", regions: ["in-cluster"] },
      providerConfig: { kubernetes: { namespace: "zenith-j2" } },
      services: [{ id: "witness", name: "witness", kind: "web", source: { type: "image", image: this.config!.kind.image },
        size: "small", replicas: 1, port: 8080, healthPath, ownership: "managed", env: [{ key: "WITNESS_NONCE", value: marker }] }],
      resources: [], routes: [], bindings: [] };
  }
  request(endpoint: string, body?: unknown, method = body === undefined ? "GET" : "POST", page = this.a!) {
    return browserRequest(page, endpoint, body, method, this.workspaceId);
  }
  action(id: string, input: unknown, page = this.a!) {
    return action(page, id, input, { workspaceId: this.workspaceId, projectId: this.project?.id, environmentId: this.environmentId || undefined });
  }
  detail(id: string) { return this.request("/api/platform/v1/operations/" + id).then(ok); }
  async approve(id: string) {
    const detail = await this.detail(id);
    ensure(detail.operation.status === "awaiting_approval" && detail.decision?.approval?.separationOfDuties === true, "real-human-approval-gate");
    const body = { proposalDigest: detail.operation.proposalDigest, ...(detail.operation.planDigest ? { planDigest: detail.operation.planDigest } : {}),
      ...(detail.planReview?.semantics?.digest ? { semanticsDigest: detail.planReview.semantics.digest } : {}) };
    const self = await this.request("/api/platform/v1/operations/" + id + "/approve", body);
    ensure(self.status === 403 && self.data.error?.code === "separation_of_duties", "self-approval-refusal");
    await this.b!.goto(this.stack!.apiUrl + "/platform/operations/" + id);
    const response = this.b!.waitForResponse(r => r.url().endsWith("/operations/" + id + "/approve") && r.request().method() === "POST");
    await this.b!.getByRole("button", { name: /^Approve / }).click();
    ensure((await response).ok(), "browser-approval");
    const approved = await this.detail(id);
    ensure(approved.approvals.some((a: { approverId: string; decision: string }) => a.approverId === this.users[1] && a.decision === "approve"), "browser-approval-readback");
    return approved;
  }
  async propose(rollbackRevision?: string) {
    const out = await this.action(rollbackRevision ? "deploy.rollback" : "deploy.apply", rollbackRevision
      ? { environmentId: this.environmentId, toRevisionId: rollbackRevision }
      : { projectId: this.project!.id, environmentId: this.environmentId, message: "DRV-1 local operated rehearsal" });
    ensure(out.operationId && out.deploymentId && out.revisionId, "real-workflow-proposal");
    this.operations.push(out.operationId); this.deployments.push(out.deploymentId);
    await this.approve(out.operationId);
    await this.action("deploy.approve", { deploymentId: out.deploymentId }, this.b!);
    const reviewed = await until(() => this.detail(out.operationId), (d: Awaited<ReturnType<Operated["detail"]>>) =>
      (d.operation.status === "awaiting_approval" && d.operation.approvalRound > 0) || TERMINAL.includes(d.operation.status));
    ensure(reviewed.operation.status === "awaiting_approval" && /^[a-f0-9]{64}$/.test(reviewed.operation.planDigest)
      && /^[a-f0-9]{64}$/.test(reviewed.planReview?.semantics?.digest ?? ""), "immutable-plan-review");
    return out;
  }
  async settle(id: string) {
    return until(() => this.detail(id), (d: Awaited<ReturnType<Operated["detail"]>>) => TERMINAL.includes(d.operation.status), 780_000);
  }
  async eventReadback(id: string) {
    const events = await mcp(this.stack, this.linked!.token, "tools/call", { name: "zenith_get_operation_events",
      arguments: { workspaceId: this.workspaceId, operationId: id } });
    ensure(events.data.count > 0 && Array.isArray(events.data.events) && events.data.events.length > 0, "actual-mcp-operation-events");
  }
  async deploy(marker: string, healthPath = "/") {
    await this.action("project.updateManifest", { projectId: this.project!.id, manifest: this.manifest(marker, healthPath) });
    const proposal = await this.propose(); await this.approve(proposal.operationId);
    return { ...proposal, terminal: await this.settle(proposal.operationId) };
  }
  kubectl(args: string[]) {
    return command("kubectl", ["--kubeconfig", this.config!.kind.observerKubeconfigFile, "--context", this.config!.kind.context,
      "-n", this.config!.kind.namespace, ...args]);
  }
  async sql<T extends Record<string, unknown>>(query: string, values: unknown[]): Promise<T[]> {
    // Read-only independent native PG connection, derived exclusively from J1. Never writes authority.
    const environment = hostEnvironment(this.stack!.state) as Record<string, string>;
    const url = new URL(environment.ZENITH_PLATFORM_DB_URL);
    ensure(url.hostname === "localhost" && url.port === String(ports.pooler), "j1-observer-database");
    const observer = postgres(url.href, { max: 1, connect_timeout: 10, prepare: false,
      ssl: { ca: readFileSync(path.join(this.stack!.state.directory, "tls/ca.crt")), rejectUnauthorized: true } });
    try { return [...await observer.unsafe<T[]>(query, values as postgres.ParameterOrJSON<never>[])]; } finally { await observer.end({ timeout: 5 }); }
  }
  async cleanup() {
    const failure = await cleanupAll([
      ...this.recoveries,
      { id: "settle-operations", run: async () => {
        const failures = await cleanupAll(this.operations.map(id => ({ id, run: async () => {
          const detail = await this.detail(id);
          if (!TERMINAL.includes(detail.operation.status)) { ok(await this.request("/api/platform/v1/operations/" + id + "/cancel", { reason: "Owned DRV-1 cleanup" })); await this.settle(id); }
          await until(() => this.sql("select scope from platform.leases where workspace_id=$1 and scope=$2 and released_at is null and expires_at>clock_timestamp()", [this.workspaceId, "env:" + this.environmentId]),
            (leases: Record<string, unknown>[]) => leases.length === 0, 30_000);
        } })));
        ensure(failures.length === 0, "writers-unsettled");
      } },
      { id: "owned-kind-effects", run: async () => {
        if (!this.environmentId) return;
        const kinds = "deployments,statefulsets,cronjobs,jobs,services,ingresses,configmaps,secrets,persistentvolumeclaims,networkpolicies";
        const inventory = async () => JSON.parse(await this.kubectl(["get", kinds, "-o", "json"])).items as OwnedObject[];
        // Never delete beneath a writer, even when cancellation failed. The later credential/engine cleanup still runs.
        const active = await this.sql("select id from platform.operations where workspace_id=$1 and environment_id=$2 and status in ('running','queued','uncertain')", [this.workspaceId, this.environmentId]);
        ensure(active.length === 0, "no-unsettled-cleanup-writer");
        for (const item of cleanupObjects(await inventory(), this.environmentId, this.config!.kind.namespace)) {
          const live = JSON.parse(await this.kubectl(["get", item.kind, item.metadata.name, "-o", "json"])) as OwnedObject;
          ensure(live.metadata.uid === item.metadata.uid && cleanupObjects([live], this.environmentId, this.config!.kind.namespace).length === 1, "cleanup-owner-recheck");
          // API delete preconditions bind the exact observed UID, even across replacement races.
          const api = item.apiVersion === "v1" ? "/api/v1" : "/apis/" + item.apiVersion;
          const resource = ({ Deployment: "deployments", StatefulSet: "statefulsets", CronJob: "cronjobs", Job: "jobs", Service: "services", Ingress: "ingresses", ConfigMap: "configmaps", Secret: "secrets", PersistentVolumeClaim: "persistentvolumeclaims", NetworkPolicy: "networkpolicies" } as Record<string, string>)[item.kind];
          const file = path.join(this.scratch, "delete.json");
          writeFileSync(file, JSON.stringify({ apiVersion: "v1", kind: "DeleteOptions", propagationPolicy: "Foreground", preconditions: { uid: item.metadata.uid } }), { mode: 0o600 });
          await this.kubectl(["delete", "--raw", api + "/namespaces/" + this.config!.kind.namespace + "/" + resource + "/" + item.metadata.name, "-f", file]);
        }
        await until(inventory, (items: OwnedObject[]) => cleanupObjects(items, this.environmentId, this.config!.kind.namespace).length === 0);
      } },
      { id: "revoke-agent", run: async () => { if (this.linked) ok(await this.request("/api/integrations/agent/link/revoke", { credentialId: this.linked.credentialId })); } },
      { id: "revoke-connection", run: async () => { if (this.project?.connectionId) ok(await this.request("/api/platform/v1/connections/" + this.project.connectionId + "/revoke", { reason: "Owned DRV-1 cleanup" }, "POST", this.b)); } },
      ...this.users.map(id => ({ id: "remove-user", run: async () => {
        ok(await jsonRequest(this.stack!.supabaseUrl + "/auth/v1/admin/users/" + id, { method: "DELETE", headers: adminHeaders(this.stack) }));
        const response = await jsonRequest(this.stack!.supabaseUrl + "/auth/v1/admin/users/" + id, { headers: adminHeaders(this.stack) });
        ensure(response.status === 404, "auth-user-absence");
      } })),
      { id: "close-browser", run: async () => { await this.browser?.close(); } },
      ...[...this.cleaners].reverse(),
    ]);
    ensure(failure.length === 0, "owned-cleanup-incomplete");
  }
}

async function runSourceOperated(id: ScenarioId, receiptFile: string, env: NodeJS.ProcessEnv, work: (ctx: Operated, step: Step) => Promise<void>, limits: string[]): Promise<number> {
  if (!enabled(env)) return 2; // no config/credentials/subprocess/browser access before gates
  const { runId, root } = localPaths(env);
  privateLocation(root); privateLocation(receiptFile);
  if (!nativeHost() || !process.versions.node.startsWith("22.")) throw new Error("Needs native host Node 22");
  if (existsSync(receiptFile) || !path.isAbsolute(receiptFile)) throw new Error("Fresh absolute receipt path required");
  if (!existsSync(root)) mkdirSync(root, { mode: 0o700 });
  ensure(lstatSync(root).isDirectory() && !lstatSync(root).isSymbolicLink() && (lstatSync(root).mode & 0o077) === 0
    && lstatSync(root).uid === process.getuid?.(), "owned-private-root");
  const scratch = path.join(root, id); mkdirSync(scratch, { mode: 0o700 }); chmodSync(scratch, 0o700);
  const ctx = new Operated(id, env, scratch), facts: LocalReceipt["checks"] = [];
  const source = sourceBinding(); let failed = false, code = 1;
  const step: Step = async (check, fn) => {
    try { await fn(); facts.push({ id: check, status: "passed" }); }
    catch { facts.push({ id: check, status: "failed" }); throw new Error("Operated check failed"); }
  };
  try {
    await step("preconditions", async () => {
      ensure(env.ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR, "j1-stack");
      const state = readState(env.ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR);
      ensure(state.profile === "lean" && JSON.stringify(state.source) === JSON.stringify(source), "exact-j1-source");
      await ctx.start(source);
    });
    await work(ctx, step);
  } catch { failed = true; }
  finally {
    try { await step("owned-cleanup", () => ctx.cleanup()); } catch { failed = true; }
    try { await step("source-unchanged", async () => { ensure(JSON.stringify(sourceBinding()) === JSON.stringify(source), "source-changed"); }); } catch { failed = true; }
    const receipt = sourceReceiptFor(id, source, runId, facts, ["Owned local operated rehearsal only; no live cloud or production acceptance.", ...limits]);
    writeFileSync(receiptFile, JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    code = failed || receipt.checks.some(c => c.status === "failed") ? 1 : receipt.checks.some(c => c.status === "skipped") ? 3 : 0;
  }
  return code;
}
export type Step = (check: string, fn: () => Promise<void>) => Promise<void>;
export const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
async function sourceDriverCli(run: (receipt: string, env?: NodeJS.ProcessEnv) => Promise<number>, args: string[]) {
  const index = args.indexOf("--receipt");
  if (index < 0 || !args[index + 1]) return 2;
  try { return await run(path.resolve(args[index + 1]!)); }
  catch { process.stderr.write("DRV-1 refused; inspect the sanitized receipt and owned local prerequisites.\n"); return 1; }
}

// Keep each driver's original public API while dispatching to its closed protocol.
type DriftCrashArguments = Parameters<typeof runDriftCrashOperated>;
type SourceArguments = Parameters<typeof runSourceOperated>;
type TenantExportArguments = [input: DriverInput, work: (context: OperatedContext) => Promise<void>];
type BoundTenantExportArguments = [input: DriverInput & { scenarioId: TenantExportScenario }, work: (context: OperatedContext) => Promise<void>];
type RunOperatedArguments = DriftCrashArguments | SourceArguments | TenantExportArguments;
function isTenantExportArguments(args: RunOperatedArguments): args is BoundTenantExportArguments {
  return args.length === 2 && (args[0].scenarioId === "two-tenants" || args[0].scenarioId === "export");
}
function isDriftCrashArguments(args: RunOperatedArguments): args is DriftCrashArguments {
  return args.length === 2 && (args[0].scenarioId === "drift-repair" || args[0].scenarioId === "crash-partition");
}
export function runOperated(...args: DriftCrashArguments): Promise<number>;
export function runOperated(...args: SourceArguments): Promise<number>;
export function runOperated(...args: TenantExportArguments): Promise<number>;
export function runOperated(...args: RunOperatedArguments): Promise<number> {
  if (isTenantExportArguments(args)) return runTenantExportOperated(...args);
  if (isDriftCrashArguments(args)) return runDriftCrashOperated(...args);
  if (args.length === 5) return runSourceOperated(...args);
  throw new Error("operated:invalid-driver-arguments");
}
type UpgradeRestoreReceiptArguments = Parameters<typeof upgradeRestoreReceiptFor>;
type SourceReceiptArguments = Parameters<typeof sourceReceiptFor>;
export function receiptFor(...args: UpgradeRestoreReceiptArguments): LocalReceipt;
export function receiptFor(...args: SourceReceiptArguments): SourceBoundLocalReceipt;
export function receiptFor(...args: UpgradeRestoreReceiptArguments | SourceReceiptArguments): LocalReceipt {
  return args.length === 5 ? sourceReceiptFor(...args) : upgradeRestoreReceiptFor(...args);
}
type UpgradeRestoreCliArguments = Parameters<typeof upgradeRestoreDriverCli>;
type SourceCliArguments = Parameters<typeof sourceDriverCli>;
export function driverCli(...args: UpgradeRestoreCliArguments): Promise<number>;
export function driverCli(...args: SourceCliArguments): Promise<number>;
export function driverCli(...args: UpgradeRestoreCliArguments | SourceCliArguments): Promise<number> {
  return typeof args[0] === "function"
    ? sourceDriverCli(...args as SourceCliArguments)
    : upgradeRestoreDriverCli(...args as UpgradeRestoreCliArguments);
}

// DRV-4 owns an independent tenant/export receipt and reverse-order cleanup protocol.
export interface TenantExportInput { scenarioId: TenantExportScenario; runId: string; sourceCommit: string; receiptFile: string; env: NodeJS.ProcessEnv }
export interface Tenant {
  owner: Page; approver: Page; workspaceId: string; project: { id: string; slug: string; name: string };
  environmentId: string; connectionId: string; ownerId: string; approverId: string;
  manifest: Record<string, unknown>; serviceId: string; witness: string; agent?: { token: string; credentialId: string };
  operationId?: string; deploymentId?: string;
}
export interface OperatedContext {
  config: JourneyConfig; stack: Stack; browser: Browser; scratch: string; input: TenantExportInput; cleanup: TenantExportCleanup; quiescence: TenantExportCleanup; cleanupBlocked: TenantExportCleanupBlocker;
  readbacks: Record<string, string>; step(id: string, work: () => Promise<void>): Promise<void>;
  dataRoundtrips: NonNullable<TenantExportReceipt["dataRoundtrips"]>;
}

async function runTenantExportOperated(input: TenantExportInput, work: (context: OperatedContext) => Promise<void>): Promise<number> {
  // No config, auth, filesystem, subprocess or network access before explicit opt-in.
  if (input.env.ZENITH_LOCAL_DRIVER_D4 !== "1" || input.env.ZENITH_LOCAL_JOINED_DRIVERS !== "1"
    || input.env.ZENITH_ACCEPTANCE_DEFAULT_STACK !== "1" || input.env.ZENITH_DEFAULT_JOURNEY !== "1") return 2;
  ensure(!Object.keys(process.env).some(key => process.env[key] && (/^ZENITH_LIVE_/.test(key)
    || (/^(?:AWS_|AZURE_|GOOGLE_APPLICATION_CREDENTIALS|CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE)/.test(key) && key !== "AWS_EC2_METADATA_DISABLED"))), "cloud-credentials-refused");
  localPaths(input.env);
  ensure(input.env.ZENITH_LOCAL_RUN_ID === input.runId && Number(process.versions.node.split(".")[0]) === 22, "driver-run-binding");
  ensure(path.isAbsolute(input.receiptFile) && !existsSync(input.receiptFile), "fresh-receipt");
  privateFile(input.env.ZENITH_LOCAL_JOURNEY_CONFIG_FILE);
  const config = Config.parse(JSON.parse(privateFile(input.env.ZENITH_LOCAL_JOURNEY_CONFIG_FILE)));
  ensure(realpathSync(config.stackDirectory) === realpathSync(input.env.ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR!), "stack-config-binding");
  const source = sourceBinding();
  ensure(source.head === input.sourceCommit, "source-commit-binding");
  const receipt: TenantExportReceipt = { schema: 1, evidenceLabel: OPERATED_LABEL, scenarioId: input.scenarioId, runId: input.runId,
    sourceCommit: source.head, sourceDigest: source.contentSha256, checks: TENANT_EXPORT_CHECKS[input.scenarioId].map(id => ({ id, status: "skipped" })),
    readbacks: {}, limits: [...TENANT_EXPORT_LIMITS[input.scenarioId]] };
  const cleanupBlocked = new TenantExportCleanupBlocker();
  const cleanup = new TenantExportCleanup(cleanupBlocked);
  const quiescence = new TenantExportCleanup();
  let context: OperatedContext | undefined;
  const step = async (id: string, fn: () => Promise<void>) => {
    const check = receipt.checks.find(item => item.id === id);
    ensure(check?.status === "skipped", "check-inventory");
    try { await fn(); check!.status = "passed"; } catch { check!.status = "failed"; throw new Error("Operated driver check failed"); }
  };
  try {
    await step("preconditions", async () => {
      ensure(nativeHost(), "native-host-required");
      privateLocation(input.receiptFile);
      assertPrivate(privateLocation(input.env.ZENITH_LOCAL_ROOT!), true);
      await assertLocalDocker(input.env);
      const state = readState(config.stackDirectory);
      ensure(state.profile === "lean" && JSON.stringify(state.source) === JSON.stringify(source), "exclusive-current-lean-stack");
      // The explicit D4 gate transfers this fresh disposable J1 installation's cleanup to this invocation.
      cleanup.add(async () => { await cleanupStack(state); });
      const targets = JSON.parse(privateFile(path.join(path.dirname(input.env.ZENITH_LOCAL_JOURNEY_CONFIG_FILE!), "targets.json")));
      const nodes = JSON.parse(await command("docker", ["inspect", "zenith-j2-control-plane"]));
      ensure(targets.schemaVersion === 1 && targets.createdBy === "J2-DEFAULT-JOURNEY" && targets.kind === "zenith-j2"
        && targets.status === "created" && nodes.length === 1 && targets.containerId === nodes[0].Id
        && nodes[0].Config.Labels?.["io.x-k8s.kind.cluster"] === "zenith-j2", "exclusive-kind-ownership");
      cleanup.add(async () => {
        const current = JSON.parse(await command("docker", ["inspect", targets.containerId]));
        ensure(current.length === 1 && current[0].Id === targets.containerId && current[0].Config.Labels?.["io.x-k8s.kind.cluster"] === "zenith-j2", "kind-cleanup-ownership");
        await command("kind", ["delete", "cluster", "--name", "zenith-j2"]);
        ensure(!(await command("kind", ["get", "clusters"])).split(/\s+/).includes("zenith-j2"), "kind-cleanup-absence");
        for (const name of ["deployer-old.json", "deployer-new.json", "kind-bootstrap.yaml", "observer.json", "journey.json"]) {
          const file = privateLocation(path.join(path.dirname(input.env.ZENITH_LOCAL_JOURNEY_CONFIG_FILE!), name));
          if (existsSync(file)) { privateFile(file); rmSync(file); }
        }
      });
      const stack = await prerequisites(config, { commit: source.head, sourceDigest: source.contentSha256, dirty: source.dirty });
      kubeconfig(config.kind.kubeconfigFile, config);
      privateFile(config.kind.observerKubeconfigFile);
      const scratch = mkdtempSync(path.join(realpathSync(input.env.ZENITH_LOCAL_ROOT!), "drv4-")); chmodSync(scratch, 0o700);
      cleanup.add(async () => { rmSync(scratch, { recursive: true }); });
      const { chromium } = await import("@playwright/test");
      const browser = await chromium.launch({ headless: true });
      cleanup.add(async () => { await browser.close(); });
      const dataRoundtrips = input.scenarioId === "export" ? (receipt.dataRoundtrips = {}) : {};
      context = { config, stack, browser, scratch, input, cleanup, quiescence, cleanupBlocked, readbacks: receipt.readbacks, dataRoundtrips, step };
    });
    if (!context) throw new Error("Operated context was not initialized");
    await work(context);
    await step("source-stable", async () => { ensure(JSON.stringify(sourceBinding()) === JSON.stringify(source), "source-drift"); });
  } catch {
    // An exception between named steps is an attempted failure, not a skipped prerequisite.
    if (!receipt.checks.some(check => check.status === "failed")) {
      const pending = receipt.checks.find(check => check.id !== "owned-cleanup" && check.status === "skipped");
      if (pending) pending.status = "failed";
    }
  }
  finally {
    const settled = await settleAfterQuiescence(quiescence, cleanup, cleanupBlocked);
    if (!settled.quiesced) { try { await context?.browser.close(); } catch { /* preserve owned fixtures and their diagnostic state */ } }
    receipt.checks.find(item => item.id === "owned-cleanup")!.status = settled.clean && receipt.checks[0].status === "passed" ? "passed" : "failed";
    validateOperatedReceipt(receipt, { scenarioId: input.scenarioId, runId: input.runId, sourceCommit: input.sourceCommit, sourceDigest: source.contentSha256 });
    writeFileSync(input.receiptFile, JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  }
  return receiptExit(receipt);
}

async function authenticateBeforeWorkspace(page: Page, stack: Stack, user: { id: string; email: string; password: string }): Promise<void> {
  await page.goto(stack.apiUrl + '/login?next=/overview');
  await page.getByLabel('Email', { exact: true }).fill(user.email);
  await page.getByLabel('Password', { exact: true }).fill(user.password);
  const signedIn = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.origin === stack.supabaseUrl && url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'password';
  });
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const verified = await signedIn;
  ensure(verified.ok() && (await verified.json()).user?.id === user.id, 'real-auth-identity');
  await page.waitForURL(url => url.origin === stack.apiUrl && url.pathname !== '/login');
}

export async function createTenant(ctx: OperatedContext, letter: string): Promise<Tenant> {
  const { stack, browser, config, cleanup, input } = ctx;
  const users: string[] = [];
  cleanup.add(async () => {
    let failed = false;
    for (const id of users.reverse()) {
      try { ok(await jsonRequest(stack.supabaseUrl + "/auth/v1/admin/users/" + id, { method: "DELETE", headers: adminHeaders(stack) })); }
      catch { failed = true; }
    }
    ensure(!failed, "auth-cleanup");
  });
  const owner = await (await browser.newContext()).newPage(), approver = await (await browser.newContext()).newPage();
  const a = await operator(stack, config.mailpitUrl, `drv4-${letter}-owner`, users);
  const b = await operator(stack, config.mailpitUrl, `drv4-${letter}-approver`, users);
  await authenticateBeforeWorkspace(owner, stack, a);
  const workspace = ok(await browserRequest(owner, "/api/workspace", { name: `DRV4 ${input.runId} ${letter}` })).workspace;
  ok(await browserRequest(owner, "/api/bootstrap"));
  await enrollOperator(owner, stack);
  const invite = ok(await browserRequest(owner, "/api/workspace/invites", { workspaceId: workspace.id, email: b.email, role: "admin" })).invite;
  await authenticateBeforeWorkspace(approver, stack, b);
  await enrollOperator(approver, stack);
  const accepted = ok(await browserRequest(approver, "/api/workspace/invites/" + invite.id + "/accept", {}));
  ok(await browserRequest(approver, "/api/bootstrap"));
  ensure(accepted.member?.id === b.id && accepted.member?.role === "admin", "approver-member");
  const name = `DRV4 ${input.runId} ${letter}`;
  const created = await action(owner, "project.create", { name, withEnvironment: false });
  return { owner, approver, ownerId: a.id, approverId: b.id, workspaceId: workspace.id,
    project: { id: created.projectId, slug: created.slug, name }, environmentId: "", connectionId: "",
    manifest: {}, serviceId: `witness-${letter}`, witness: nonce() };
}

export async function connectKind(ctx: OperatedContext, tenant: Tenant): Promise<void> {
  const { config, stack } = ctx;
  const { owner, project, serviceId, witness } = tenant;
  tenant.manifest = { version: 2, placement: { provider: "kubernetes", regions: ["in-cluster"] },
    providerConfig: { kubernetes: { namespace: config.kind.namespace } }, services: [{ id: serviceId, name: serviceId, kind: "web",
      source: { type: "image", image: config.kind.image }, size: "small", replicas: 1, port: 8080, healthPath: "/", ownership: "managed",
      env: [{ key: "WITNESS_NONCE", value: witness }] }], resources: [], routes: [], bindings: [] };
  await action(owner, "project.updateManifest", { projectId: project.id, manifest: tenant.manifest });
  const credentialRef = "vault:DRV4_KUBE";
  await action(owner, "system.setSecret", { projectId: project.id, serviceId, key: "DRV4_KUBE", secretRef: credentialRef, secretValue: privateFile(config.kind.kubeconfigFile) });
  await action(owner, "project.updateManifest", { projectId: project.id, manifest: tenant.manifest });
  const target = kubeconfig(config.kind.kubeconfigFile, config);
  tenant.connectionId = (await action(owner, "connection.createKubernetes", { label: project.name, server: config.kind.server,
    caData: target.caData, namespaces: [config.kind.namespace], credentialRef, scopedGuest: false })).connectionId;
  await owner.goto(stack.apiUrl + "/platform/connections");
  const card = owner.getByRole("listitem").filter({ hasText: project.name });
  const response = owner.waitForResponse(value => value.url().endsWith("/connections/" + tenant.connectionId + "/verify") && value.request().method() === "POST");
  await card.getByRole("button", { name: "Verify", exact: true }).click(); ensure((await response).ok(), "kind-connection-verified");
  tenant.environmentId = (await action(owner, "env.create", { projectId: project.id, name: "production", class: "production", connectionId: tenant.connectionId, approvalRequired: true })).environmentId;
  tenant.agent = await linkedAgent(owner, stack, project, tenant.workspaceId);
  ctx.cleanup.add(async () => { ok(await browserRequest(owner, "/api/integrations/agent/link/revoke", { credentialId: tenant.agent!.credentialId })); });
}

export const detailOf = async (tenant: Tenant, operationId: string): Promise<OperationStatusView> => ok(await browserRequest(tenant.owner, "/api/platform/v1/operations/" + operationId, undefined, "GET", tenant.workspaceId));
export async function approveOperation(ctx: OperatedContext, tenant: Tenant, operationId: string): Promise<void> {
  const detail = await detailOf(tenant, operationId);
  ensure(detail.operation.status === "awaiting_approval" && detail.decision?.approval?.separationOfDuties === true, "human-approval-required");
  await tenant.approver.goto(ctx.stack.apiUrl + "/platform/operations/" + operationId);
  const response = tenant.approver.waitForResponse(value => value.url().endsWith("/operations/" + operationId + "/approve") && value.request().method() === "POST");
  await tenant.approver.getByRole("button", { name: /^Approve / }).click();
  ensure((await response).ok(), "browser-human-approval");
  const recorded = await detailOf(tenant, operationId);
  ensure(recorded.operation.status === "approved" && recorded.approvals.some((value: { approverId: string; decision: string }) => value.approverId === tenant.approverId && value.decision === "approve"), "human-approval-readback");
}
export async function deployKind(ctx: OperatedContext, tenant: Tenant): Promise<void> {
  const result = await action(tenant.owner, "deploy.apply", {}, { projectId: tenant.project.id, environmentId: tenant.environmentId });
  ensure(result.operationId && result.deploymentId, "real-workflow-proposal");
  tenant.operationId = result.operationId; tenant.deploymentId = result.deploymentId;
  await approveOperation(ctx, tenant, result.operationId);
  await action(tenant.approver, "deploy.approve", { deploymentId: result.deploymentId }, { projectId: tenant.project.id, environmentId: tenant.environmentId });
  const inspected = await until(() => detailOf(tenant, result.operationId), (data: OperationStatusView) => data.operation.status === "awaiting_approval" && (data.operation.approvalRound ?? 0) > 0);
  ensure(/^[a-f0-9]{64}$/.test(inspected.operation.planDigest ?? "") && /^[a-f0-9]{64}$/.test(inspected.planReview?.semantics?.digest ?? ""), "immutable-plan-review");
  await approveOperation(ctx, tenant, result.operationId);
  const terminal = await until(() => detailOf(tenant, result.operationId), (value: OperationStatusView) => ["succeeded", "failed", "uncertain", "denied", "expired"].includes(value.operation.status));
  ensure(terminal.operation.status === "succeeded", "deployment-terminal");
}
/** Read the real objects and served witness through the independent observer, never API projections. */
export async function observeKind(ctx: OperatedContext, tenant: Tenant): Promise<string> {
  type Deployment = { metadata: { name: string; uid: string; generation: number; annotations?: Record<string, string> }; spec: { replicas: number; template: { spec: { containers: { image: string }[] } } }; status: { availableReplicas: number; observedGeneration: number } };
  const base = ["--kubeconfig", ctx.config.kind.observerKubeconfigFile, "--context", ctx.config.kind.context, "-n", ctx.config.kind.namespace];
  const observed = await until(async () => JSON.parse(await command("kubectl", [...base, "get", "deployments", "-o", "json"])), (value: { items: Deployment[] }) =>
    value.items?.some((item: Deployment) => item.metadata?.annotations?.["zenith.dev/environment"] === tenant.environmentId && item.status?.availableReplicas === 1));
  const objects: Deployment[] = observed.items.filter((item: Deployment) => item.metadata?.annotations?.["zenith.dev/environment"] === tenant.environmentId);
  ensure(objects.length === 1 && objects[0].spec.replicas === 1 && objects[0].status.observedGeneration >= objects[0].metadata.generation
    && objects[0].spec.template.spec.containers[0].image === ctx.config.kind.image, "owned-kind-witness");
  const served = JSON.parse(await command("kubectl", [...base, "exec", "deployment/" + objects[0].metadata.name, "--", "/usr/local/bin/witness", "probe"]));
  ensure(served.kind === "zenith-default-journey" && served.nonce === tenant.witness, "served-witness");
  return sha256({ uid: objects[0].metadata.uid, generation: objects[0].metadata.generation, spec: objects[0].spec, served });
}
export async function runDriverCli(scenarioId: TenantExportScenario, driver: (input: TenantExportInput) => Promise<number>, args = process.argv.slice(2)): Promise<number> {
  const env = process.env;
  if (env.ZENITH_LOCAL_DRIVER_D4 !== "1") return 2;
  try {
    const flags: Record<string, string> = {};
    for (let i = 0; i < args.length; i += 2) {
      ensure(["--receipt", "--run-id"].includes(args[i]) && args[i + 1] && !flags[args[i]], "driver-usage"); flags[args[i]] = args[i + 1];
    }
    ensure(flags["--receipt"] && flags["--run-id"], "driver-usage");
    return await driver({ scenarioId, env, runId: flags["--run-id"], sourceCommit: sourceBinding().head, receiptFile: flags["--receipt"] });
  } catch { process.stderr.write("Operated rehearsal refused or failed; inspect only the sanitized receipt.\n"); return 1; }
}
