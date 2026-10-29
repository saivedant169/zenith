"use client";
/**
 * Save identifiers first to obtain the exact per-connection trust, bootstrap
 * that trust in AWS, then verify the same saved config. Creation never implies
 * verification; observe-role identity does not prove deploy-role permissions.
 */
import { useRef, useState } from "react";
import { z } from "zod";
import type { ActionResult } from "@/lib/actions/core";
import { AwsConnectionSetup, type AwsConnectionInput, type AwsTrust } from "@/components/platform/aws-connection-setup";
import type { RoleName } from "@/components/platform/labels";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { browserMutation, mutationError } from "../../_lib/browser-api";

const Created = z.object({ connectionId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/), subject: z.string().max(300), issuerHost: z.string().max(300).optional(), externalId: z.string().max(100).optional() });
const roleArn = /^arn:(aws|aws-cn|aws-us-gov):iam::\d{12}:role\/[A-Za-z0-9+=,.@_/-]+$/;
const sameConfig = (a: AwsConnectionInput, b: AwsConnectionInput) => a.accountId === b.accountId && a.region === b.region && a.observeRoleArn === b.observeRoleArn && a.deployRoleArn === b.deployRoleArn && a.secretWriterRoleArn === b.secretWriterRoleArn && (a.bootstrapNameSuffix ?? "") === (b.bootstrapNameSuffix ?? "");

export function AwsConnectionFlow({ workspaceId, viewerRole }: { workspaceId: string; viewerRole: RoleName }) {
  const [mode, setMode] = useState<"oidc_web_identity" | "aws_assume_role">("oidc_web_identity");
  const [principalArn, setPrincipalArn] = useState("");
  return <div className="space-y-4">
    <label className="text-[13px]">Federation method<select value={mode} onChange={(event) => setMode(event.target.value as typeof mode)} className="ml-3 rounded-ctl border border-line bg-bg1 p-2"><option value="oidc_web_identity">OIDC web identity</option><option value="aws_assume_role">Zenith running on AWS (AssumeRole)</option></select></label>
    {mode === "aws_assume_role" && <label className="block space-y-2 text-[13px]">Zenith control-plane role ARN<Input value={principalArn} onChange={(event) => setPrincipalArn(event.target.value)} placeholder="arn:aws:iam::123456789012:role/ZenithControlPlane" /><span className="block text-[12px] text-ink-mute">Use the operator-provided IAM role of this control plane; never an access key.</span></label>}
    <ConnectionSetup key={mode} mode={mode} principalArn={principalArn} workspaceId={workspaceId} viewerRole={viewerRole} />
  </div>;
}

function ConnectionSetup({ workspaceId, viewerRole, mode, principalArn }: { workspaceId: string; viewerRole: RoleName; mode: "oidc_web_identity" | "aws_assume_role"; principalArn: string }) {
  const [draft, setDraft] = useState<AwsConnectionInput | null>(null);
  const [saved, setSaved] = useState<{ id: string; config: AwsConnectionInput; trust: AwsTrust }>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const inFlight = useRef(false);
  const key = useRef<string | undefined>(undefined);
  const validPrincipal = mode !== "aws_assume_role" || roleArn.test(principalArn);
  const unchanged = Boolean(saved && draft && sameConfig(saved.config, draft) && (saved.trust.mode !== "aws_assume_role" || saved.trust.zenithPrincipalArn === principalArn));
  const blocked = viewerRole !== "admin" ? "Only a workspace admin can create an AWS connection." : !validPrincipal ? "Enter the operator-provided control-plane role ARN." : !draft ? "Enter a valid account, region and both role ARNs first." : unchanged ? "These identifiers are already saved. Bootstrap the trust below, then verify." : undefined;
  const create = async () => {
    if (blocked || !draft || inFlight.current) return;
    inFlight.current = true; setPending(true); setError(undefined);
    key.current ??= crypto.randomUUID();
    try {
      const response = await browserMutation<{ result: ActionResult }>(workspaceId, "/platform/connections/aws/action", {
        actionId: "connection.createAws", idempotencyKey: key.current,
        input: { accountId: draft.accountId, region: draft.region, observeRoleArn: draft.observeRoleArn, deployRoleArn: draft.deployRoleArn, ...(draft.secretWriterRoleArn ? { secretWriterRoleArn: draft.secretWriterRoleArn } : {}), bootstrapNameSuffix: draft.bootstrapNameSuffix ?? "", mode },
      });
      if (!response.result.ok) throw new Error("Creation refused");
      const created = Created.parse(response.result.data);
      let trust: AwsTrust;
      if (mode === "oidc_web_identity") {
        if (!created.issuerHost || created.subject !== `zenith:ws:${workspaceId}:conn:${created.connectionId}`) throw new Error("Trust unavailable");
        trust = { mode, issuerHost: created.issuerHost, oidcSubject: created.subject, bootstrapNameSuffix: draft.bootstrapNameSuffix ?? "" };
      } else {
        if (!created.externalId) throw new Error("Trust unavailable");
        trust = { mode, zenithPrincipalArn: principalArn, externalId: created.externalId, bootstrapNameSuffix: draft.bootstrapNameSuffix ?? "" };
      }
      setSaved({ id: created.connectionId, config: draft, trust });
    } catch (failure) { setError(`${mutationError(failure)} Check the platform connection store and OIDC issuer configuration.`); }
    finally { inFlight.current = false; setPending(false); }
  };
  const verifyBlocked = !saved ? "Save the connection identifiers first, then bootstrap the generated trust in AWS." : !unchanged ? "These inputs differ from the saved connection. Save a new connection before verifying." : viewerRole === "viewer" || viewerRole === "none" ? "An editor or admin must verify the connection." : undefined;
  return <div className="space-y-4">
    <p className="text-[13px] text-ink-mute">Enter the account and planned role ARNs, save them to generate the exact trust values, deploy the bootstrap template with those values, then verify. Creating this connection performs no live AWS check.</p>
    <Button onClick={() => void create()} busy={pending} disabled={Boolean(blocked)} disabledReason={blocked}>{saved ? "Save new connection identifiers" : "Save connection identifiers"}</Button>
    {blocked && <p className="text-[12px] text-ink-mute">{blocked}</p>}
    {error && <Callout tone="err">{error}</Callout>}
    {saved && <Callout tone="info">Saved connection {saved.id}. Observe and deploy roles remain unverified until the identity check below; deploy-role permissions remain unverified even after it succeeds.</Callout>}
    <AwsConnectionSetup trust={saved?.trust} verifyDisabledReason={pending ? "Wait for the connection to finish saving." : verifyBlocked} onConfigChange={(config) => { setDraft(config); key.current = undefined; }} onVerify={async (config) => {
      if (!saved || !sameConfig(saved.config, config) || verifyBlocked) return { ok: false, detail: verifyBlocked ?? "Save this configuration before verifying." };
      try {
        const response = await browserMutation<{ result: ActionResult }>(workspaceId, "/platform/connections/aws/action", { actionId: "connection.verifyAws", input: { connectionId: saved.id } });
        return { ok: response.result.ok, detail: response.result.ok ? "Observe-role identity verified. Deploy-role permissions and worker health remain unverified." : "Observe-role identity could not be verified. Check the bootstrap trust, role ARNs and credential broker, then retry." };
      } catch (failure) { throw new Error(mutationError(failure)); }
    }} />
  </div>;
}
