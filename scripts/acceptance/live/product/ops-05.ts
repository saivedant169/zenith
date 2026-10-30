/**
 * ProductScenarioPort for OPS-05 (live sandbox): purpose-separated key custody through a full rotation, with real AWS customer state.
 *
 * Zenith stores one vault secret and deploys one managed S3 bucket under the installation's first keys. Every generated key is
 * then rotated (scripts/deploy/installation.mjs rotateKeys) and the API and worker are recreated together from the rotated
 * configuration. The operator commands (scripts/key-custody.ts, the same entry point the CLI runs) then show:
 *  - diagnose: every rotated purpose has a new current key and keeps the old one decrypt-only (vault, Temporal, plan artifacts,
 *    results, machine results) or verify-only (control and OIDC signing); no error finding; Temporal and results have their own roots;
 *  - codec: the first deploy's Temporal history needs only the now decrypt-only key and every payload still decrypts;
 *  - the AWS connection still verifies, and a second bucket deploys under the new keys (its history uses only the new key);
 *  - rewrap: the vault secret is re-wrapped under the new vault key (the job completes, nothing unreadable).
 * No operator output contains any key value, old or new.
 *
 * Cleanup destroys exactly the recorded state (state-destroy.ts) and restores the sandbox trust, as OPS-04 does.
 */
import { randomBytes } from "node:crypto";
import type { EnvLike } from "../../config";
import type { Call, Json, ProductScenarioPort } from "../contracts";
import { laneSuffix, liveRoleNames } from "../plan";
import type { Deploy01Product } from "./deploy-01-driver";
import { fill, parsePolicy, refuse, Refusal, templateExternalId, trustDocument } from "./mix-03";
import { runnerOps05Stack, type Ops05Stack } from "./ops-05-stack";
import { destroyFromState, readState, type SessionCredentials, type StateDestroyInput } from "./state-destroy";
import { keyCustodyMain } from "../../../key-custody";

type Invoke = (call: Call, values?: Record<string, string>, extra?: Record<string, Json>) => Promise<Record<string, unknown>>;
const EXTERNAL_ID_NEW = /^zenith-[0-9a-f]{32}$/;
export const OPS05_SECRET_KEY = "ZENITH_OPS05_CANARY";
/** The purposes an installation rotation gives a new current key, and the role its old key keeps. */
export const ROTATED: Readonly<Record<string, "decrypt_only" | "verify_only">> = {
  "enc:vault": "decrypt_only", "enc:temporal-payload": "decrypt_only", "enc:plan-artifacts": "decrypt_only", "enc:results": "decrypt_only",
  "enc:machine-results": "decrypt_only", "signing:jobs": "verify_only", "signing:oidc": "verify_only",
};

export function ops05Manifest(runId: string, buckets: 1 | 2, withSecretHolder = false): Record<string, unknown> {
  const name = (n: number) => `ops05-${runId.slice(-8).toLowerCase()}-${n}`;
  return { version: 1, routes: [], bindings: [],
    // The service exists only while the vault secret is set; it is never deployed.
    services: withSecretHolder ? [{ id: "web", name: "web", kind: "web", source: { type: "image", image: "public.ecr.aws/nginx/nginx:stable" }, size: "nano", replicas: 1, port: 80, healthPath: "/" }] : [],
    resources: [1, 2].slice(0, buckets).map(n => ({ id: `assets-${n}`, name: name(n), kind: "object_store", config: {}, size: "small", ownership: "managed" })) };
}

/** One operator command: exit code and its output lines. */
export type Custody = (args: string[], keys: Record<string, string>) => Promise<{ code: number; out: string[]; err: string[] }>;

export interface Ops05Seams {
  product?: Deploy01Product;
  stack?: Ops05Stack;
  custody?: Custody;
  sleep?: (ms: number) => Promise<void>;
  propagation?: { attempts: number; intervalMs: number };
  /** How long the vault re-wrap may take to complete (the CLI runs it, or the worker's critical job does). */
  rewrapMs?: number;
  state?: { read: (input: StateDestroyInput) => Promise<unknown>; destroy: (input: StateDestroyInput) => Promise<{ destroyed: number; destroyedArns?: string[]; destroyedIds?: string[] }> };
}

const field = (value: unknown, key: string): unknown => value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
const BUCKET = /^arn:aws:s3:::[a-z0-9.-]{3,63}$/;

/** The operator CLI in this process, with the stack's database and the installation's current keys. */
export function runnerCustody(env: EnvLike): Custody {
  return async (args, keys) => {
    const out: string[] = [], err: string[] = [];
    const code = await keyCustodyMain(args, line => { out.push(line); }, line => { err.push(line); },
      { ...env, ZENITH_STORE: "postgres", ZENITH_PLATFORM_DB: "postgres", ...keys });
    return { code, out, err };
  };
}

interface Report { purposes: { purpose: string; currentKeyId?: string }[]; entries: { purpose: string; keyId: string; role: string }[]; violations: { severity: string; code: string; purposes: string[] }[] }
interface Codec { total: number; byStatus: Record<string, number>; byKeyId: Record<string, number>; verified?: { ok: number; failed: number } }

export function ops05Port(env: EnvLike = process.env, seams: Ops05Seams = {}): ProductScenarioPort {
  const product = seams.product ?? refuse("the OPS-05 browser driver is not wired");
  const sleep = seams.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const propagation = seams.propagation ?? { attempts: 12, intervalMs: 15_000 };
  const rewrapMs = seams.rewrapMs ?? 600_000;
  const state = seams.state ?? { read: readState, destroy: destroyFromState };
  const custody = seams.custody ?? runnerCustody(env);
  return {
    async verify(requirement, { plan, call }) {
      if (requirement.id !== "PROD-OPS-05") return { complete: false, reason: `${requirement.id}: not implemented by this port` };
      const invoke: Invoke = (c, values = {}, extra = {}) => call(c, { ...fill(c.input, values), ...extra });
      const planned = (id: string): Call => plan.productCalls?.find(c => c.id === id) ?? refuse(`the plan has no call ${id}`);
      const account = plan.settings.accountId, region = plan.settings.region, runId = plan.settings.runId;
      const bootstrapNameSuffix = laneSuffix(plan.settings), names = liveRoleNames(bootstrapNameSuffix);
      const stateBucket = `zenith-state-${account}-${region}${bootstrapNameSuffix}`;
      const principal = `arn:aws:iam::${account}:role/${names.principal}`;
      const roleArns = { observe: `arn:aws:iam::${account}:role/${names.observe}`, deploy: `arn:aws:iam::${account}:role/${names.deploy}` };
      const tofu = env.ZENITH_TOFU_BIN?.trim() || "tofu";
      const trust: { role: "observe" | "deploy"; original: string; write: Call }[] = [];
      let externalId: string | undefined, workspaceId: string | undefined, environmentId: string | undefined, stack: Ops05Stack | undefined;
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
      /** An operator command; refused when it fails or prints any key value seen so far. */
      const operator = async (label: string, args: string[], allowFailure = false) => {
        const result = await custody(args, stack!.keys());
        const printed = [...result.out, ...result.err].join("\n");
        if (stack!.secrets().some(value => printed.includes(value))) refuse(`key-custody ${label} printed key material`);
        if (result.code !== 0 && !allowFailure) refuse(`key-custody ${label} exited ${result.code}${result.err[0] && /^[A-Za-z0-9 ,.;:()'_-]{1,200}$/.test(result.err[0]) ? ` (${result.err[0]})` : ""}`);
        return result;
      };
      const json = <T>(label: string, lines: string[]): T => {
        try { return JSON.parse(lines.join("\n")) as T; } catch { return refuse(`key-custody ${label} did not print one JSON document`); }
      };
      const diagnose = async (label: string) => {
        await operator(`sync (${label})`, ["sync"]);
        return json<Report>(`diagnose (${label})`, (await operator(`diagnose (${label})`, ["diagnose", "--json"])).out);
      };
      const codec = async (label: string, file: string) => json<Codec>(`codec (${label})`, (await operator(`codec (${label})`, ["codec", "--file", file, "--verify", "--json"])).out);
      let step = "preconditions";
      let outcome: { complete: boolean; reason: string };
      try {
        if (env.ZENITH_LIVE_PRODUCT !== "1") refuse("ZENITH_LIVE_PRODUCT=1 is not set; no product scenario ran");
        if (plan.settings.scenario !== "ops-05" || !plan.productCalls?.length) refuse("the plan is not the ops-05 scenario");
        if (!product.setSecret) refuse("the browser driver has no secret path");
        stack = seams.stack ?? runnerOps05Stack(env, runId);
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
        const verifyConnection = async (label: string) => {
          for (let attempt = 1; ; attempt++) {
            const verified = await product.verifyAws(tenant, connection.connectionId);
            if (verified.ok) return;
            if (attempt >= propagation.attempts) refuse(`connection.verifyAws did not pass ${label} within the propagation bound${verified.why ?? ""}`);
            await sleep(propagation.intervalMs);
          }
        };
        step = "connection verification";
        await verifyConnection("after the trust update");
        step = "environment";
        environmentId = (await product.createEnvironment(tenant, { connectionId: connection.connectionId, region, name: `ops05-${runId.slice(-8).toLowerCase()}` })).environmentId;

        step = "vault secret before rotation";
        await product.setManifest(tenant, ops05Manifest(runId, 1, true));
        await product.setSecret(tenant, { serviceId: "web", key: OPS05_SECRET_KEY, secretValue: randomBytes(24).toString("hex") });
        await product.setManifest(tenant, ops05Manifest(runId, 1));
        step = "first deploy";
        const first = await product.deploy(tenant, environmentId, "apply");
        succeeded("first deploy", first);
        const firstHistory = await stack.history(first.operationId, "first");
        const firstCodec = await codec("first deploy", firstHistory);
        if (!firstCodec.byStatus.current_key || firstCodec.byStatus.decrypt_only_key || firstCodec.byStatus.key_unavailable) refuse("the first deploy's history is not written under the first Temporal key alone");
        const before = await diagnose("before rotation");
        const was = Object.fromEntries(Object.keys(ROTATED).map(p => [p, before.purposes.find(s => s.purpose === p)?.currentKeyId ?? refuse(`${p} has no current key before rotation`)]));

        step = "rotation";
        await stack.rotate();
        step = "diagnose after rotation";
        const after = await diagnose("after rotation");
        for (const [purpose, role] of Object.entries(ROTATED)) {
          const now = after.purposes.find(s => s.purpose === purpose)?.currentKeyId;
          if (!now || now === was[purpose]) refuse(`${purpose} has no new current key after rotation`);
          if (after.entries.find(e => e.purpose === purpose && e.keyId === was[purpose])?.role !== role) refuse(`${purpose} did not keep its old key ${role.replace("_", "-")}`);
        }
        if (after.violations.some(v => v.severity === "error")) refuse(`the rotated keys have error findings (${after.violations.filter(v => v.severity === "error").map(v => v.code).join(", ")})`);
        if (after.violations.some(v => v.code === "result_key_derived_from_signing_key" || v.purposes.includes("enc:temporal-payload"))) refuse("results or Temporal payloads still share a root after rotation");
        step = "connection after rotation";
        await verifyConnection("after the rotation");
        step = "first history after rotation";
        const oldCodec = await codec("first history", firstHistory);
        if (oldCodec.byStatus.decrypt_only_key !== firstCodec.byStatus.current_key || oldCodec.byStatus.key_unavailable || oldCodec.byStatus.current_key) refuse("the first deploy's history does not need exactly the now decrypt-only Temporal key");
        if (!oldCodec.verified || oldCodec.verified.failed || !oldCodec.verified.ok) refuse("the first deploy's history does not decrypt under the decrypt-only key");

        step = "second deploy";
        await product.setManifest(tenant, ops05Manifest(runId, 2));
        const second = await product.deploy(tenant, environmentId, "apply");
        succeeded("second deploy", second);
        if ((await buckets()).length !== 2) refuse("the second deploy did not leave two tagged buckets");
        const newCodec = await codec("second deploy", await stack.history(second.operationId, "second"));
        const temporalNow = after.purposes.find(s => s.purpose === "enc:temporal-payload")!.currentKeyId!;
        if (!newCodec.byStatus.current_key || newCodec.byStatus.decrypt_only_key || Object.keys(newCodec.byKeyId).join() !== temporalNow || !newCodec.verified?.ok || newCodec.verified.failed) refuse("the second deploy's history is not written under the new Temporal key alone");

        step = "vault re-wrap";
        await operator("rewrap", ["rewrap", "--workspace", workspaceId, "--run"], true);
        let job: { status?: string; inspected?: number; rewrapped?: number; errorCode?: string | null } | undefined;
        for (const deadline = Date.now() + rewrapMs; ;) {
          const lines = (await operator("rewrap-status", ["rewrap-status", "--workspace", workspaceId])).out.filter(l => l.startsWith("{"));
          job = lines.length ? json<typeof job>("rewrap-status", [lines[lines.length - 1]!]) : undefined;
          if (job?.status === "completed" || job?.status === "failed" || job?.status === "blocked" || Date.now() >= deadline) break;
          await sleep(15_000);
        }
        if (job?.status !== "completed") refuse(`the vault re-wrap did not complete (${job?.status && /^[a-z]{1,20}$/.test(job.status) ? job.status : "no job"}${job?.errorCode && /^[a-z_]{1,40}$/.test(job.errorCode) ? `: ${job.errorCode}` : ""})`);
        if (!job.rewrapped) refuse("the vault re-wrap re-sealed no secret");
        outcome = { complete: true, reason: `OPS-05 key custody proven on AWS: one vault secret and one managed S3 bucket under the first keys; every generated key rotated (${Object.keys(ROTATED).length} purposes) and the API and worker recreated together; diagnose showed a new current key per purpose with the old one decrypt-only or verify-only, no error finding, and Temporal and results on their own roots; the first deploy's history (${oldCodec.total} payloads) needed only the decrypt-only Temporal key and decrypted (${oldCodec.verified.ok} ok); the AWS connection verified and a second bucket deployed under the new keys (history on the new key only); the vault re-wrap completed (${job.rewrapped} re-sealed); no operator output contained key material` };
      } catch (error) {
        outcome = error instanceof Refusal
          ? { complete: false, reason: `OPS-05 not proven at ${step}: ${error.message}` }
          : { complete: false, reason: `OPS-05 not proven at ${step}: unexpected failure (details withheld; no completion claim)` };
      }
      const leaks: string[] = [];
      try { await stack?.close(); } catch { leaks.push("the stack could not be released"); }
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
