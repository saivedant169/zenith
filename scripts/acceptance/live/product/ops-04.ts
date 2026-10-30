/**
 * ProductScenarioPort for OPS-04 (live sandbox): restore of the control-plane database with real AWS customer state.
 *
 * Zenith deploys one managed S3 bucket. A second bucket is proposed and left waiting for its approval, before any workflow
 * starts; the execution worker is stopped and the snapshot is taken there. After the backup the deploy is approved and applied (the
 * second bucket exists in AWS and in the recorded state). The stores are then lost from the control-plane database and
 * restored into it from the snapshot (ops-04-stack.ts), and the API and worker restart against it. The run proves the restored deploy is fenced
 * by the new recovery epoch (an approval is refused), never runs again on its own, comes back only through a recovery
 * decision and a fresh approval, and that applying it again changes nothing in AWS. A deploy that was already dispatched
 * (`running`) restores `uncertain`, and one whose workflow start was attempted is never resumed (a start is never
 * replayed), so the proposal waiting for its first approval is the one resumable point.
 * RPO and RTO are measured against the approved targets (PROD-OPS-01).
 *
 * The same run measures PROD-OPS-01 (ops01-measure.ts): a probe of the API's readiness route (`/api/me`, the container
 * healthcheck) from the runner every 100 ms for the whole run gives control-plane availability (non-5xx) and API latency;
 * it pauses only for the deliberate database loss, which RTO measures instead. A 60 s open-loop burst at 30 requests/s
 * gives capacity (2xx only). The restore's instants give RPO and RTO. Both requirements share one run and one cleanup.
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
import { sloDefinitions } from "@/lib/slo/definitions";
import { measure, samplesToDemonstrate, type CapacityRun, type RatioMeasurement, type RestoreInstants, type TimedSample } from "./ops01-measure";
import { runnerStack } from "./mix-03-driver";

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
  /** One OPS-01 request to the control plane: its HTTP status (0 when it got no answer) and duration. */
  probe?: () => Promise<{ status: number; durationMs: number }>;
  /** The OPS-01 pacing timer (probe interval, burst spacing, top-up wait). Default: a real timer. */
  tick?: (ms: number) => Promise<void>;
  capacity?: { perSecond: number; ms: number };
}

const VANTAGE = "runner-local";
/** The readiness route the API container's healthcheck calls, from the runner, never following a redirect. */
function apiProbe(env: EnvLike): () => Promise<{ status: number; durationMs: number }> {
  const url = new URL("/api/me", runnerStack(env).apiUrl).toString();
  return async () => {
    const start = performance.now();
    try {
      const response = await fetch(url, { redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(5_000) });
      await response.arrayBuffer();
      return { status: response.status, durationMs: performance.now() - start };
    } catch { return { status: 0, durationMs: performance.now() - start }; }
  };
}
/** Availability counts 429 as served (the SLI's own rule); no answer or a 5xx is a failure. */
const available = (status: number) => status > 0 && status < 500;

/** Probes the control plane until stopped; paused for the deliberate outage. */
function sampler(probe: () => Promise<{ status: number; durationMs: number }>, tick: (ms: number) => Promise<void>, intervalMs: number) {
  const samples: TimedSample[] = [];
  let paused = false, stopped = false, pausedFrom = 0, pausedMs = 0;
  const loop = (async () => {
    while (!stopped) {
      if (!paused) { const r = await probe(); if (!paused) samples.push({ durationMs: r.durationMs, ok: available(r.status) }); }
      await tick(intervalMs);
    }
  })();
  return {
    samples,
    pausedSeconds: () => Math.round(pausedMs / 1000),
    pause() { if (!paused) { paused = true; pausedFrom = performance.now(); } },
    resume() { if (paused) { paused = false; pausedMs += performance.now() - pausedFrom; } },
    async stop() { stopped = true; await loop; },
  };
}

async function capacityBurst(probe: () => Promise<{ status: number; durationMs: number }>, tick: (ms: number) => Promise<void>, perSecond: number, ms: number): Promise<CapacityRun> {
  const samples: TimedSample[] = [], inflight: Promise<void>[] = [];
  const start = performance.now();
  for (let i = 0; i < Math.round(perSecond * ms / 1000); i++) {
    inflight.push(probe().then(r => { samples.push({ durationMs: r.durationMs, ok: r.status >= 200 && r.status < 300 }); }));
    await tick(1000 / perSecond);
  }
  await Promise.all(inflight);
  return { vantage: VANTAGE, offeredPerSecond: perSecond, elapsedMs: Math.max(1, performance.now() - start), samples };
}

const pct = (x: number | null) => x === null ? "n/a" : `${(x * 100).toFixed(2)}%`;
const msText = (x: number | null) => x === null ? "n/a" : `${Math.round(x)} ms`;

const field = (value: unknown, key: string): unknown => value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
const BUCKET = /^arn:aws:s3:::[a-z0-9.-]{3,63}$/;

export function ops04Port(env: EnvLike = process.env, seams: Ops04Seams = {}): ProductScenarioPort {
  const product = seams.product ?? refuse("the OPS-04 browser driver is not wired");
  const sleep = seams.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const now = seams.now ?? (() => new Date());
  const propagation = seams.propagation ?? { attempts: 12, intervalMs: 15_000 };
  const quietMs = seams.quietMs ?? 120_000;
  const state = seams.state ?? { read: readState, destroy: destroyFromState };
  const tick = seams.tick ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const burst = seams.capacity ?? { perSecond: 30, ms: 60_000 };
  type Result = { complete: boolean; reason: string; leaks: string[] };
  let run: Promise<Record<"PROD-OPS-04" | "PROD-OPS-01", Result>> | undefined;
  return {
    async verify(requirement, context) {
      if (requirement.id !== "PROD-OPS-04" && requirement.id !== "PROD-OPS-01") return { complete: false, reason: `${requirement.id}: not implemented by this port` };
      // One run proves both: whichever is verified first starts it, the other reads its result.
      run ??= flow(context);
      return (await run)[requirement.id];
    },
  };

  async function flow({ plan, call }: Parameters<ProductScenarioPort["verify"]>[1]): Promise<Record<"PROD-OPS-04" | "PROD-OPS-01", Result>> {
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
      let probes: ReturnType<typeof sampler> | undefined, instants: RestoreInstants | undefined, probe: (() => Promise<{ status: number; durationMs: number }>) | undefined;
      try {
        if (env.ZENITH_LIVE_PRODUCT !== "1") refuse("ZENITH_LIVE_PRODUCT=1 is not set; no product scenario ran");
        if (plan.settings.scenario !== "ops-04" || !plan.productCalls?.length) refuse("the plan is not the ops-04 scenario");
        if (!product.proposeDeploy || !product.finishDeploy || !product.operationStatus || !product.recoveryItems || !product.decideRecovery || !product.tryApprove) refuse("the browser driver has no recovery path");
        stack = seams.stack ?? runnerOps04Stack(env, runId);
        probe = seams.probe ?? apiProbe(env);
        probes = sampler(probe, tick, 100);
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
          const verified = await product.verifyAws(tenant, connection.connectionId);
          if (verified.ok) break;
          if (attempt >= propagation.attempts) refuse(`connection.verifyAws did not pass after the trust update within the propagation bound${verified.why ?? ""}`);
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
        probes?.pause();
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
        await stack.start("api");
        probes?.resume();
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
        if (m.backupSnapshotAt) instants = { failureAtMs: Date.parse(incidentAt), dataRecoveredThroughMs: Date.parse(m.backupSnapshotAt), scope: "application", serviceRestoredAtMs: Date.parse(healthyAt) };
        if (measured.verdict !== "within_targets") refuse(`the recovery is not within the approved targets (RPO ${measured.rpoSeconds ?? "unmeasured"} s of 900, RTO ${measured.rtoSeconds ?? "unmeasured"} s of 14400)`);
        outcome = { complete: true, reason: `OPS-04 restore proven on AWS: a deploy waiting for its approval was captured in the backup and approved and applied after it; the stores were lost from the control-plane database and restored into it at recovery epoch ${report.epoch}; the restored proposal was fenced (an approval was refused: ${fencedApproval.refusal ?? "refused"}), did not execute on its own for ${Math.round(quietMs / 1000)} s, and came back only through a recovery resume (a stale binding was refused) and a fresh approval; applying it again left AWS unchanged (${after.length} buckets, ${afterResources} recorded resources). Measured RPO ${measured.rpoSeconds} s (target 900) and RTO ${measured.rtoSeconds} s (target 14400)` };
      } catch (error) {
        outcome = error instanceof Refusal
          ? { complete: false, reason: `OPS-04 not proven at ${step}: ${error.message}` }
          : { complete: false, reason: `OPS-04 not proven at ${step}: unexpected failure (details withheld; no completion claim)` };
      }
      let ops01: { complete: boolean; reason: string } = { complete: false, reason: `OPS-01 not measured: the OPS-04 run stopped at ${step}` };
      if (instants && probe && probes) {
        let at = "capacity";
        try {
          const capacity = await capacityBurst(probe, tick, burst.perSecond, burst.ms);
          // Enough probes that a run without failures can demonstrate every ratio target (95% one-sided bound).
          at = "probe count";
          const ratios = sloDefinitions().objectives.filter(o => o.id === "control_plane_availability" || o.id === "api_latency");
          const need = Math.ceil(Math.max(...ratios.map(o => samplesToDemonstrate((o as { target: number }).target))) * 1.05);
          for (const deadline = performance.now() + 10 * 60_000; probes.samples.length < need && performance.now() < deadline;) await tick(1_000);
          await probes.stop();
          at = "measurement";
          const result = measure({ reference: runId, controlPlane: { vantage: VANTAGE, samples: probes.samples }, restore: instants, capacity });
          const by = (id: string) => result.measurements.find(x => x.objective === id) ?? refuse(`the ${id} objective was not measured`);
          const availability = by("control_plane_availability") as RatioMeasurement, latency = by("api_latency") as RatioMeasurement;
          const cap = by("capacity"), rpo = by("rpo"), rto = by("rto");
          if (cap.kind !== "capacity" || rpo.kind !== "recovery_seconds" || rto.kind !== "recovery_seconds") refuse("the measurement kinds are unexpected");
          const cp = result.controlPlane!;
          const summary = `control-plane availability ${availability.good}/${availability.samples} probes non-5xx (${pct(availability.ratio)}, 95% lower bound ${pct(availability.lowerBound)} vs target ${pct(availability.target)}: ${availability.verdict}) from ${VANTAGE} probes of the API readiness route every 100 ms, paused only for the deliberate database loss (${probes.pausedSeconds()} s, measured as RTO); API latency p50 ${msText(cp.p50Ms)}, p95 ${msText(cp.p95Ms)}, p99 ${msText(cp.p99Ms)}, ${pct(latency.ratio)} within ${latency.thresholdMs} ms (lower bound ${pct(latency.lowerBound)} vs ${pct(latency.target)}: ${latency.verdict}); capacity ${cap.requestsPerSecond.toFixed(1)} req/s served of ${cap.offeredPerSecond} offered for ${Math.round(burst.ms / 1000)} s, p95 ${msText(cap.p95Ms)}, errors ${pct(cap.errorRate)} (targets >= ${cap.minRequestsPerSecond} req/s, p95 <= ${cap.maxP95Ms} ms, errors <= ${pct(cap.maxErrorRate)}: ${cap.verdict}); RPO ${rpo.valueSeconds} s of ${rpo.maxSeconds} and RTO ${rto.valueSeconds} s of ${rto.maxSeconds} (one restore observation each: ${rpo.verdict}, ${rto.verdict}); target file ${result.definitionVersion} (${result.targetApproval}), measurement label ${result.label}; not evaluated: ${result.notEvaluated.map(n => n.objective).join(", ") || "none"}`;
          const met = availability.verdict === "demonstrated" && latency.verdict === "demonstrated" && cap.verdict === "within_target" && rpo.verdict === "within_target" && rto.verdict === "within_target";
          ops01 = met ? { complete: true, reason: `OPS-01 objectives measured on the live sandbox run: ${summary}` } : { complete: false, reason: `OPS-01 not proven: ${summary}` };
        } catch (error) {
          ops01 = { complete: false, reason: `OPS-01 not proven at ${at}: ${error instanceof Refusal ? error.message : "unexpected failure (details withheld; no completion claim)"}` };
        }
      }
      await probes?.stop();
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
      // A leak is reported once (on OPS-04) and makes both incomplete.
      if (leaks.length) return { "PROD-OPS-04": { complete: false, reason: `${outcome.reason}; cleanup leaks: ${leaks.length} (see the cleanup checks)`, leaks }, "PROD-OPS-01": { complete: false, reason: `${ops01.reason}; cleanup leaks: ${leaks.length} (see the PROD-OPS-04 cleanup checks)`, leaks: [] } };
      return { "PROD-OPS-04": { ...outcome, leaks }, "PROD-OPS-01": { ...ops01, leaks: [] } };
  }
}
