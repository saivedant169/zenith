import { beforeEach, expect, it, vi } from "vitest";
import { AwsConnectionFlow } from "@/app/(product)/platform/connections/aws/aws-flow";
import { button, click, flush, mount, text, type as typeInto } from "./render";

const { mutation } = vi.hoisted(() => ({ mutation: vi.fn() }));
vi.mock("@/app/(product)/platform/_lib/browser-api", () => ({ browserMutation: mutation, mutationError: () => "Request failed." }));
beforeEach(() => mutation.mockReset());
const field = (el: Element, label: string) => {
  const target = [...el.querySelectorAll("label")].find((item) => text(item).startsWith(label))!;
  return document.getElementById(target.getAttribute("for")!) as HTMLInputElement;
};

it("saves the submitted suffix and requires saving changed suffixes before verification", async () => {
  mutation.mockResolvedValue({ result: { ok: true, data: { connectionId: "conn-test", subject: "zenith:ws:ws-test:conn:conn-test", issuerHost: "example.com/api/oidc" } } });
  const el = mount(<AwsConnectionFlow workspaceId="ws-test" viewerRole="admin" />);
  typeInto(field(el, "AWS account ID"), "123456789012");
  typeInto(field(el, "Region"), "us-east-1");
  typeInto(field(el, "Observe role ARN"), "arn:aws:iam::123456789012:role/ZenithObserve-team-a");
  typeInto(field(el, "Deploy role ARN"), "arn:aws:iam::123456789012:role/ZenithDeploy-team-a");
  typeInto(field(el, "Bootstrap name suffix"), "-team-a");
  click(button(el, "Save connection identifiers"));
  await flush();
  expect(mutation).toHaveBeenCalledWith("ws-test", "/platform/connections/aws/action", expect.objectContaining({ input: expect.objectContaining({ bootstrapNameSuffix: "-team-a" }) }));
  expect(button(el, "Verify connection").disabled).toBe(false);
  typeInto(field(el, "Bootstrap name suffix"), "-team-b");
  expect(button(el, "Verify connection").disabled).toBe(true);
  expect(button(el, "Save new connection identifiers").disabled).toBe(false);
  const row = [...el.querySelectorAll("tbody tr")].find((item) => text(item).startsWith("NameSuffix"))!;
  expect(text(row)).toContain("-team-a");
  expect(text(row)).not.toContain("-team-b");
  click(button(el, "Save new connection identifiers"));
  await flush();
  expect(mutation).toHaveBeenLastCalledWith("ws-test", "/platform/connections/aws/action", expect.objectContaining({ input: expect.objectContaining({ bootstrapNameSuffix: "-team-b" }) }));
  expect(button(el, "Verify connection").disabled).toBe(false);
});

it("sends the secret writer role only when one is entered", async () => {
  mutation.mockReset();
  mutation.mockResolvedValue({ result: { ok: true, data: { connectionId: "conn-test", subject: "zenith:ws:ws-test:conn:conn-test", issuerHost: "example.com/api/oidc" } } });
  const el = mount(<AwsConnectionFlow workspaceId="ws-test" viewerRole="admin" />);
  typeInto(field(el, "AWS account ID"), "123456789012");
  typeInto(field(el, "Region"), "us-east-1");
  typeInto(field(el, "Observe role ARN"), "arn:aws:iam::123456789012:role/ZenithObserve");
  typeInto(field(el, "Deploy role ARN"), "arn:aws:iam::123456789012:role/ZenithDeploy");
  click(button(el, "Save connection identifiers"));
  await flush();
  expect(mutation.mock.lastCall![2].input).not.toHaveProperty("secretWriterRoleArn");
  typeInto(field(el, "Secret writer role ARN"), "arn:aws:iam::123456789012:role/ZenithSecretWriterRole");
  click(button(el, "Save new connection identifiers"));
  await flush();
  expect(mutation.mock.lastCall![2].input).toMatchObject({ secretWriterRoleArn: "arn:aws:iam::123456789012:role/ZenithSecretWriterRole" });
});
