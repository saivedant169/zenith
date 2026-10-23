/**
 * Connection administration lifecycle actions (PROD-LIFE-01): the GCP, Azure and
 * OCI creation verbs plus the provider-independent verify, revoke and rotate
 * verbs. AWS and Kubernetes keep their own create actions
 * (`connection.createAws`, `connection.createKubernetes`); these actions
 * complete the five verbs for every supported provider.
 *
 * Human only, like the existing connection onboarding actions: the Navigator and
 * integrations are refused (they are deliberately absent from the capability
 * bridge), and the member role is re-read live. The audit row comes from
 * `runAction`; the platform event comes from the store transaction itself.
 */
import { z } from "zod";
import { defineAction, type ActionContext, type ActionPlan, type ActionResult, type Role } from "@/lib/actions/core";
import { db } from "@/lib/db/store";
import { currentProductRoleResolver } from "@/lib/capabilities/current-product-roles";
import {
  abortRotation, createProviderConnection, describeConnection, HUMAN_REQUIRED_MESSAGE, LifecycleRefusal, previewRotation, promoteRotation, revokeConnection, rotateConnection, verifyAnyConnection,
  type CreateProviderInput,
} from "@/lib/connections/service";
import {
  ConnectionRef, CreateAzureInput, CreateGcpInput, CreateOciInput, CreateZenithInput, RevokeInput, RotateInput, RotationRef,
} from "@/lib/connections/schemas";

const RANK: Record<Role, number> = { viewer: 0, editor: 1, admin: 2 };

/** A real, current human member at or above `minimum`. Demo fallbacks and integrations cannot originate this. */
async function human(ctx: ActionContext, minimum: "editor" | "admin"): Promise<boolean> {
  if (ctx.actor.type !== "user" || ctx.integration) return false;
  const owning = db().members.filter((m) => m.workspaceId === ctx.workspaceId && m.id === ctx.actor.id);
  if (owning.length !== 1 || !db().workspaces.some((w) => w.id === ctx.workspaceId)) return false;
  if (!(owning[0].role in RANK) || RANK[owning[0].role] < RANK[minimum]) return false;
  try {
    const current = await currentProductRoleResolver().resolve({ kind: "user", id: ctx.actor.id, name: ctx.actor.name }, ctx.workspaceId);
    return current.role !== "none" && RANK[current.role] >= RANK[minimum];
  } catch { return false; }
}

const refused = (summary: string, error: string): ActionResult => ({ ok: false, summary, error });

async function guarded(ctx: ActionContext, minimum: "editor" | "admin", work: () => Promise<ActionResult>): Promise<ActionResult> {
  if (!(await human(ctx, minimum))) return refused("Connection action refused.", HUMAN_REQUIRED_MESSAGE);
  try { return await work(); }
  catch (error) {
    if (error instanceof LifecycleRefusal) return refused("Connection action refused.", error.message);
    return refused("Connection action could not be completed.", "The platform store or credential broker is unavailable. Restore it and retry.");
  }
}

const basePlan = (summary: string, details: string[], extra: Partial<ActionPlan> = {}): ActionPlan =>
  ({ summary, details, costDeltaUsd: 0, risk: "medium", warnings: [], requiresApproval: false, ...extra });

/* ---------------------------------- create --------------------------------- */

function createAction<S extends z.ZodTypeAny>(provider: "gcp" | "azure" | "oci" | "zenith", id: string, title: string, schema: S, details: string[]) {
  defineAction<z.infer<S>>({
    id, title, category: "connection", risk: "medium", requiredRole: "admin", mutates: true, input: schema as z.ZodType<z.infer<S>>,
    async plan(ctx) {
      return basePlan(`Save a pending ${provider.toUpperCase()} connection.`, [
        "Only identifiers are recorded. No cloud call and no verification run at creation.",
        ...details,
        "The connection deploys nothing until Verify passes; Zenith then shows exactly what the check did and did not prove.",
      ], !(await human(ctx, "admin")) ? { blocked: "A current human workspace admin is required." } : {});
    },
    async execute(ctx, input) {
      return guarded(ctx, "admin", async () => {
        const request = { provider, input } as CreateProviderInput;
        const made = await createProviderConnection(ctx, request);
        return { ok: true, summary: `${provider.toUpperCase()} connection saved; set up the trust, then verify it.`,
          data: { connectionId: made.connection.id, platformConnectionId: made.connection.id, status: made.connection.status, connection: made.connection, trust: made.trust } };
      });
    },
  });
}

createAction("gcp", "connection.createGcp", "Connect Google Cloud keylessly", CreateGcpInput, [
  "Zenith impersonates your observe and deploy service accounts through workload identity federation; it never holds a key.",
]);
createAction("azure", "connection.createAzure", "Connect Azure keylessly", CreateAzureInput, [
  "Zenith signs in as your federated application; it never holds a client secret.",
]);
createAction("zenith", "connection.createZenith", "Use the Zenith-managed platform", CreateZenithInput, [
  "Zenith operates the infrastructure for this connection, so nothing of yours is granted, stored or revoked: no role, key, token or trust.",
  "Environments on it run in per-environment namespaces on the managed cluster. Per-tenant isolation of that cluster is the operator's responsibility and is verified separately from this connection.",
]);
createAction("oci", "connection.createOci", "Connect OCI through a runner", CreateOciInput, [
  "OCI credentials never leave your tenancy: jobs run on your registered zenith-runner using its own principal.",
]);

/* ---------------------------------- verify --------------------------------- */

defineAction<ConnectionRef>({
  id: "connection.verify", title: "Verify connection", category: "connection", risk: "low", requiredRole: "editor", mutates: true, input: ConnectionRef,
  async plan(ctx, input) {
    const view = await describeConnection(ctx, input.connectionId);
    return basePlan(`Verify ${view.label} (${view.provider}).`, [
      ...(view.mode === "runner" ? ["Checks runner registration, heartbeat, protocol, advertised job kind and credential custody.", "A readiness pass does not prove cloud identity, connectivity or permissions."] : ["Read-only identity check with short-lived credentials; nothing in your cloud changes.", "A pass proves the observe identity only. Deploy permissions are never claimed."]),
      `Currently ${view.status}${view.verifiedAt ? `, last verified ${view.verifiedAt}` : ""}.`,
    ], { risk: "low", ...(view.status === "revoked" ? { blocked: "This connection is revoked. Revocation is terminal; create a new connection." } : {}) });
  },
  async execute(ctx, input) {
    return guarded(ctx, "editor", async () => {
      const out = await verifyAnyConnection(ctx, input.connectionId);
      return { ok: out.ok, summary: out.ok ? `Verified. ${out.scope}` : "Verification failed.", ...(out.ok ? {} : { error: out.detail }), data: { connectionId: out.connection.id, status: out.connection.status, detail: out.detail, scope: out.scope, connection: out.connection } };
    });
  },
});

/* ---------------------------------- revoke --------------------------------- */

function environmentsUsing(ctx: ActionContext, connectionId: string): string[] {
  const projects = new Map(db().projects.filter((p) => p.workspaceId === ctx.workspaceId).map((p) => [p.id, p.name]));
  return db().environments.filter((e) => e.connectionId === connectionId && projects.has(e.projectId)).map((e) => `${projects.get(e.projectId)}/${e.name}`);
}

defineAction<RevokeInput>({
  id: "connection.revoke", title: "Revoke connection", category: "connection", risk: "high", requiredRole: "admin", mutates: true, input: RevokeInput,
  async plan(ctx, input) {
    const view = await describeConnection(ctx, input.connectionId);
    const users = environmentsUsing(ctx, view.id);
    return basePlan(view.status === "revoked" ? `${view.label} is already revoked.` : `Revoke ${view.label} (${view.provider}).`, [
      "Takes effect immediately: the next deploy, observe or verify through this connection is refused. There is no fallback to another connection or to the sandbox.",
      "Revocation is terminal. To use this cloud again, create a new connection.",
      "Sessions Zenith already minted expire within their short lifetime; remove the trust in your cloud to end access at the source.",
      ...users.map((u) => `${u} deploys through this connection and will be unable to deploy until it is pointed at another one.`),
    ], { risk: "high", warnings: users.length ? [`${users.length} environment(s) will stop deploying.`] : [] });
  },
  async execute(ctx, input) {
    return guarded(ctx, "admin", async () => {
      const out = await revokeConnection(ctx, input);
      return { ok: true, summary: out.alreadyRevoked ? `${out.connection.label} was already revoked.` : `Revoked ${out.connection.label}. Zenith can no longer act through it.`, data: { connectionId: out.connection.id, status: out.connection.status, ...out } };
    });
  },
});

/* ---------------------------------- rotate --------------------------------- */

defineAction<RotateInput>({
  id: "connection.rotate", title: "Rotate connection access", category: "connection", risk: "medium", requiredRole: "admin", mutates: true, input: RotateInput,
  async plan(ctx, input) {
    const view = await describeConnection(ctx, input.connectionId);
    let blocked: string | undefined;
    let changing: string[] = [];
    try { changing = await previewRotation(ctx, input); }
    catch (error) { blocked = error instanceof LifecycleRefusal ? error.message : "The rotation could not be planned against the current connection."; }
    return basePlan(`Rotate access for ${view.label} (${view.provider}) without downtime.`, [
      `Stages a candidate that changes: ${Object.keys(input.patch).join(", ") || "nothing"}. The pinned identity (${Object.entries(view.identity).map(([k, v]) => `${k}=${v}`).join(", ")}) cannot change.`,
      "The candidate is verified under the same connection id and workload subject while the current access keeps serving.",
      input.promote ? "If it verifies it is promoted immediately in one guarded swap; if not, nothing changes." : "Nothing switches until you promote a verified candidate.",
      "A candidate that fails verification is never promoted.",
    ], { requiresApproval: true, ...(blocked ? { blocked } : {}), warnings: changing.length || blocked ? [] : ["Name at least one value to rotate."] });
  },
  async execute(ctx, input) {
    return guarded(ctx, "admin", async () => {
      const out = await rotateConnection(ctx, input);
      const summary = out.promoted ? "Rotated: the verified new access is live." : out.verified ? "Candidate verified; the current access is still serving." : "Candidate failed verification; the current access is unchanged.";
      return { ok: out.verified, summary, ...(out.verified ? {} : { error: out.detail }), data: { connectionId: out.connection.id, ...out } };
    });
  },
});

defineAction<RotationRef>({
  id: "connection.promoteRotation", title: "Promote verified rotation", category: "connection", risk: "medium", requiredRole: "admin", mutates: true, input: RotationRef,
  async plan(ctx, input) {
    const view = await describeConnection(ctx, input.connectionId);
    const open = view.rotation;
    const blocked = view.status === "revoked" ? "This connection is revoked." : !open || open.id !== input.rotationId ? "That rotation is not the open one for this connection." : open.status !== "verified" ? "The candidate has not passed verification; rotate again first." : undefined;
    return basePlan(`Switch ${view.label} to its verified new access.`, [
      `Swaps in the candidate (changes: ${open?.changes.join(", ") ?? "none"}) in one guarded transaction; refused if the connection changed or the verification is older than an hour.`,
      "The previous access stops being used at the swap. Remove it on the customer side afterwards.",
    ], { requiresApproval: true, ...(blocked ? { blocked } : {}) });
  },
  async execute(ctx, input) {
    return guarded(ctx, "admin", async () => {
      const out = await promoteRotation(ctx, input);
      return { ok: true, summary: "Promoted: the new access is live.", data: { connectionId: out.connection.id, ...out } };
    });
  },
});

defineAction<RotationRef>({
  id: "connection.abortRotation", title: "Discard staged rotation", category: "connection", risk: "low", requiredRole: "admin", mutates: true, input: RotationRef,
  async plan(ctx, input) {
    const view = await describeConnection(ctx, input.connectionId);
    return basePlan(`Discard the staged access for ${view.label}.`, ["The current access is untouched and keeps serving."], { risk: "low", requiresApproval: true,
      ...(!view.rotation || view.rotation.id !== input.rotationId ? { blocked: "That rotation is not open for this connection." } : {}) });
  },
  async execute(ctx, input) {
    return guarded(ctx, "admin", async () => {
      const out = await abortRotation(ctx, input);
      return { ok: true, summary: "Discarded the staged rotation. The current access is unchanged.", data: { connectionId: out.connection.id, ...out } };
    });
  },
});
