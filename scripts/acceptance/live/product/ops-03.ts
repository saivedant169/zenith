/**
 * ProductScenarioPort for OPS-03 (live sandbox): a rolling upgrade and rollback of the runner's Zenith stack with an AWS
 * deploy in flight.
 *
 * Candidate API, worker and migration images are built first (ops-03-stack.ts). A deploy of one managed S3 bucket is then
 * approved and planned, and its workflow waits in flight for the apply approval. The stack is upgraded in runbook order
 * (expand migration, worker, API). The same Temporal run must still be waiting, with the review intact, and nothing in AWS.
 * The apply is approved on the candidate release: the same run completes and the bucket exists. The stack is rolled back
 * (API, then worker; the schema stays expanded) and a second deploy on the rolled-back release adds a second bucket.
 *
 * Limit: the candidates are rebuilt from the same source (no released N-1 exists yet), so this proves in-flight replacement
 * and rollback on AWS, not a previous-release compatibility matrix.
 *
 * Cleanup destroys exactly the recorded state and restores the sandbox trust, as OPS-04 does.
 */
import type { EnvLike } from "../../config";
import type { Call, Json, ProductScenarioPort } from "../contracts";
import { laneSuffix, liveRoleNames } from "../plan";
import type { Deploy01Product } from "./deploy-01-driver";
import { fill, parsePolicy, refuse, Refusal, templateExternalId, trustDocument } from "./mix-03";
import { runnerOps03Stack, type Ops03Stack } from "./ops-03-stack";
import { destroyFromState, readState, type SessionCredentials, type StateDestroyInput } from "./state-destroy";

type Invoke = (call: Call, values?: Record<string, string>, extra?: Record<string, Json>) => Promise<Record<string, unknown>>;
const EXTERNAL_ID_NEW = /^zenith-[0-9a-f]{32}$/;
const BUCKET = /^arn:aws:s3:::[a-z0-9.-]{3,63}$/;
const STATUS = /^[a-z_]{1,20}$/;
const field = (value: unknown, key: string): unknown => value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;

export function ops03Manifest(runId: string, buckets: 1 | 2): Record<string, unknown> {
  const name = (n: number) => `ops03-${runId.slice(-8).toLowerCase()}-${n}`;
  return { version: 1, services: [], routes: [], bindings: [],
    resources: [1, 2].slice(0, buckets).map(n => ({ id: `assets-${n}`, name: name(n), kind: "object_store", config: {}, size: "small", ownership: "managed" })) };
}

export interface Ops03Seams {
  product?: Deploy01Product;
  stack?: Ops03Stack;
  sleep?: (ms: number) => Promise<void>;
  propagation?: { attempts: number; intervalMs: number };
  state?: { destroy: (input: StateDestroyInput) => Promise<unknown> };
}

export function ops03Port(env: EnvLike = process.env, seams: Ops03Seams = {}): ProductScenarioPort {
  const product = seams.product ?? refuse("the OPS-03 browser driver is not wired");
  const sleep = seams.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const propagation = seams.propagation ?? { attempts: 12, intervalMs: 15_000 };
  const state = seams.state ?? { read: readState, destroy: destroyFromState };
  return {
    async verify(requirement, context) {
      if (requirement.id !== "PROD-OPS-03") return { complete: false, reason: `${requirement.id}: not implemented by this port` };
      return flow(context);
    },
  };

  async function flow({ plan, call }: Parameters<ProductScenarioPort["verify"]>[1]): Promise<{ complete: boolean; reason: string; leaks: string[] }> {
    const invoke: Invoke = (c, values = {}, extra = {}) => call(c, { ...fill(c.input, values), ...extra });
    const planned = (id: string): Call => plan.productCalls?.find(c => c.id === id) ?? refuse(`the plan has no call ${id}`);
    const account = plan.settings.accountId, region = plan.settings.region, runId = plan.settings.runId;
    const bootstrapNameSuffix = laneSuffix(plan.settings), names = liveRoleNames(bootstrapNameSuffix);
    const stateBucket = `zenith-state-${account}-${region}${bootstrapNameSuffix}`;
    const principal = `arn:aws:iam::${account}:role/${names.principal}`;
    const roleArns = { observe: `arn:aws:iam::${account}:role/${names.observe}`, deploy: `arn:aws:iam::${account}:role/${names.deploy}` };
    const tofu = env.ZENITH_TOFU_BIN?.trim() || "tofu";
    const trust: { role: "observe" | "deploy"; original: string; write: Call }[] = [];
    let externalId: string | undefined, workspaceId: string | undefined, environmentId: string | undefined, stack: Ops03Stack | undefined;
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
      if (result.status !== "succeeded") refuse(`the ${label} ended ${STATUS.test(result.status) ? result.status : "unknown"}, not succeeded${result.detail ? ` (product: ${result.detail})` : ""}`);
    };
    let step = "preconditions";
    let outcome: { complete: boolean; reason: string };
    try {
      if (env.ZENITH_LIVE_PRODUCT !== "1") refuse("ZENITH_LIVE_PRODUCT=1 is not set; no product scenario ran");
      if (plan.settings.scenario !== "ops-03" || !plan.productCalls?.length) refuse("the plan is not the ops-03 scenario");
      if (!product.proposeDeploy || !product.reviewDeploy || !product.completeDeploy || !product.operationStatus) refuse("the browser driver has no in-flight deploy path");
      stack = seams.stack ?? runnerOps03Stack(env, runId);
      step = "candidate images";
      const { previous, candidate } = await stack.candidates();
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
      environmentId = (await product.createEnvironment(tenant, { connectionId: connection.connectionId, region, name: `ops03-${runId.slice(-8).toLowerCase()}` })).environmentId;

      step = "deploy in flight";
      await product.setManifest(tenant, ops03Manifest(runId, 1));
      const { operationId, deploymentId } = await product.proposeDeploy(tenant, environmentId);
      const { round } = await product.reviewDeploy(tenant, environmentId, operationId, deploymentId);
      const before = await stack.history(operationId);
      if (!before.running || !before.runId) refuse("the deploy's workflow is not running while it waits for its apply approval");
      if ((await buckets()).length !== 0) refuse("a bucket exists before the apply was approved");

      step = "rolling upgrade";
      await stack.upgrade(candidate);
      step = "after the upgrade";
      const held = await product.operationStatus(tenant, operationId);
      if (held.status !== "awaiting_approval" || held.round !== round) refuse(`the review did not survive the upgrade (operation ${STATUS.test(held.status) ? held.status : "unknown"}, round ${held.round} of ${round})`);
      const upgraded = await stack.history(operationId);
      if (upgraded.runId !== before.runId || !upgraded.running) refuse("the upgrade did not keep the same running workflow history");
      if ((await buckets()).length !== 0) refuse("a bucket appeared during the upgrade, before the apply was approved");

      step = "apply on the candidate release";
      succeeded("in-flight deploy", await product.completeDeploy(tenant, operationId));
      const finished = await stack.history(operationId);
      if (finished.runId !== before.runId || !finished.completed) refuse("the deploy did not complete on the same workflow run it started on");
      const first = await buckets();
      if (first.length !== 1) refuse(`the in-flight deploy did not leave exactly one tagged bucket (${first.length})`);

      step = "rollback";
      await stack.rollback(previous);
      step = "deploy on the rolled-back release";
      await product.setManifest(tenant, ops03Manifest(runId, 2));
      succeeded("second deploy", await product.deploy(tenant, environmentId, "apply"));
      const second = await buckets();
      if (second.length !== 2 || !first.every(arn => second.includes(arn))) refuse(`the second deploy did not add exactly one bucket (${second.length})`);
      outcome = { complete: true, reason: `OPS-03 rolling upgrade and rollback proven on AWS: candidate API, worker and migration images were built and pushed to the stack's own registry; a deploy was approved and planned and its workflow waited in flight for the apply approval; the stack was upgraded in runbook order (expand migration, worker, then API, each healthy on its new image) while that workflow kept the same run and its review; the apply was approved on the candidate release and the same run completed with one bucket in AWS; the stack was rolled back (API, then worker, schema not downgraded) and a second deploy on the rolled-back release added the second bucket (2 tagged buckets). Candidates are rebuilt from the same source: replacement and rollback, not a released N-1/N matrix` };
    } catch (error) {
      outcome = error instanceof Refusal
        ? { complete: false, reason: `OPS-03 not proven at ${step}: ${error.message}` }
        : { complete: false, reason: `OPS-03 not proven at ${step}: unexpected failure (details withheld; no completion claim)` };
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
    return leaks.length ? { complete: false, reason: `${outcome.reason}; cleanup leaks: ${leaks.length} (see the cleanup checks)`, leaks } : { ...outcome, leaks };
  }
}
