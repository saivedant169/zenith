import { describe, expect, it, vi } from "vitest";
import { AwsConnectionSetup, type AwsTrust } from "@/components/platform/aws-connection-setup";
import { blur, button, click, describedBy, flush, headingsDoNotSkip, mount, text, type as typeInto } from "./render";

const OIDC: AwsTrust = {
  mode: "oidc_web_identity",
  issuerHost: "app.tryzenith.cloud/api/oidc",
  oidcSubject: "zenith:ws:ws_1:conn:conn_1",
};
const ASSUME: AwsTrust = {
  mode: "aws_assume_role",
  zenithPrincipalArn: "arn:aws:iam::210987654321:role/zenith-control-plane",
  externalId: "zx-7f3a9c1e",
};
const GOOD = {
  accountId: "123456789012",
  region: "ap-south-1",
  observeRoleArn: "arn:aws:iam::123456789012:role/ZenithObserveRole",
  deployRoleArn: "arn:aws:iam::123456789012:role/ZenithDeployRole",
};

const field = (el: Element, label: string): HTMLInputElement => {
  const l = [...el.querySelectorAll("label")].find((x) => text(x).startsWith(label));
  if (!l) throw new Error(`No field labelled ${label}`);
  return document.getElementById(l.getAttribute("for")!) as HTMLInputElement;
};

function fill(el: Element, values: Partial<typeof GOOD> = GOOD) {
  if (values.accountId !== undefined) typeInto(field(el, "AWS account ID"), values.accountId);
  if (values.region !== undefined) typeInto(field(el, "Region"), values.region);
  if (values.observeRoleArn !== undefined) typeInto(field(el, "Observe role ARN"), values.observeRoleArn);
  if (values.deployRoleArn !== undefined) typeInto(field(el, "Deploy role ARN"), values.deployRoleArn);
}

describe("<AwsConnectionSetup> instructions", () => {
  it("submits and displays the exact saved bootstrap suffix, and clears verification when it changes", async () => {
    const onVerify = vi.fn().mockResolvedValue({ ok: true, detail: "Identity verified" });
    const onConfigChange = vi.fn();
    const el = mount(<AwsConnectionSetup trust={OIDC} initialValues={GOOD} onVerify={onVerify} onConfigChange={onConfigChange} />);
    typeInto(field(el, "Bootstrap name suffix"), "-team-a");
    expect(onConfigChange).toHaveBeenLastCalledWith(expect.objectContaining({ bootstrapNameSuffix: "-team-a" }));
    expect(button(el, "Copy NameSuffix")).toBeDefined();
    click(button(el, "Verify connection"));
    await flush();
    expect(onVerify).toHaveBeenLastCalledWith(expect.objectContaining({ bootstrapNameSuffix: "-team-a" }));
    typeInto(field(el, "Bootstrap name suffix"), "-team-b");
    expect(text(el)).not.toContain("Identity verified");
  });
  it("names the CloudFormation template and its parameters", () => {
    const el = mount(<AwsConnectionSetup trust={OIDC} onVerify={vi.fn()} />);
    expect(text(el)).toContain("deploy/aws/zenith-connection.cfn.yaml");
    const params = [...el.querySelectorAll("tbody th[scope='row']")].map(text);
    for (const p of ["ZenithIssuerHost", "ZenithOidcSubject", "CreateOidcProvider", "EnvironmentTagValue", "NameSuffix", "Route53HostedZoneArns", "StateBucketKmsKeyArn"]) {
      expect(params).toContain(p);
    }
    expect(params).not.toContain("ExternalId");
  });

  it("gives the OIDC subject and issuer to paste, with copy buttons", () => {
    const el = mount(<AwsConnectionSetup trust={OIDC} onVerify={vi.fn()} />);
    expect(text(el)).toContain("zenith:ws:ws_1:conn:conn_1");
    expect(text(el)).toContain("app.tryzenith.cloud/api/oidc");
    expect(button(el, "Copy ZenithOidcSubject")).toBeDefined();
    expect(button(el, "Copy ZenithIssuerHost")).toBeDefined();
  });

  it("gives the ExternalId and principal for the assume-role path instead", () => {
    const el = mount(<AwsConnectionSetup trust={ASSUME} onVerify={vi.fn()} />);
    const params = [...el.querySelectorAll("tbody th[scope='row']")].map(text);
    expect(params).toContain("ExternalId");
    expect(params).toContain("ZenithPrincipalArn");
    expect(params).not.toContain("ZenithOidcSubject");
    expect(text(el)).toContain("zx-7f3a9c1e");
    expect(text(el)).toContain("It is not a password");
  });

  it("says plainly when the trust values do not exist yet", () => {
    const el = mount(<AwsConnectionSetup onVerify={vi.fn()} />);
    expect(text(el)).toContain("has not generated the trust values for this connection yet");
  });

  it("explains the observe role and the deploy role", () => {
    const el = mount(<AwsConnectionSetup trust={OIDC} onVerify={vi.fn()} />);
    const section = el.querySelector('section[aria-label="The two roles"]')!;
    expect(text(section)).toContain("Observe role");
    expect(text(section)).toContain("Read only");
    expect(text(section)).toContain("cannot read secret values");
    expect(text(section)).toContain("Deploy role");
    expect(text(section)).toContain("zenith:managed=true");
    expect(text(section)).toContain("permission boundary");
  });

  it("never asks for access keys, and says so", () => {
    const el = mount(<AwsConnectionSetup trust={OIDC} onVerify={vi.fn()} />);
    expect(text(el)).toContain("never asks for access keys or secrets");
    const inputs = [...el.querySelectorAll("input")];
    expect(inputs).toHaveLength(6);
    // The secret writer role is a role ARN (stack output SecretWriterRoleArn), never a secret value: only that name is allowed.
    const role = (v: string) => v.replace(/SecretWriterRole(Arn)?|Secret writer role ARN/g, "");
    for (const i of inputs) {
      expect(i.type).not.toBe("password");
      expect(role(`${i.name}${i.id}${i.placeholder}`)).not.toMatch(/secret|access.?key|token/i);
    }
    const labels = [...el.querySelectorAll("label")].map(text).join(" ");
    expect(role(labels)).not.toMatch(/access key|secret|password|token/i);
  });

  it("keeps heading order", () => {
    expect(headingsDoNotSkip(mount(<AwsConnectionSetup trust={OIDC} onVerify={vi.fn()} />))).toBe(true);
  });
});

describe("<AwsConnectionSetup> form", () => {
  it("validates ARNs, account id and region with messages after a field is touched", () => {
    const el = mount(<AwsConnectionSetup trust={OIDC} onVerify={vi.fn()} />);
    // untouched fields do not shout
    expect(text(el)).not.toContain("Enter your 12-digit AWS account ID.");
    const account = field(el, "AWS account ID");
    typeInto(account, "123");
    blur(account);
    expect(text(el)).toContain("exactly 12 digits");
    expect(account.getAttribute("aria-invalid")).toBe("true");
    expect(describedBy(account)).toContain("exactly 12 digits");

    const observe = field(el, "Observe role ARN");
    typeInto(observe, "ZenithObserveRole");
    blur(observe);
    expect(text(el)).toContain("A role ARN looks like arn:aws:iam::123456789012:role/ZenithObserveRole");

    const region = field(el, "Region");
    typeInto(region, "useast1");
    blur(region);
    expect(text(el)).toContain("does not look like an AWS region");
  });

  it("catches a role in another account before calling anything", () => {
    const el = mount(<AwsConnectionSetup trust={OIDC} onVerify={vi.fn()} />);
    fill(el, { ...GOOD, observeRoleArn: "arn:aws:iam::999999999999:role/Other" });
    blur(field(el, "Observe role ARN"));
    expect(text(el)).toContain("This role is in account 999999999999");
  });

  it("refuses a pasted access key and never echoes it", () => {
    const key = "AKIAIOSFODNN7EXAMPLE";
    const el = mount(<AwsConnectionSetup trust={OIDC} onVerify={vi.fn()} />);
    const observe = field(el, "Observe role ARN");
    typeInto(observe, key);
    blur(observe);
    expect(text(el)).toContain("That looks like an access key. Zenith never needs one");
    // the error paragraph does not repeat the pasted value (the input itself holds what the user typed)
    const errors = [...el.querySelectorAll("p")].filter((p) => p.className.includes("text-err")).map(text).join(" ");
    expect(errors).toContain("access key");
    expect(errors).not.toContain(key);
    expect(errors).not.toContain(key.slice(4));
    expect(button(el, "Verify connection").disabled).toBe(true);
  });

  it("warns, but does not block, when one role is used for both jobs", () => {
    const el = mount(<AwsConnectionSetup trust={OIDC} onVerify={vi.fn()} />);
    fill(el, { ...GOOD, deployRoleArn: GOOD.observeRoleArn });
    expect(text(el)).toContain("observe and deploy roles are the same");
    expect(button(el, "Verify connection").disabled).toBe(false);
  });

  it("reports the validated config as it changes, and null while invalid", () => {
    const onConfigChange = vi.fn();
    const el = mount(<AwsConnectionSetup trust={OIDC} onVerify={vi.fn()} onConfigChange={onConfigChange} />);
    typeInto(field(el, "AWS account ID"), "123456789012");
    expect(onConfigChange).toHaveBeenLastCalledWith(null);
    fill(el);
    expect(onConfigChange).toHaveBeenLastCalledWith({
      provider: "aws",
      mode: "oidc_web_identity",
      accountId: GOOD.accountId,
      region: GOOD.region,
      observeRoleArn: GOOD.observeRoleArn,
      deployRoleArn: GOOD.deployRoleArn,
      bootstrapNameSuffix: "",
    });
  });

  it("includes the ExternalId in the config only for the assume-role path", async () => {
    const onVerify = vi.fn().mockResolvedValue({ ok: true, detail: "ok" });
    const el = mount(<AwsConnectionSetup trust={ASSUME} onVerify={onVerify} />);
    fill(el);
    click(button(el, "Verify connection"));
    await flush();
    expect(onVerify.mock.calls[0][0]).toMatchObject({ mode: "aws_assume_role", externalId: "zx-7f3a9c1e" });
  });
});

describe("<AwsConnectionSetup> verify", () => {
  it("disables Verify with a visible, linked reason until the form is valid", () => {
    const onVerify = vi.fn();
    const el = mount(<AwsConnectionSetup trust={OIDC} onVerify={onVerify} />);
    const verify = button(el, "Verify connection");
    expect(verify.disabled).toBe(true);
    expect(text(el)).toContain("Fill in the account, region and both role ARNs correctly before verifying.");
    expect(describedBy(verify)).toContain("Fill in the account");
    expect(verify.getAttribute("title")).toContain("Fill in the account");
    click(verify);
    expect(onVerify).not.toHaveBeenCalled();
    fill(el);
    expect(button(el, "Verify connection").disabled).toBe(false);
    expect(text(el)).not.toContain("Fill in the account, region");
  });

  it("calls onVerify with the trimmed config and shows success exactly as reported", async () => {
    const onVerify = vi.fn().mockResolvedValue({ ok: true, detail: "Assumed the observe role as 123456789012.", accountId: "123456789012" });
    const el = mount(<AwsConnectionSetup trust={OIDC} onVerify={onVerify} />);
    fill(el, { ...GOOD, region: " ap-south-1 " });
    click(button(el, "Verify connection"));
    await flush();
    expect(onVerify).toHaveBeenCalledWith({ provider: "aws", mode: "oidc_web_identity", bootstrapNameSuffix: "", ...GOOD });
    expect(text(el)).toContain("Connection verified");
    expect(text(el)).toContain("Assumed the observe role as 123456789012.");
    expect(text(el)).toContain("Zenith reached account 123456789012.");
  });

  it("shows a failed verification and what to check", async () => {
    const onVerify = vi.fn().mockResolvedValue({ ok: false, detail: "AccessDenied: not authorized to perform sts:AssumeRoleWithWebIdentity" });
    const el = mount(<AwsConnectionSetup trust={OIDC} onVerify={onVerify} />);
    fill(el);
    click(button(el, "Verify connection"));
    await flush();
    expect(text(el)).toContain("Verification failed");
    expect(text(el)).toContain("AccessDenied: not authorized to perform sts:AssumeRoleWithWebIdentity");
    expect(text(el)).toContain("Check the trust values from step 1");
    expect(text(el)).not.toContain("Connection verified");
  });

  it("shows a thrown error as 'Could not verify' and lets the user try again", async () => {
    const onVerify = vi.fn().mockRejectedValueOnce(new Error("Network unreachable")).mockResolvedValue({ ok: true, detail: "Connected." });
    const el = mount(<AwsConnectionSetup trust={OIDC} onVerify={onVerify} />);
    fill(el);
    click(button(el, "Verify connection"));
    await flush();
    expect(text(el)).toContain("Could not verify");
    expect(text(el)).toContain("Network unreachable");
    expect(text(el)).toContain("Nothing was changed in your account");
    click(button(el, "Verify connection"));
    await flush();
    expect(text(el)).toContain("Connection verified");
  });

  it("warns when verification reached a different account than the one entered", async () => {
    const onVerify = vi.fn().mockResolvedValue({ ok: true, detail: "Connected.", accountId: "999999999999" });
    const el = mount(<AwsConnectionSetup trust={OIDC} onVerify={onVerify} />);
    fill(el);
    click(button(el, "Verify connection"));
    await flush();
    expect(text(el)).toContain("Different account than entered");
    expect(text(el)).toContain("999999999999");
  });

  it("clears a result as soon as an input changes, because it no longer applies", async () => {
    const onVerify = vi.fn().mockResolvedValue({ ok: true, detail: "Connected." });
    const el = mount(<AwsConnectionSetup trust={OIDC} onVerify={onVerify} />);
    fill(el);
    click(button(el, "Verify connection"));
    await flush();
    expect(text(el)).toContain("Connection verified");
    typeInto(field(el, "Region"), "eu-west-1");
    expect(text(el)).not.toContain("Connection verified");
  });

  it("does not verify twice while a verification is in flight", async () => {
    let resolve!: (v: { ok: boolean; detail: string }) => void;
    const onVerify = vi.fn(() => new Promise<{ ok: boolean; detail: string }>((r) => (resolve = r)));
    const el = mount(<AwsConnectionSetup trust={OIDC} onVerify={onVerify} />);
    fill(el);
    click(button(el, "Verify connection"));
    click(button(el, "Verify connection"));
    await flush();
    expect(onVerify).toHaveBeenCalledTimes(1);
    resolve({ ok: true, detail: "Connected." });
    await flush();
    expect(text(el)).toContain("Connection verified");
  });

  it("explains that verifying is a read-only check", () => {
    expect(text(mount(<AwsConnectionSetup trust={OIDC} onVerify={vi.fn()} />))).toContain("read-only identity check");
  });

  it("starts from initial values", () => {
    const el = mount(<AwsConnectionSetup trust={OIDC} onVerify={vi.fn()} initialValues={GOOD} />);
    expect(field(el, "AWS account ID").value).toBe(GOOD.accountId);
    expect(button(el, "Verify connection").disabled).toBe(false);
  });

  it("has loading and error states that keep the heading", () => {
    const loading = mount(<AwsConnectionSetup onVerify={vi.fn()} loading />);
    expect(loading.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(loading.querySelector("h3")?.textContent).toBe("Connect an AWS account");
    const onRetry = vi.fn();
    const failed = mount(<AwsConnectionSetup onVerify={vi.fn()} error="Could not generate the trust values." onRetry={onRetry} />);
    click(button(failed, "Try again"));
    expect(onRetry).toHaveBeenCalled();
  });
});
