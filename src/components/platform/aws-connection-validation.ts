/**
 * Client-side validation for the AWS connection form.
 *
 * These checks catch typos before a round trip; they are not security. The
 * connection service re-validates everything and the real test of a connection is
 * whether the broker can assume the role. The one thing this module is strict about
 * is the product promise: Zenith never asks for access keys. A value that looks like
 * an AWS access key id or secret access key is refused with a message that does NOT
 * repeat the value, so a pasted secret is never echoed back into the page.
 */

/** Where the customer bootstrap template lives in the Zenith repository. */
import { isBootstrapNameSuffix, isSupportedAwsConnectionRegion } from "@/lib/aws-bootstrap-input";

export const CFN_TEMPLATE_PATH = "deploy/aws/zenith-connection.cfn.yaml";
export const TOFU_MODULE_PATH = "deploy/aws/tofu-module";

export const ACCOUNT_ID_RE = /^\d{12}$/;
/** us-east-1, ap-south-1, eu-central-2, us-gov-west-1, cn-north-1 */
export const REGION_RE = /^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/;
/** arn:aws:iam::123456789012:role/Name (also the aws-cn and aws-us-gov partitions); captures the account id */
export const ROLE_ARN_RE = /^arn:aws(?:-cn|-us-gov)?:iam::(\d{12}):role\/[\w+=,.@/-]{1,512}$/;

const ACCESS_KEY_ID_RE = /\b(?:AKIA|ASIA|AIDA|AROA|AGPA|ANPA)[A-Z0-9]{16}\b/;
const SECRET_KEY_RE = /^[A-Za-z0-9/+=]{40}$/;

/** Does a pasted value look like an AWS access key id or a secret access key? */
export function looksLikeAccessKey(value: string): boolean {
  const v = value.trim();
  return ACCESS_KEY_ID_RE.test(v) || SECRET_KEY_RE.test(v);
}

export interface AwsFormValues {
  bootstrapNameSuffix?: string;
  accountId: string;
  region: string;
  observeRoleArn: string;
  deployRoleArn: string;
  /** Optional: the stack's SecretWriterRoleArn output. Without it, service secrets cannot reach AWS Secrets Manager. */
  secretWriterRoleArn?: string;
}

export type AwsFieldErrors = Partial<Record<keyof AwsFormValues, string>>;

export interface AwsValidation {
  errors: AwsFieldErrors;
  /** true when every field is present and valid */
  valid: boolean;
  /** things worth knowing that do not block verifying */
  warnings: string[];
}

const KEY_MESSAGE = "That looks like an access key. Zenith never needs one; paste the role ARN from the stack outputs instead.";

export function validateAwsForm(values: AwsFormValues): AwsValidation {
  const errors: AwsFieldErrors = {};
  const warnings: string[] = [];
  const accountId = values.accountId.trim();
  const region = values.region.trim();
  const observe = values.observeRoleArn.trim();
  const deploy = values.deployRoleArn.trim();
  const suffix = values.bootstrapNameSuffix ?? "";
  if (looksLikeAccessKey(suffix)) errors.bootstrapNameSuffix = KEY_MESSAGE;
  else if (!isBootstrapNameSuffix(suffix)) errors.bootstrapNameSuffix = "Leave empty or use a dash followed by 1 to 19 lowercase letters, digits or dashes.";

  if (looksLikeAccessKey(accountId)) errors.accountId = KEY_MESSAGE;
  else if (!accountId) errors.accountId = "Enter your 12-digit AWS account ID.";
  else if (!ACCOUNT_ID_RE.test(accountId)) errors.accountId = "An AWS account ID is exactly 12 digits, for example 123456789012.";

  if (looksLikeAccessKey(region)) errors.region = KEY_MESSAGE;
  else if (!region) errors.region = "Enter the region your roles and state bucket are in.";
  else if (!REGION_RE.test(region)) errors.region = "That does not look like an AWS region. Use a name like us-east-1 or ap-south-1.";
  else if (!isSupportedAwsConnectionRegion(region)) errors.region = "Choose a supported AWS connection region, such as us-east-1 or ap-south-1.";

  const writer = (values.secretWriterRoleArn ?? "").trim();
  const roleError = (value: string, which: "observe" | "deploy" | "secret writer"): string | undefined => {
    if (looksLikeAccessKey(value)) return KEY_MESSAGE;
    if (!value) return `Paste the ${which} role ARN from the stack outputs.`;
    const m = ROLE_ARN_RE.exec(value);
    if (!m) return "A role ARN looks like arn:aws:iam::123456789012:role/ZenithObserveRole. Copy it from the stack outputs.";
    if (!value.startsWith("arn:aws:")) return "Use a role in the supported commercial AWS partition.";
    if (ACCOUNT_ID_RE.test(accountId) && m[1] !== accountId) {
      return `This role is in account ${m[1]}, but you entered account ${accountId}. Check that both belong to the account you are connecting.`;
    }
    return undefined;
  };
  const oe = roleError(observe, "observe");
  if (oe) errors.observeRoleArn = oe;
  const de = roleError(deploy, "deploy");
  if (de) errors.deployRoleArn = de;

  const we = writer ? roleError(writer, "secret writer") : undefined;
  if (we) errors.secretWriterRoleArn = we;
  else if (writer && (writer === observe || writer === deploy)) errors.secretWriterRoleArn = "Use the stack's separate SecretWriterRoleArn output, not the observe or deploy role.";

  if (!errors.observeRoleArn && !errors.deployRoleArn && observe === deploy) {
    warnings.push(
      "The observe and deploy roles are the same, so Zenith's read-only access is not separated from its ability to change things. Use two roles unless this is a development account."
    );
  }

  return { errors, valid: Object.keys(errors).length === 0, warnings };
}
