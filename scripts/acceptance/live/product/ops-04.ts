/**
 * ProductScenarioPort for OPS-04 (live sandbox): restore of the control-plane database with real AWS customer state.
 *
 * Zenith deploys one managed S3 bucket. A second bucket is proposed and left waiting for its approval, before any workflow
 * starts; the execution worker is stopped and the snapshot is taken there. After the backup the deploy is approved and applied (the
 * second bucket exists in AWS and in the recorded state). The control-plane database is then lost and restored into a new
 * database from the snapshot, and the API and worker are recreated against it. The run proves the restored deploy is fenced
 * by the new recovery epoch (an approval is refused), never runs again on its own, comes back only through a recovery
 * decision and a fresh approval, and that applying it again changes nothing in AWS. A deploy that was already dispatched
 * (`running`) restores `uncertain`, and one whose workflow start was attempted is never resumed (a start is never
 * replayed), so the proposal waiting for its first approval is the one resumable point.
 * RPO and RTO are measured against the approved targets (PROD-OPS-01).
 *
 * Cleanup destroys exactly the recorded state (state-destroy.ts) and restores the sandbox trust, as DEPLOY-01 does.
 */
import type { EnvLike } from "../../config";
import type { Call, Json, ProductScenarioPort } from "../contracts";
import { laneSuffix, liveRoleNames } from "../plan";
import type { Deploy01Product } from "./deploy-01-driver";
import { fill, parsePolicy, refuse, Refusal, sanitizedError, templateExternalId, trustDocument } from "./mix-03";
import { runnerOps04Stack, type Ops04Stack } from "./ops-04-stack";
import { destroyFromState, readState, type SessionCredentials, type StateDestroyInput } from "./state-destroy";
import { stateResources } from "./teardown-01";
import { measureRecovery } from "@/lib/ops/recovery/report";

type Invoke = (call: Call, values?: Record<string, string>, extra?: Record<string, Json>) => Promise<Record<string, unknown>>;
const EXTERNAL_ID_NEW = /^zenith-[0-9a-f]{32}$/;
/** Approved launch targets (deploy/slo/slo-definitions.json, approved_targets 2026-10-13.1). */
export const OPS04_TARGETS = { rpoSeconds: 900, rtoSeconds: 14_400, status: "target" as const };

export function ops04Manifest(runId: string, buckets: 1 | 2): Record<string, unknown> {
  const name = (n: number) => `ops04-${runId.slice(-8).toLowerCase()}-${n}`;
  return { version: 1, services: [], routes: [], bindings: [],
    resources: [1, 2].slice(0, buckets).map(n => ({ id: `assets-${n}`, name: name(n), kind: "object_store", config: {}, size: "small", ownership: "managed" })) };
}

export interface Ops04Seams {
  product?: Deploy01Product;
  stack?: Ops04Stack;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  propagation?: { attempts: number; intervalMs: number };
  /** How long the restored stack runs before the run checks that nothing executed on its own. */
  quietMs?: number;
  state?: { read: (input: StateDestroyInput) => Promise<unknown>; destroy: (input: StateDestroyInput) => Promise<{ destroyed: number; destroyedArns?: string[]; destroyedIds?: string[] }> };
}

const field = (value: unknown, key: string): unknown => value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
const BUCKET = /^arn:aws:s3:::[a-z0-9.-]{3,63}$/;

export function ops04Port(env: EnvLike = process.env, seams: Ops04Seams = {}): ProductScenarioPort {
  const product = seams.product ?? refuse("the OPS-04 browser driver is not wired");
  const sleep = seams.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const now = seams.now ?? (() => new Date());
  const propagation = seams.propagation ?? { attempts: 12, intervalMs: 15_000 };
  const quietMs = seams.quietMs ?? 120_000;
  const state = seams.state ?? { read: readState, destroy: destroyFromState };
  return {
    async verify(requirement, { plan, call }) {
      if (requirement.id !== "PROD-OPS-04") return { complete: false, reason: `${requirement.id}: not implemented by this port` };
      const invoke: Invoke = (c, values = {}, extra = {}) => call(c, { ...fill(c.input, values), ...extra });
      const planned = (id: string): Call => plan.productCalls?.find(c => c.id === id) ?? refuse(`the plan has no call ${id}`);
      const account = plan.settings.accountId, region = plan.settings.region, runId = plan.settings.runId;
      const bootstrapNameSuffix = laneSuffix(plan.settings), names = liveRoleNames(bootstrapNameSuffix);
      const stateBucket = `zenith-state-${account}-${region}${bootstrapNameSuffix}`;
      const principal = `arn:aws:iam::${account}:role/${names.principal}`;
      const roleArns = { observe: `arn:aws:iam::${account}:role/${names.observe}`, deploy: `arn:aws:iam::${account}:role/${names.deploy}` };
      const tofu = env.ZENITH_TOFU_BIN?.trim() || "tofu";
      const trust: { role: "observe" | "deploy"; original: string; write: Call }[] = [];
      let externalId: string | undefined, workspaceId: string | undefined, environmentId: string | undefined, stack: Ops04Stack | undefined;
      const session = async (): Promise<SessionCredentials> => {
        const out = await invoke(planned("teardown01-sts-assume"), { externalId: externalId! });
        const c = field(out, "Credentials");
        const id = field(c, "AccessKeyId"), secret = field(c, "SecretAccessKey"), token = field(c, "SessionToken");
        if (typeof id !== "string" || typeof secret !== "string" || typeof token !== "string") refuse("the deploy role session could not be read");
        return { accessKeyId: id as string, secretAccessKey: secret as string, sessionToken: token as string };
      };
      const stateInput = async (): Promise<StateDestroyInput> => ({
        tofu, region, backend: { kind: "s3", bucket: stateBucket, region }, stateKey: `zenith/${workspaceId}/${environmentId}/terraform.tfstate`, credentials: await session(),
      });
      const buckets = async () => {
        const out = await invoke(planned("teardown01-tag-read"), { environmentId: environmentId! });
        return ((field(out, "ResourceTagMappingList") as unknown[] | undefined) ?? []).map(r => String(field(r, "ResourceARN"))).filter(arn => BUCKET.test(arn)).sort();
      };
      const succeeded = (label: string, result: { status: string; detail?: string }) => {
        if (result.status !== "succeeded") refuse(`the ${label} ended ${/^[a-z_]{1,20}$/.test(result.status) ? result.status : "unknown"}, not succeeded${result.detail ? ` (product: ${result.detail})` : ""}`);
      };
      let step = "preconditions";
      let outcome: { complete: boolean; reason: string };
      try {
        if (env.ZENITH_LIVE_PRODUCT !== "1") refuse("ZENITH_LIVE_PRODUCT=1 is not set; no product scenario ran");
        if (plan.settings.scenario !== "ops-04" || !plan.productCalls?.length) refuse("the plan is not the ops-04 scenario");
        if (!product.proposeDeploy || !product.finishDeploy || !product.operationStatus || !product.recoveryItems || !product.decideRecovery || !product.tryApprove) refuse("the browser driver has no recovery path");
        stack = seams.stack ?? runnerOps04Stack(env, runId);
        step = "tenant";
        const tenant = await product.createTenant();
        workspaceId = tenant.workspaceId;
        step = "connection";
        const connection = await product.createAwsConnection(tenant, { accountId: account, region, observeRoleArn: roleArns.observe, deployRoleArn: roleArns.deploy, stateBucket, bootstrapNameSuffix });
        if (!EXTERNAL_ID_NEW.test(connection.externalId)) refuse("the generated ExternalId has an unexpected shape");
        step = "sandbox trust";
        for (const role of ["observe", "deploy"] as const) {
          const current = await invoke(planned(`teardown01-iam-read-${role}`));
          const original = templateExternalId(parsePolicy(field(field(current, "Role"), "AssumeRolePolicyDocument")), principal);
          const write = planned(`teardown01-iam-trust-${role}`);
          trust.push({ role, original, write });
          await invoke(write, { trustDocument: trustDocument(principal, connection.externalId) });
        }
        externalId = connection.externalId;
        step = "connection verification";
        for (let attempt = 1; ; attempt++) {
          if ((await product.verifyAws(tenant, connection.connectionId)).ok) break;
          if (attempt >= propagation.attempts) refuse("connection.verifyAws did not pass after the trust update within the propagation bound");
          await sleep(propagation.intervalMs);
        }
        step = "environment";
        environmentId = (await product.createEnvironment(tenant, { connectionId: connection.connectionId, region, name: `ops04-${runId.slice(-8).toLowerCase()}` })).environmentId;
        step = "first deploy";
        await product.setManifest(tenant, ops04Manifest(runId, 1));
        succeeded("first deploy", await product.deploy(tenant, environmentId, "apply"));

        step = "planned before the snapshot";
        await product.setManifest(tenant, ops04Manifest(runId, 2));
        const { operationId, deploymentId } = await product.proposeDeploy!(tenant, environmentId);
        for (const deadline = now().getTime() + 15 * 60_000; ;) {
          const view = await product.operationStatus!(tenant, operationId);
          if (view.status === "awaiting_approval") break;
          if (view.status !== "proposed") refuse(`the second deploy is ${/^[a-z_]{1,20}$/.test(view.status) ? view.status : "unknown"} instead of waiting for its approval`);
          if (now().getTime() >= deadline) refuse("the second deploy did not wait for its approval within 15 minutes");
          await sleep(10_000);
        }
        await stack.stop(["execution-worker"]);
        if ((await buckets()).length !== 1) refuse("the second bucket exists before its apply was approved");
        step = "backup";
        const snapshot = await stack.backup();
        step = "applied after the snapshot";
        await stack.start("execution-worker");
        succeeded("second deploy", await product.finishDeploy!(tenant, environmentId, operationId, deploymentId));
        const applied = await buckets(), appliedResources = stateResources(await state.read(await stateInput()));
        if (applied.length !== 2) refuse(`the second deploy did not leave two tagged buckets (${applied.length})`);

        step = "database loss";
        const incidentAt = now().toISOString();
        await stack.stop(["api", "execution-worker"]);
        step = "restore";
        const report = await stack.restore(incidentAt);
        const failedStep = report.steps.find(s => s.status !== "ok");
        if (!report.ok || !report.epoch || report.epoch <= snapshot.epoch) {
          // The runbook's own step detail, scrubbed and elided (never a URL or path), names why the restore stopped.
          const why = sanitizedError(failedStep?.detail);
          refuse(`the restore did not complete (step ${failedStep?.id ?? "unknown"}${why ? `: ${why}` : ""})`);
        }
        step = "restored fence";
        const fenced = await stack.readback(workspaceId, operationId);
        if (fenced.epoch >= fenced.current || fenced.current !== report.epoch || fenced.status !== "awaiting_approval") refuse(`the restored deploy is not a fenced proposal (operation ${/^[a-z_]{1,20}$/.test(fenced.status) ? fenced.status : "unknown"})`);
        step = "restored stack";
        await stack.switchToRestored();
        await stack.start("api");
        const fencedApproval = await product.tryApprove!(tenant, operationId);
        if (fencedApproval.ok) refuse("an approval of the restored deploy was accepted before a recovery decision");
        await stack.start("execution-worker");
        const healthyAt = now().toISOString();
        step = "no resurrection";
        await sleep(quietMs);
        const quiet = await product.operationStatus!(tenant, operationId);
        if (quiet.status !== "awaiting_approval") refuse(`the restored deploy moved on its own (operation ${/^[a-z_]{1,20}$/.test(quiet.status) ? quiet.status : "unknown"})`);
        if (stateResources(await state.read(await stateInput())) !== appliedResources || (await buckets()).join() !== applied.join()) refuse("AWS changed while the restored approval was fenced");
        step = "recovery decision";
        const pending = await product.recoveryItems!(tenant);
        if (pending.epoch !== report.epoch) refuse("the API is not serving the restored database");
        const item = pending.items.find(i => i.kind === "operation" && i.ref === operationId);
        if (!item || !item.allowed.includes("resume") || !/^[a-f0-9]{64}$/.test(item.bindingDigest)) refuse("the restored operation has no resumable recovery item");
        const wrong = (item.bindingDigest[0] === "0" ? "1" : "0") + item.bindingDigest.slice(1);
        if ((await product.decideRecovery!(tenant, item.id, { decision: "resume", bindingDigest: wrong, reason: "OPS-04 stale binding refusal" })).status !== 409) refuse("a stale recovery binding was not refused");
        const decided = await product.decideRecovery!(tenant, item.id, { decision: "resume", bindingDigest: item.bindingDigest, reason: "Reviewed the AWS state independently" });
        if (decided.status !== 200 || decided.state !== "resumed") refuse(`the recovery resume was not accepted (HTTP ${decided.status}${decided.state && /^[a-z_]{1,20}$/.test(decided.state) ? `, item ${decided.state}` : ""}${decided.why ? `; product: ${decided.why}` : ""})`);
        const reviewed = await product.operationStatus!(tenant, operationId);
        if (reviewed.status !== "awaiting_approval") refuse(`the resumed operation does not wait for a fresh approval (operation ${reviewed.status})`);
        step = "fresh approval";
        succeeded("resumed deploy", await product.finishDeploy!(tenant, environmentId, operationId, deploymentId));
        const after = await buckets(), afterResources = stateResources(await state.read(await stateInput()));
        if (after.join() !== applied.join() || afterResources !== appliedResources) refuse(`the resumed deploy changed AWS (${after.length} buckets, ${afterResources} recorded resources; expected ${applied.length} and ${appliedResources})`);
        step = "measurement";
        const m = report.measurement ?? refuse("the restore report has no measurement");
        const measured = measureRecovery({ ...m, incidentAt, applicationHealthyAt: healthyAt, targets: OPS04_TARGETS });
        if (measured.verdict !== "within_targets") refuse(`the recovery is not within the approved targets (RPO ${measured.rpoSeconds ?? "unmeasured"} s of 900, RTO ${measured.rtoSeconds ?? "unmeasured"} s of 14400)`);
        outcome = { complete: true, reason: `OPS-04 restore proven on AWS: a deploy waiting for its approval was captured in the backup and approved and applied after it; the control-plane database was restored into a new database at recovery epoch ${report.epoch}; the restored proposal was fenced (an approval was refused: ${fencedApproval.refusal ?? "refused"}), did not execute on its own for ${Math.round(quietMs / 1000)} s, and came back only through a recovery resume (a stale binding was refused) and a fresh approval; applying it again left AWS unchanged (${after.length} buckets, ${afterResources} recorded resources). Measured RPO ${measured.rpoSeconds} s (target 900) and RTO ${measured.rtoSeconds} s (target 14400)` };
      } catch (error) {
        outcome = error instanceof Refusal
          ? { complete: false, reason: `OPS-04 not proven at ${step}: ${error.message}` }
          : { complete: false, reason: `OPS-04 not proven at ${step}: unexpected failure (details withheld; no completion claim)` };
      }
      const leaks: string[] = [];
      try { await stack?.close(); } catch { leaks.push("the stack composition could not be restored"); }
      if (environmentId && externalId) {
        try { await state.destroy(await stateInput()); }
        catch (error) { leaks.push(error instanceof Error && /^(OpenTofu|\d+ resource|The recorded state)/.test(error.message) ? error.message : "state cleanup failed; resources may remain"); }
        try {
          let left: string[] = [];
          for (let attempt = 1; ; attempt++) {
            left = await buckets();
            if (!left.length || attempt >= 4) break;
            await sleep(90_000);
          }
          if (left.length) leaks.push(`${left.length} tagged bucket(s) still present after cleanup`);
        } catch { leaks.push("cleanup re-list failed; resources may remain"); }
      }
      for (const t of [...trust].reverse()) {
        try { await invoke(t.write, { trustDocument: trustDocument(principal, t.original) }); }
        catch { leaks.push(`restoring the ${t.role} sandbox trust failed`); }
      }
      try { await product.close?.(); } catch { /* best-effort browser release */ }
      if (leaks.length) return { complete: false, reason: `${outcome.reason}; cleanup leaks: ${leaks.length} (see the cleanup checks)`, leaks };
      return { ...outcome, leaks };
    },
  };
}
