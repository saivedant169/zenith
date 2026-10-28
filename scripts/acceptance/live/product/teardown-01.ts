/**
 * ProductScenarioPort for TEARDOWN-01 (live sandbox): teardown after deploy, through the product's browser path.
 *
 * Zenith deploys one managed S3 bucket into a fresh AWS environment (two-person approval). The teardown review is then
 * refused while the deploy's earlier writers can still deliver (WP6), and becomes available once the execution worker has
 * settled them (WP3: about 80 minutes after the deploy's last write grant). The run then refreshes its one-hour OIDC session,
 * tears the environment down through env.reviewTeardown and every browser approval of the destroy, and reads back
 * independently that the recorded state holds no resource and no resource tagged with the environment remains.
 *
 * This port only (a) points the sandbox roles' trust at the run's ExternalId and restores it, (b) reads the environment's
 * recorded OpenTofu state as the connection's deploy role and the tagging inventory, and (c) cleans up with the recorded state
 * when the product teardown did not finish.
 */
import type { EnvLike } from "../../config";
import type { Call, Json, ProductScenarioPort } from "../contracts";
import { MIX03_ROLE_NAMES } from "../plan";
import type { Deploy01Product } from "./deploy-01-driver";
import { fill, parsePolicy, refuse, Refusal, templateExternalId, trustDocument } from "./mix-03";
import { refreshSandboxSession } from "./session-refresh";
import { destroyFromState, readState, type SessionCredentials, type StateDestroyInput } from "./state-destroy";

type Invoke = (call: Call, values?: Record<string, string>, extra?: Record<string, Json>) => Promise<Record<string, unknown>>;
const EXTERNAL_ID_NEW = /^zenith-[0-9a-f]{32}$/;
/** WP6's refusal while earlier deploy activity has not settled (src/lib/actions/defs/env.ts teardownSettlingMessage). */
export const SETTLING = "Earlier deploy activity has not settled yet.";

export function teardown01Manifest(runId: string): Record<string, unknown> {
  return { version: 1, services: [], routes: [], bindings: [],
    resources: [{ id: "assets", name: `teardown01-${runId.slice(-8).toLowerCase()}`, kind: "object_store", config: {}, size: "small", ownership: "managed" }] };
}

export interface Teardown01Seams {
  product?: Deploy01Product;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  propagation?: { attempts: number; intervalMs: number };
  /** Settlement wait: poll interval and bound. Default every 2 minutes for up to 110 minutes after the deploy. */
  settle?: { intervalMs: number; boundMs: number };
  refresh?: (env: EnvLike) => Promise<void>;
  state?: { read: (input: StateDestroyInput) => Promise<unknown>; destroy: (input: StateDestroyInput) => Promise<{ destroyed: number; destroyedArns?: string[]; destroyedIds?: string[] }> };
}

const field = (value: unknown, key: string): unknown => value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
/** Managed resources in a recorded OpenTofu state (data sources excluded). */
export function stateResources(state: unknown): number {
  const resources = field(state, "resources");
  return Array.isArray(resources) ? resources.filter(r => field(r, "mode") !== "data" && (field(r, "instances") as unknown[] | undefined)?.length).length : 0;
}

export function teardown01Port(env: EnvLike = process.env, seams: Teardown01Seams = {}): ProductScenarioPort {
  const product = seams.product ?? refuse("the TEARDOWN-01 browser driver is not wired");
  const sleep = seams.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const now = seams.now ?? Date.now;
  const propagation = seams.propagation ?? { attempts: 12, intervalMs: 15_000 };
  const settle = seams.settle ?? { intervalMs: 120_000, boundMs: 110 * 60_000 };
  const refresh = seams.refresh ?? refreshSandboxSession;
  const state = seams.state ?? { read: readState, destroy: destroyFromState };
  return {
    async verify(requirement, { plan, call }) {
      if (requirement.id !== "PROD-MIX-04") return { complete: false, reason: `${requirement.id}: not implemented by this port` };
      const invoke: Invoke = (c, values = {}, extra = {}) => call(c, { ...fill(c.input, values), ...extra });
      const planned = (id: string): Call => plan.productCalls?.find(c => c.id === id) ?? refuse(`the plan has no call ${id}`);
      const account = plan.settings.accountId, region = plan.settings.region, runId = plan.settings.runId;
      const principal = `arn:aws:iam::${account}:role/${MIX03_ROLE_NAMES.principal}`;
      const roleArns = { observe: `arn:aws:iam::${account}:role/${MIX03_ROLE_NAMES.observe}`, deploy: `arn:aws:iam::${account}:role/${MIX03_ROLE_NAMES.deploy}` };
      const bootstrapNameSuffix = "-live";
      const stateBucket = `zenith-state-${account}-${region}${bootstrapNameSuffix}`;
      const tofu = env.ZENITH_TOFU_BIN?.trim() || "tofu";
      const trust: { role: "observe" | "deploy"; original: string; write: Call }[] = [];
      let externalId: string | undefined, workspaceId: string | undefined, environmentId: string | undefined;
      let refreshed = false, tornDown = false;
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
      const tagged = async (): Promise<string[]> => {
        const out = await invoke(planned("teardown01-tag-read"), { environmentId: environmentId! });
        return ((field(out, "ResourceTagMappingList") as unknown[] | undefined) ?? []).map(r => String(field(r, "ResourceARN")));
      };
      const refreshOnce = async () => { if (!refreshed) { refreshed = true; await refresh(env); } };
      let step = "preconditions";
      let outcome: { complete: boolean; reason: string };
      try {
        if (env.ZENITH_LIVE_PRODUCT !== "1") refuse("ZENITH_LIVE_PRODUCT=1 is not set; no product scenario ran");
        if (plan.settings.scenario !== "teardown-01" || !plan.productCalls?.length) refuse("the plan is not the teardown-01 scenario");
        if (!product.teardown || !product.teardownBlocked) refuse("the browser driver has no teardown path");
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
        environmentId = (await product.createEnvironment(tenant, { connectionId: connection.connectionId, region, name: `teardown01-${runId.slice(-8).toLowerCase()}` })).environmentId;
        step = "deploy";
        await product.setManifest(tenant, teardown01Manifest(runId));
        const deployed = await product.deploy(tenant, environmentId, "apply");
        if (deployed.status !== "succeeded") refuse(`the deploy ended ${/^[a-z_]{1,20}$/.test(deployed.status) ? deployed.status : "unknown"}, not succeeded${deployed.detail ? ` (product: ${deployed.detail})` : ""}`);
        const deployedAt = now();
        step = "deploy readback";
        const recorded = stateResources(await state.read(await stateInput()));
        const bucketArns = (await tagged()).filter(arn => /^arn:aws:s3:::[a-z0-9.-]{3,63}$/.test(arn));
        if (recorded < 1 || bucketArns.length !== 1) refuse(`the deploy did not leave one tagged bucket in a non-empty recorded state (${recorded} recorded, ${bucketArns.length} tagged)`);
        step = "teardown refused while settling";
        const first = await product.teardownBlocked(tenant, environmentId);
        if (!first?.startsWith(SETTLING)) refuse(`the teardown review was not refused for unsettled deploy activity right after the deploy (${first ? "another refusal" : "no refusal"})`);
        step = "settlement wait";
        let waitedMs = 0, last: string | undefined = first;
        while (last?.startsWith(SETTLING)) {
          if (now() - deployedAt >= settle.boundMs) refuse(`the deploy's earlier writers did not settle within ${Math.round(settle.boundMs / 60_000)} minutes of the deploy`);
          await sleep(settle.intervalMs);
          last = await product.teardownBlocked(tenant, environmentId);
          waitedMs = now() - deployedAt;
        }
        if (last) refuse(`after settlement the teardown review was refused for another reason (product: ${last})`);
        step = "session refresh";
        await refreshOnce();
        step = "teardown";
        const torn = await product.teardown(tenant, environmentId);
        if (torn.status !== "succeeded") refuse(`the teardown ended ${/^[a-z_]{1,20}$/.test(torn.status) ? torn.status : "unknown"}, not succeeded${torn.detail ? ` (product: ${torn.detail})` : ""}`);
        tornDown = true;
        step = "teardown readback";
        const left = stateResources(await state.read(await stateInput()));
        if (left !== 0) refuse(`the recorded state still holds ${left} resource(s) after the teardown`);
        let remaining = await tagged();
        // The tagging index lags deletes: re-list a few times before calling anything a leftover.
        for (let attempt = 1; remaining.length && attempt < 4; attempt++) { await sleep(90_000); remaining = await tagged(); }
        if (remaining.length) refuse(`${remaining.length} resource(s) tagged with the environment remain after the teardown`);
        outcome = { complete: true, reason: `TEARDOWN-01 teardown after deploy proven on AWS: one managed S3 bucket deployed with two-person browser approval and read back from the recorded state and the tagging inventory; the teardown review was refused for unsettled deploy activity right after the deploy and became available ${Math.round(waitedMs / 60_000)} minutes after it, once the execution worker had settled every earlier writer; the destroy was reviewed and approved in the browser and succeeded; the recorded state is empty and no resource tagged with the environment remains` };
      } catch (error) {
        outcome = error instanceof Refusal
          ? { complete: false, reason: `TEARDOWN-01 not proven at ${step}: ${error.message}` }
          : { complete: false, reason: `TEARDOWN-01 not proven at ${step}: unexpected failure (details withheld; no completion claim)` };
      }
      const leaks: string[] = [];
      // Cleanup needs a live session: refresh once if the run did not already.
      try { await refreshOnce(); } catch (error) { leaks.push(error instanceof Refusal ? `session refresh before cleanup failed: ${error.message}` : "session refresh before cleanup failed"); }
      if (environmentId && externalId && !tornDown) {
        try { await state.destroy(await stateInput()); }
        catch (error) { leaks.push(error instanceof Error && /^(OpenTofu|\d+ resource|The recorded state)/.test(error.message) ? error.message : "state cleanup failed; resources may remain"); }
        try {
          let list: string[] = [];
          for (let attempt = 1; ; attempt++) {
            list = await tagged();
            if (!list.length || attempt >= 4) break;
            await sleep(90_000);
          }
          if (list.length) leaks.push(`${list.length} tagged resource(s) still present after cleanup`);
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
