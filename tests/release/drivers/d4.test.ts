import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { DRIVER_CHECKS, DRIVER_LIMITS, OPERATED_LABEL, OwnedCleanup, receiptExit, validateOperatedReceipt, type OperatedReceipt } from "../../../scripts/release/drivers/protocol";
import { validateExportBundle, validatePortablePlan, runExport } from "../../../scripts/release/drivers/export";
import { assertActionRefusal, assertHttpRefusal, assertMcpRefusal, runTwoTenants } from "../../../scripts/release/drivers/two-tenants";
import { localTargetLane, LOCAL_TARGETS, requiredChecks, validateLocalReceipt } from "../../../scripts/release/local-targets";
import { SCENARIOS } from "../../../scripts/release/scenarios";
import { exportBundle } from "@/lib/providers/localstack/export";
import type { Environment, Manifest } from "@/lib/domain/types";
import { manifestFor } from "../../../scripts/ci/gate-manifest.mjs";
import { DATA_KINDS, knownData, rowWitness, objectWitness } from "../../../scripts/release/drivers/export-data-plan";

const commit = "a".repeat(40), sourceDigest = "b".repeat(64), runId = "drv4-test";
function receipt(scenarioId: "two-tenants" | "export" = "two-tenants"): OperatedReceipt {
  return { schema: 1, evidenceLabel: OPERATED_LABEL, scenarioId, runId, sourceCommit: commit, sourceDigest,
    checks: DRIVER_CHECKS[scenarioId].map(id => ({ id, status: "passed" })),
    readbacks: Object.fromEntries((scenarioId === "two-tenants" ? ["tenant-a", "tenant-b"] : ["source", "bundle", "portable-plan", "portable"]).map(key => [key, "c".repeat(64)])),
    ...(scenarioId === "export" ? { dataRoundtrips: Object.fromEntries(DATA_KINDS.map(kind => {
      const content = (letter: "a" | "b") => kind === "object_store" ? objectWitness(knownData(runId, letter).objects) : rowWitness(knownData(runId, letter).rows);
      return [kind, { source: content("a"), target: content("a"), otherTenant: content("b"), exportedContentDigest: sourceDigest, restoredContentDigest: sourceDigest,
        tenantIsolation: true, mysqlTls: kind === "mysql" ? "verified_identity" : "not_applicable" }];
    })) as OperatedReceipt["dataRoundtrips"] } : {}), limits: [...DRIVER_LIMITS[scenarioId]] };
}
const expected = { scenarioId: "two-tenants", runId, sourceCommit: commit, sourceDigest } as const;
describe("DRV-4 closed operated evidence", () => {
  it("validates only complete scenario/run/source-bound evidence", () => {
    expect(validateLocalReceipt(receipt(), expected)).toEqual(receipt());
    expect(() => validateLocalReceipt(receipt(), { ...expected, sourceDigest: "f".repeat(64) })).toThrow("binding");
    expect(receiptExit(receipt())).toBe(0);
    for (const changed of [{ scenarioId: "export" }, { runId: "another-run" }, { sourceCommit: "d".repeat(40) }, { sourceDigest: "e".repeat(64) }]) expect(() => validateOperatedReceipt({ ...receipt(), ...changed }, expected)).toThrow();
  });
  it.each(["missing", "duplicate", "extra", "reordered"])("refuses %s check inventories", change => {
    const raw = receipt();
    if (change === "missing") raw.checks.pop();
    if (change === "duplicate") raw.checks[1] = raw.checks[0];
    if (change === "extra") raw.checks.push({ id: "invented", status: "passed" });
    if (change === "reordered") raw.checks.reverse();
    expect(() => validateOperatedReceipt(raw, expected)).toThrow();
  });
  it("cannot promote component, skipped, failed, missing-readback or secret-bearing evidence", () => {
    for (const raw of [{ ...receipt(), evidenceLabel: "local_rehearsal" }, { ...receipt(), readbacks: {} },
      { ...receipt(), token: randomBytes(32).toString("hex") }, { ...receipt(), readbacks: { provider: randomBytes(20).toString("hex") } }]) expect(() => validateOperatedReceipt(raw, expected)).toThrow();
    const skipped = receipt(); skipped.checks[2].status = "skipped"; expect(receiptExit(skipped)).toBe(3);
    const failed = receipt(); failed.checks.at(-1)!.status = "failed"; expect(receiptExit(failed)).toBe(1);
  });
  it("registers the actual drivers, strict checks, label and required gates additively", () => {
    for (const id of ["two-tenants", "export"] as const) {
      expect(LOCAL_TARGETS[id].driver).toBe(`scripts/release/drivers/${id}.ts`);
      expect(requiredChecks(id)).toEqual(DRIVER_CHECKS[id]);
      const lane = localTargetLane(SCENARIOS.find(scenario => scenario.id === id)!);
      expect(lane.files).toContain(LOCAL_TARGETS[id].driver);
      expect(lane.evidenceLabel).toBe(OPERATED_LABEL);
      expect(lane.gates).toContain("ZENITH_LOCAL_DRIVER_D4=1");
      expect(lane.gates).toContain("ZENITH_LOCAL_JOURNEY_CONFIG_FILE");
      const gate = manifestFor(`drivers-d4-${id}`);
      expect(gate.requirements).toHaveLength(1);
      expect(gate.command).toContain("--testNamePattern");
      expect(gate.requirements[0].test).toBe(`${id}: browser authority, independent readback and owned cleanup`);
    }
    expect(localTargetLane(SCENARIOS.find(scenario => scenario.id === "install")!).evidenceLabel).toBe("local_rehearsal");
  });
  it("disabled drivers decline before opening nonexistent credentials or engines", async () => {
    for (const [scenarioId, driver] of [["two-tenants", runTwoTenants], ["export", runExport]] as const) {
      expect(await driver({ scenarioId, runId, sourceCommit: commit, receiptFile: "missing-receipt", env: { NODE_ENV: "test", ZENITH_LOCAL_JOURNEY_CONFIG_FILE: "missing-credentials" } })).toBe(2);
    }
  });
});
describe("DRV-4 owned cleanup", () => {
  it("settles in reverse order, continues after failures and cannot execute twice", async () => {
    const jobs = new OwnedCleanup(), calls: string[] = [];
    jobs.add(async () => { calls.push("stack"); }); jobs.add(async () => { calls.push("target"); });
    jobs.add(async () => { calls.push("browser"); throw new Error(randomBytes(32).toString("hex")); });
    jobs.add(async () => { calls.push("credential"); });
    expect(await jobs.settle()).toBe(false);
    expect(calls).toEqual(["credential", "browser", "target", "stack"]);
    expect(await jobs.settle()).toBe(true); expect(calls).toHaveLength(4);
  });
});
describe("DRV-4 refusal evidence", () => {
  it.each([200, 301, 400, 401, 409, 500, 503])("HTTP %s is not an isolation pass", status => {
    expect(() => assertHttpRefusal({ status, data: {} })).toThrow();
  });
  it("accepts a cross-tenant action only when the mutation endpoint refused it as absent", () => {
    expect(() => assertActionRefusal({ status: 200, data: { result: { ok: false, error: 'Project "p" does not exist. Pick one from the workspace overview.' } } }, "update-manifest")).not.toThrow();
    expect(() => assertActionRefusal({ status: 404, data: {} }, "update-manifest")).not.toThrow();
    expect(() => assertActionRefusal({ status: 200, data: { result: { ok: true } } }, "update-manifest")).toThrow("tenant-refusal-update-manifest-200-ok");
    expect(() => assertActionRefusal({ status: 200, data: { result: { ok: false, error: "Invalid input." } } }, "update-manifest")).toThrow();
    expect(() => assertActionRefusal({ status: 500, data: {} }, "deploy-cancel")).toThrow("tenant-refusal-deploy-cancel-500");
  });
  it("accepts only current authority refusals on the browser path", () => {
    for (const status of [403, 404]) expect(() => assertHttpRefusal({ status, data: {} })).not.toThrow();
  });
  it("requires an MCP authority envelope, not a JSON-RPC crash or ordinary success", () => {
    for (const value of [{ status: 200, data: {} }, { status: 500, data: { error: {} } },
      { status: 200, data: { result: { structuredContent: { ok: true } } } },
      { status: 200, data: { result: { structuredContent: { ok: false, error: { code: "invalid_input" } } } } }]) expect(() => assertMcpRefusal(value)).toThrow();
    expect(() => assertMcpRefusal({ status: 200, data: { result: { structuredContent: { ok: false, error: { code: "scope_denied" } } } } })).not.toThrow();
  });
});

const environment: Environment = { id: "env-export", projectId: "project-export", name: "production", class: "production", connectionId: "conn-export", region: "us-east-1",
  baseDomain: "fixture.local", policies: { approvalRequired: true, allowStatefulDeletion: false }, createdAt: new Date(0).toISOString() };
const manifest: Manifest = { version: 1, services: [], resources: [{ id: "assets", name: "assets", kind: "object_store", size: "small", config: {}, ownership: "managed" }], routes: [], bindings: [] };
function bundle() { return { ...exportBundle(environment, manifest), provider: "localstack", source: { kind: "revision", revisionId: "revision-export", number: 1 } }; }
describe("DRV-4 export planner", () => {
  it("admits the actual exporter unchanged and binds the deployed revision", () => {
    expect(validateExportBundle(bundle(), "revision-export", [])).toEqual(bundle());
    expect(() => validateExportBundle(bundle(), "wrong-revision", [])).toThrow();
    expect(() => validateExportBundle({ ...bundle(), source: { kind: "working" } }, "revision-export", [])).toThrow();
  });
  it.each(["../outside.tf", "/absolute.tf", "nested/file.tf", "providers.tf", "other.tf"])("refuses unsafe, duplicate or unexpected file %s", file => {
    expect(() => validateExportBundle({ ...bundle(), files: [...bundle().files, { path: file, content: "" }] }, "revision-export", [])).toThrow();
  });
  it("refuses redirects, privileged provisioners and nonlocal endpoints before OpenTofu", () => {
    for (const extra of ['module "external" {}', 'provisioner "local-exec" {}', 'terraform { backend "s3" {} }', 'resource "aws_instance" "vm" {}', 'provider "aws" { alias = "outside" }', 'provider "google" {}']) {
      const raw = bundle(); raw.files.find(file => file.path === "s3.tf")!.content += "\n" + extra;
      expect(() => validateExportBundle(raw, "revision-export", [])).toThrow();
    }
    const raw = bundle(); raw.files.find(file => file.path === "providers_override.tf")!.content = raw.files.find(file => file.path === "providers_override.tf")!.content.replaceAll("http://localhost:4566", "https://cloud.invalid");
    expect(() => validateExportBundle(raw, "revision-export", [])).toThrow();
    const incomplete = bundle(); incomplete.files.find(file => file.path === "providers_override.tf")!.content = incomplete.files.find(file => file.path === "providers_override.tf")!.content.replace(/^\s*ec2\s*=.*$/m, "");
    expect(() => validateExportBundle(incomplete, "revision-export", [])).toThrow("journey:portable-no-cloud-fallback");
  });
  it("rejects actual credential canaries without publishing them", () => {
    for (const secret of [randomBytes(32).toString("base64url"), JSON.stringify({ token: randomBytes(32).toString("base64url") }), "local-credential\n" + randomBytes(32).toString("base64url")]) {
      const raw = bundle(); raw.readme += secret;
      expect(() => validateExportBundle(raw, "revision-export", [secret])).toThrow("journey:export-secret-absence");
    }
  });
  it("allows only fresh S3 infrastructure in the independent apply plan", () => {
    const plan = { resource_changes: [{ mode: "managed", type: "aws_s3_bucket", change: { actions: ["create"] } }, { mode: "data", type: "aws_caller_identity", change: { actions: ["read"] } }] };
    expect(() => validatePortablePlan(plan)).not.toThrow();
    for (const change of [{ mode: "managed", type: "aws_instance", change: { actions: ["create"] } }, { mode: "managed", type: "aws_s3_bucket", change: { actions: ["delete", "create"] } },
      { mode: "managed", type: "aws_s3_bucket", change: { actions: ["update"] } }, { mode: "data", type: "aws_ssm_parameter", change: { actions: ["read"] } }]) expect(() => validatePortablePlan({ resource_changes: [change] })).toThrow();
    expect(() => validatePortablePlan({ resource_changes: [] })).toThrow();
  });
});
