"use client";
/**
 * Connect an AWS account without handing Zenith a key.
 *
 * The flow is four steps on one surface:
 *   1. create the roles by deploying the CloudFormation template, pasting the
 *      trust values Zenith shows (the OIDC subject, or the ExternalId);
 *   2. understand the two roles (observe is read-only, deploy is fenced);
 *   3. tell Zenith the account, region and the two role ARNs;
 *   4. verify, and read the result.
 *
 * What this surface promises and enforces:
 *  - there is no access-key or secret field anywhere, the copy says so, and a
 *    pasted access key is refused without being echoed back;
 *  - ARNs, account id and region are validated against patterns, and a role in a
 *    different account than the one entered is caught before any call;
 *  - "Verify connection" is disabled until the form is valid and says why;
 *  - the verification result is shown exactly as the callback reports it (success
 *    detail, failure detail, or the thrown message) and is cleared as soon as an
 *    input changes, because a result for other inputs is not a result for these.
 * It performs no network call itself: the host supplies `onVerify`.
 */
import { useId, useRef, useState } from "react";
import type { AwsConnectionConfig } from "@/lib/credentials/types";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card } from "@/components/ui/card";
import { CopyButton } from "@/components/ui/copy-button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SurfaceGate, type AsyncSurfaceProps } from "./async-gate";
import {
  CFN_TEMPLATE_PATH,
  TOFU_MODULE_PATH,
  validateAwsForm,
  type AwsFormValues,
} from "./aws-connection-validation";

/** What Zenith shows the customer to paste into the template, per federation path. */
export type AwsTrust =
  | {
      mode: "oidc_web_identity";
      bootstrapNameSuffix?: string;
      /** the Zenith OIDC issuer host and path, without https:// */
      issuerHost: string;
      /** zenith:ws:<workspace>:conn:<connection> */
      oidcSubject: string;
    }
  | {
      mode: "aws_assume_role";
      bootstrapNameSuffix?: string;
      /** only for a Zenith control plane that itself runs on AWS */
      zenithPrincipalArn: string;
      /** per-connection, Zenith-generated; a confused-deputy guard, not a password */
      externalId: string;
    };

export type AwsConnectionInput = Pick<AwsConnectionConfig, "provider" | "accountId" | "observeRoleArn" | "deployRoleArn" | "region" | "bootstrapNameSuffix"> & {
  mode: "oidc_web_identity" | "aws_assume_role";
  externalId?: string;
};

/** Same shape the credential broker's `verifyConnection` returns. */
export interface AwsVerifyResult {
  ok: boolean;
  detail: string;
  accountId?: string;
}

export interface AwsConnectionSetupProps extends AsyncSurfaceProps {
  /** Optional host gate, e.g. identifiers must be saved before verification. */
  verifyDisabledReason?: string;
  /** the values to paste into the template; without them step 1 cannot be completed */
  trust?: AwsTrust;
  initialValues?: Partial<AwsFormValues>;
  /** called with the connection config; may be async. Throwing is shown as a failure. */
  onVerify: (config: AwsConnectionInput) => Promise<AwsVerifyResult> | AwsVerifyResult;
  /** called whenever the validated config changes (null while the form is invalid) */
  onConfigChange?: (config: AwsConnectionInput | null) => void;
  /** override the template path shown; defaults to the repository's bootstrap template */
  templatePath?: string;
}

function CopyRow({ name, value, note }: { name: string; value?: string; note: string }) {
  return (
    <tr className="border-t border-line align-top">
      <th scope="row" className="py-2.5 pr-4 text-left font-normal">
        <code className="font-mono text-[12.5px] text-ink">{name}</code>
      </th>
      <td className="py-2.5 pr-4 text-[12.5px] text-ink-mute">{note}</td>
      <td className="py-2.5">
        {value !== undefined ? (
          <span className="inline-flex items-center gap-1">
            <code className="break-all font-mono text-[12px] text-ink">{value || "(empty)"}</code>
            {value && <CopyButton value={value} what={name} />}
          </span>
        ) : (
          <span className="text-[12.5px] text-ink-faint">Your choice</span>
        )}
      </td>
    </tr>
  );
}

function ParameterTable({ trust, bootstrapNameSuffix }: { trust?: AwsTrust; bootstrapNameSuffix: string }) {
  return (
    <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="CloudFormation parameters">
      <table className="w-full min-w-[640px] table-fixed border-collapse text-left">
        <caption className="sr-only">CloudFormation parameters and the values to enter</caption>
        <thead>
          <tr className="text-[12px] text-ink-mute">
            <th scope="col" className="w-[22%] py-1.5 pr-4 font-medium">
              Parameter
            </th>
            <th scope="col" className="w-[36%] py-1.5 pr-4 font-medium">
              What it does
            </th>
            <th scope="col" className="w-[42%] py-1.5 font-medium">
              Value to enter
            </th>
          </tr>
        </thead>
        <tbody>
          {trust?.mode === "oidc_web_identity" && (
            <>
              <CopyRow
                name="ZenithIssuerHost"
                value={trust.issuerHost}
                note="Zenith's OpenID Connect issuer, without https://. The roles trust tokens from this issuer only."
              />
              <CopyRow
                name="ZenithOidcSubject"
                value={trust.oidcSubject}
                note="The exact token subject for this workspace and connection. Only a token with this subject can assume the roles."
              />
              <CopyRow
                name="CreateOidcProvider"
                value="yes"
                note='Enter "no" instead if this account already has a provider for this issuer, for example from another Zenith workspace.'
              />
            </>
          )}
          {trust?.mode === "aws_assume_role" && (
            <>
              <CopyRow
                name="ZenithPrincipalArn"
                value={trust.zenithPrincipalArn}
                note="The Zenith principal allowed to assume the roles. Only used when Zenith itself runs on AWS."
              />
              <CopyRow
                name="ExternalId"
                value={trust.externalId}
                note="Generated for this connection. Paste it unchanged: it stops another Zenith customer from using your role. It is not a password."
              />
            </>
          )}
          {!trust && (
            <tr className="border-t border-line">
              <td colSpan={3} className="py-2.5 text-[12.5px] text-ink-mute">
                Zenith has not generated the trust values for this connection yet, so there is nothing to paste.
              </td>
            </tr>
          )}
          <CopyRow
            name="EnvironmentTagValue"
            note='"*" lets the deploy role manage any Zenith environment in this account. Enter one environment id to confine it to that environment.'
          />
          <CopyRow name="NameSuffix" value={bootstrapNameSuffix} note="Use the exact suffix saved with this connection, such as -team-a. For an empty suffix, leave the stack parameter empty." />
          <CopyRow
            name="Route53HostedZoneArns"
            note="The hosted zones Zenith may change DNS records in. Leave it empty to give Zenith no DNS write access."
          />
          <CopyRow name="StateBucketKmsKeyArn" note="Optional customer-managed KMS key for the OpenTofu state bucket. Leave it empty to use default encryption." />
        </tbody>
      </table>
    </div>
  );
}

export function AwsConnectionSetup({
  trust,
  initialValues,
  onVerify,
  onConfigChange,
  templatePath = CFN_TEMPLATE_PATH,
  loading,
  error,
  onRetry,
  verifyDisabledReason,
}: AwsConnectionSetupProps) {
  const ids = useId();
  const [values, setValues] = useState<AwsFormValues>({
    accountId: initialValues?.accountId ?? "",
    region: initialValues?.region ?? "",
    observeRoleArn: initialValues?.observeRoleArn ?? "",
    deployRoleArn: initialValues?.deployRoleArn ?? "",
    bootstrapNameSuffix: initialValues?.bootstrapNameSuffix ?? "",
  });
  const [touched, setTouched] = useState<Partial<Record<keyof AwsFormValues, boolean>>>({});
  const [verifying, setVerifying] = useState(false);
  const [result, setResult] = useState<{ kind: "ok" | "fail" | "threw"; detail: string; accountId?: string } | null>(null);
  const inflight = useRef(false);

  const validation = validateAwsForm(values);
  const mode = trust?.mode ?? "oidc_web_identity";
  const toInput = (v: AwsFormValues): AwsConnectionInput => ({
    provider: "aws",
    mode,
    accountId: v.accountId.trim(),
    region: v.region.trim(),
    observeRoleArn: v.observeRoleArn.trim(),
    deployRoleArn: v.deployRoleArn.trim(),
    bootstrapNameSuffix: v.bootstrapNameSuffix ?? "",
    ...(trust?.mode === "aws_assume_role" ? { externalId: trust.externalId } : {}),
  });

  const change = (key: keyof AwsFormValues, value: string) => {
    const next = { ...values, [key]: value };
    setValues(next);
    setResult(null); // a result for other inputs is not a result for these
    onConfigChange?.(validateAwsForm(next).valid ? toInput(next) : null);
  };
  const blur = (key: keyof AwsFormValues) => setTouched((t) => ({ ...t, [key]: true }));
  const shown = (key: keyof AwsFormValues) => (touched[key] ? validation.errors[key] : undefined);

  const verify = async () => {
    if (!validation.valid || inflight.current || verifyDisabledReason) return;
    inflight.current = true;
    setVerifying(true);
    setResult(null);
    try {
      const r = await onVerify(toInput(values));
      setResult({ kind: r.ok ? "ok" : "fail", detail: r.detail, accountId: r.accountId });
    } catch (e) {
      setResult({ kind: "threw", detail: e instanceof Error && e.message ? e.message : "The verification request failed before Zenith got an answer." });
    } finally {
      inflight.current = false;
      setVerifying(false);
    }
  };

  const verifyBlocked = verifyDisabledReason ?? (validation.valid
    ? undefined
    : "Fill in the account, region and both role ARNs correctly before verifying.");
  const hintId = `${ids}-verify-hint`;
  const accountMismatch =
    result?.kind === "ok" && result.accountId !== undefined && result.accountId !== values.accountId.trim();

  return (
    <Card
      title="Connect an AWS account"
      subtitle="Zenith connects through roles in your account. It never asks for access keys or secrets."
    >
      <SurfaceGate loading={loading} error={error} onRetry={onRetry} what="the connection details" rows={4}>
        <div className="space-y-8">
          <section aria-label="Create the roles" className="space-y-3">
            <h4 className="text-[14px] font-medium text-ink">1. Create the roles in your account</h4>
            <p className="text-[13px] text-ink-mute">
              Deploy the CloudFormation template <code className="font-mono text-[12.5px] text-ink">{templatePath}</code> as a stack in the AWS account you want to
              connect. An equivalent OpenTofu module is in <code className="font-mono text-[12.5px] text-ink">{TOFU_MODULE_PATH}</code>. Enter these parameters:
            </p>
            <ParameterTable trust={trust} bootstrapNameSuffix={trust?.bootstrapNameSuffix ?? (validation.errors.bootstrapNameSuffix ? "" : values.bootstrapNameSuffix ?? "")} />
            <p className="text-[12.5px] text-ink-mute">
              When the stack finishes, copy the <code className="font-mono">ObserveRoleArn</code> and <code className="font-mono">DeployRoleArn</code> outputs into
              step 3. Deleting the stack revokes Zenith&apos;s access.
            </p>
          </section>

          <section aria-label="The two roles" className="space-y-3">
            <h4 className="text-[14px] font-medium text-ink">2. Two roles, two jobs</h4>
            <dl className="grid gap-3 md:grid-cols-2">
              <div className="rounded-card border border-line bg-bg2 p-4">
                <dt className="text-[13px] font-medium text-ink">Observe role</dt>
                <dd className="mt-1 text-[12.5px] text-ink-mute">
                  Read only. Zenith uses it to describe resources, read logs and metrics, and check for drift. It cannot read secret values or change anything.
                </dd>
              </div>
              <div className="rounded-card border border-line bg-bg2 p-4">
                <dt className="text-[13px] font-medium text-ink">Deploy role</dt>
                <dd className="mt-1 text-[12.5px] text-ink-mute">
                  Changes infrastructure, but only resources tagged <code className="font-mono">zenith:managed=true</code> or named <code className="font-mono">zenith-*</code>. It
                  can create IAM roles only with a permission boundary attached, and it cannot change its own permissions or the trust.
                </dd>
              </div>
            </dl>
          </section>

          <section aria-label="Enter the connection details" className="space-y-3">
            <h4 className="text-[14px] font-medium text-ink">3. Tell Zenith which account and roles</h4>
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Bootstrap name suffix" help="The exact NameSuffix used by the stack. Leave empty for the default stack, or use a suffix such as -team-a." error={shown("bootstrapNameSuffix")} className="md:col-span-2">
                <Input mono autoComplete="off" spellCheck={false} placeholder="-team-a" value={values.bootstrapNameSuffix ?? ""} onChange={(e) => change("bootstrapNameSuffix", e.target.value)} onBlur={() => blur("bootstrapNameSuffix")} />
              </Field>
              <Field label="AWS account ID" help="The 12-digit account the stack was created in." error={shown("accountId")} required>
                <Input
                  mono
                  inputMode="numeric"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="123456789012"
                  value={values.accountId}
                  onChange={(e) => change("accountId", e.target.value)}
                  onBlur={() => blur("accountId")}
                />
              </Field>
              <Field label="Region" help="The region of the stack, for example us-east-1." error={shown("region")} required>
                <Input
                  mono
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="us-east-1"
                  value={values.region}
                  onChange={(e) => change("region", e.target.value)}
                  onBlur={() => blur("region")}
                />
              </Field>
              <Field
                label="Observe role ARN"
                help="The ObserveRoleArn output of the stack."
                error={shown("observeRoleArn")}
                required
                className="md:col-span-2"
              >
                <Input
                  mono
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="arn:aws:iam::123456789012:role/ZenithObserveRole"
                  value={values.observeRoleArn}
                  onChange={(e) => change("observeRoleArn", e.target.value)}
                  onBlur={() => blur("observeRoleArn")}
                />
              </Field>
              <Field
                label="Deploy role ARN"
                help="The DeployRoleArn output of the stack."
                error={shown("deployRoleArn")}
                required
                className="md:col-span-2"
              >
                <Input
                  mono
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="arn:aws:iam::123456789012:role/ZenithDeployRole"
                  value={values.deployRoleArn}
                  onChange={(e) => change("deployRoleArn", e.target.value)}
                  onBlur={() => blur("deployRoleArn")}
                />
              </Field>
            </div>
            {validation.warnings.map((w) => (
              <Callout key={w} tone="warn" compact>
                {w}
              </Callout>
            ))}
          </section>

          <section aria-label="Verify the connection" className="space-y-3">
            <h4 className="text-[14px] font-medium text-ink">4. Verify the connection</h4>
            <p className="text-[13px] text-ink-mute">Verifying makes a read-only identity check in your account. Nothing there is changed.</p>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="primary"
                busy={verifying}
                disabled={Boolean(verifyBlocked)}
                disabledReason={verifyBlocked}
                aria-describedby={verifyBlocked ? hintId : undefined}
                onClick={() => void verify()}
              >
                Verify connection
              </Button>
              {verifyBlocked && (
                <span id={hintId} className="text-[12.5px] text-ink-mute">
                  {verifyBlocked}
                </span>
              )}
            </div>
            <div aria-live="polite">
              {result?.kind === "ok" && (
                <Callout tone="ok" title="Connection verified" live="off">
                  <p className="break-words">{result.detail}</p>
                  {result.accountId && (
                    <p className="mt-1 text-ink-mute">
                      Zenith reached account <span className="font-mono">{result.accountId}</span>.
                    </p>
                  )}
                </Callout>
              )}
              {accountMismatch && (
                <Callout tone="warn" title="Different account than entered" compact live="off">
                  Verification reached account <span className="font-mono">{result?.accountId}</span>, but you entered{" "}
                  <span className="font-mono">{values.accountId.trim()}</span>. Check the account ID and the role ARNs before you rely on this connection.
                </Callout>
              )}
              {result?.kind === "fail" && (
                <Callout tone="err" title="Verification failed" live="off">
                  <p className="break-words">{result.detail}</p>
                  <p className="mt-1 text-ink-mute">Check the trust values from step 1, that the stack finished, and the role ARNs, then verify again.</p>
                </Callout>
              )}
              {result?.kind === "threw" && (
                <Callout tone="err" title="Could not verify" live="off">
                  <p className="break-words">{result.detail}</p>
                  <p className="mt-1 text-ink-mute">Nothing was changed in your account. Try again in a moment.</p>
                </Callout>
              )}
            </div>
          </section>
        </div>
      </SurfaceGate>
    </Card>
  );
}
