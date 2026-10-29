import { describe, expect, it } from "vitest";
import { CFN_TEMPLATE_PATH, looksLikeAccessKey, validateAwsForm, type AwsFormValues } from "@/components/platform/aws-connection-validation";

const GOOD: AwsFormValues = {
  accountId: "123456789012",
  region: "ap-south-1",
  observeRoleArn: "arn:aws:iam::123456789012:role/ZenithObserveRole",
  deployRoleArn: "arn:aws:iam::123456789012:role/ZenithDeployRole",
};

describe("validateAwsForm", () => {
  it.each(["", "-team-a", `-${"a".repeat(19)}`])("accepts the exact bootstrap suffix %j", (bootstrapNameSuffix) => {
    expect(validateAwsForm({ ...GOOD, bootstrapNameSuffix }).valid).toBe(true);
  });
  it.each(["-", "team-a", "-TEAM", "-a/b", "-a\n", " -a", `-${"a".repeat(20)}`])("rejects malformed bootstrap suffix %j without trimming", (bootstrapNameSuffix) => {
    const result = validateAwsForm({ ...GOOD, bootstrapNameSuffix });
    expect(result.valid).toBe(false);
    expect(result.errors.bootstrapNameSuffix).toBeDefined();
    expect(result.errors.bootstrapNameSuffix).not.toContain(bootstrapNameSuffix);
  });
  it("accepts a complete, consistent form", () => {
    expect(validateAwsForm(GOOD)).toEqual({ errors: {}, valid: true, warnings: [] });
  });

  it("accepts an optional distinct secret writer role and refuses a foreign or reused one", () => {
    expect(validateAwsForm({ ...GOOD, secretWriterRoleArn: "" }).valid).toBe(true);
    expect(validateAwsForm({ ...GOOD, secretWriterRoleArn: "arn:aws:iam::123456789012:role/ZenithSecretWriterRole" }).valid).toBe(true);
    expect(validateAwsForm({ ...GOOD, secretWriterRoleArn: GOOD.deployRoleArn }).errors.secretWriterRoleArn).toContain("separate SecretWriterRoleArn");
    expect(validateAwsForm({ ...GOOD, secretWriterRoleArn: "arn:aws:iam::210987654321:role/ZenithSecretWriterRole" }).errors.secretWriterRoleArn).toContain("account 210987654321");
    expect(validateAwsForm({ ...GOOD, secretWriterRoleArn: "AKIAABCDEFGHIJKLMNOP" }).errors.secretWriterRoleArn).toContain("access key");
  });

  it("names the template the customer deploys", () => {
    expect(CFN_TEMPLATE_PATH).toBe("deploy/aws/zenith-connection.cfn.yaml");
  });

  it.each([
    ["", "Enter your 12-digit"],
    ["12345", "exactly 12 digits"],
    ["12345678901a", "exactly 12 digits"],
    ["1234567890123", "exactly 12 digits"],
  ])("rejects account id %j", (accountId, says) => {
    const v = validateAwsForm({ ...GOOD, accountId });
    expect(v.valid).toBe(false);
    expect(v.errors.accountId).toContain(says);
  });

  it.each(["us-east-1", "ap-south-1", "eu-central-1", "ap-southeast-2"])("accepts region %s", (region) => {
    expect(validateAwsForm({ ...GOOD, region }).errors.region).toBeUndefined();
  });

  it.each(["", "useast1", "US-EAST-1", "us-east", "us-east-1a", "global", "eu-central-2", "us-gov-west-1", "cn-north-1"])("rejects region %j", (region) => {
    expect(validateAwsForm({ ...GOOD, region }).errors.region).toBeDefined();
  });

  it.each([
    "arn:aws:iam::123456789012:role/ZenithObserveRole",
    "arn:aws:iam::123456789012:role/path/to/Role-1.2_x+y=z,w@v",
  ])("accepts role ARN %s", (observeRoleArn) => {
    expect(validateAwsForm({ ...GOOD, observeRoleArn }).errors.observeRoleArn).toBeUndefined();
  });

  it.each([
    "",
    "arn:aws-us-gov:iam::123456789012:role/Gov",
    "arn:aws-cn:iam::123456789012:role/Cn",
    "ZenithObserveRole",
    "arn:aws:iam::123456789012:user/alice",
    "arn:aws:iam::12345:role/Short",
    "arn:aws:s3:::bucket",
    "arn:aws:iam::123456789012:role/",
    "arn:aws:iam::123456789012:role/has space",
    "https://signin.aws.amazon.com/",
  ])("rejects role ARN %j", (deployRoleArn) => {
    expect(validateAwsForm({ ...GOOD, deployRoleArn }).errors.deployRoleArn).toBeDefined();
  });

  it("catches a role from a different account than the one entered", () => {
    const v = validateAwsForm({ ...GOOD, observeRoleArn: "arn:aws:iam::999999999999:role/Other" });
    expect(v.errors.observeRoleArn).toContain("account 999999999999");
    expect(v.errors.observeRoleArn).toContain("123456789012");
  });

  it("warns, without blocking, when observe and deploy are the same role", () => {
    const v = validateAwsForm({ ...GOOD, deployRoleArn: GOOD.observeRoleArn });
    expect(v.valid).toBe(true);
    expect(v.warnings).toHaveLength(1);
    expect(v.warnings[0]).toContain("same");
  });

  it("does not warn about sameness when a role is already invalid", () => {
    const v = validateAwsForm({ ...GOOD, observeRoleArn: "bad", deployRoleArn: "bad" });
    expect(v.warnings).toEqual([]);
  });

  it("trims whitespace around pasted values", () => {
    expect(validateAwsForm({ accountId: " 123456789012 ", region: " us-east-1 ", observeRoleArn: ` ${GOOD.observeRoleArn} `, deployRoleArn: `${GOOD.deployRoleArn}\n` }).valid).toBe(true);
  });
});

describe("access keys are refused and never echoed", () => {
  const ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
  const SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

  it("recognises a key id and a secret access key", () => {
    expect(looksLikeAccessKey(ACCESS_KEY_ID)).toBe(true);
    expect(looksLikeAccessKey(`  ${ACCESS_KEY_ID} `)).toBe(true);
    expect(looksLikeAccessKey("ASIAIOSFODNN7EXAMPLE")).toBe(true);
    expect(looksLikeAccessKey(SECRET)).toBe(true);
    expect(looksLikeAccessKey(GOOD.observeRoleArn)).toBe(false);
    expect(looksLikeAccessKey(GOOD.accountId)).toBe(false);
  });

  it.each(["accountId", "region", "observeRoleArn", "deployRoleArn", "bootstrapNameSuffix"] as const)("refuses a key pasted into %s without repeating it", (field) => {
    for (const secret of [ACCESS_KEY_ID, SECRET]) {
      const v = validateAwsForm({ ...GOOD, [field]: secret });
      expect(v.valid).toBe(false);
      const message = v.errors[field] ?? "";
      expect(message).toContain("access key");
      expect(message).not.toContain(secret);
      expect(message).not.toContain(secret.slice(0, 8));
    }
  });
});
