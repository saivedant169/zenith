import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WAVE6, commandsForRequirement, wave6Manifest } from "../../scripts/ci/wave6-gates.mjs";
import { manifestFor } from "../../scripts/ci/gate-manifest.mjs";
import { reportFailures } from "./assert-lane-report.mjs";
import { CHECKS as J2_CHECKS } from "../e2e/default/receipt.mjs";
import { UX_IDS } from "../e2e/default/ux-receipt.mjs";

describe("closed Wave 6 integration registry", () => {
  it("keeps each assembled test and requirement registered exactly once", () => {
    expect(new Set(WAVE6.files).size).toBe(WAVE6.files.length);
    expect(new Set(WAVE6.gatedCases.map((item: { id: string }) => item.id)).size).toBe(WAVE6.gatedCases.length);
    for (const file of WAVE6.files) expect(fs.existsSync(file), file).toBe(true);
    const ledger = JSON.parse(fs.readFileSync("docs/build/production/ledger.json", "utf8"));
    for (const row of ledger.requirements.filter((item: { implementationStatus: string }) => item.implementationStatus === "implementation_complete_verification_pending")) {
      const plan = commandsForRequirement(row.id);
      expect(plan.status).toBe("implementation_complete_verification_pending");
      expect(plan.commands.length, row.id).toBeGreaterThan(0);
    }
  });
  it("exposes owner-run lanes through the canonical manifest without enabling credentials or gates", () => {
    for (const lane of new Set(WAVE6.gatedCases.map((item: { lane: string }) => item.lane))) {
      expect(manifestFor(`wave6-${lane}`).requirements).toEqual(wave6Manifest(`wave6-${lane}`).requirements);
      expect(manifestFor(`wave6-${lane}`).env).toEqual({});
    }
  });
  it("joins the UX receipt gate to the completed J2 report without changing J2 identities", () => {
    expect(J2_CHECKS).toEqual([
      "prerequisites", "auth-admin-mailpit", "two-operator-workspace", "browser-proposal",
      "self-approval-refused", "bearer-approval-refused", "stale-semantics-refused",
      "browser-kind-execution-readback", "worker-composed-execution", "rest-proposal-execution-readback",
      "mcp-proposal-execution-readback", "machine-browser-consent",
      "machine-independent-approval-readback", "machine-health-provenance-readback", "machine-fresh-token-native-rejoin",
      "customer-credential-absence", "runner-connection-lifecycle", "connection-rotation-readback", "connection-revocation-no-fallback", "worker-readiness-graceful-drain", "cleanup",
    ]);
    expect(UX_IDS).toEqual([
      "ux01-operation-review-a11y", "ux01-independent-approval-a11y", "ux01-replan-reapproval-a11y",
      "ux01-cancel-operation-a11y", "ux01-legacy-projection-a11y", "ux01-runbook-approval-progress-a11y",
      "ux01-readiness-a11y", "ux01-uncertainty-a11y",
    ]);
    expect(new Set([...J2_CHECKS, ...UX_IDS]).size).toBe(J2_CHECKS.length + UX_IDS.length);
    const gate = WAVE6.gatedCases.find((item: { id: string }) => item.id === "wave6-03be46338cbeb148");
    expect(gate).toMatchObject({ file: "tests/e2e/default/ux-receipt-gated.test.ts", lane: "browser" });
    const plan = commandsForRequirement("PROD-UX-01");
    const j2 = plan.commands.find((command: { argv: string[] }) => command.argv.includes("scripts/acceptance/default-journey.mjs"));
    expect(j2?.argv).toContain("<absolute-new-private-J2-receipt.json>");
    expect(j2?.env).toMatchObject({ ZENITH_UX01_BROWSER: "1", ZENITH_UX01_RECEIPT: "<absolute-new-private-UX-receipt.json>" });
    const verify = plan.commands.find((command: { id?: string }) => command.id === gate.id);
    expect(verify?.env).toEqual({
      ZENITH_UX01_RECEIPT: "<absolute-new-private-UX-receipt.json>",
      ZENITH_JOURNEY_RECEIPT: "<absolute-new-private-J2-receipt.json>",
      ZENITH_TEST_UX01_RECEIPT: "1",
    });
    const j2Gates = ["wave6-0e2f61ae68595277", "wave6-80bfa8cded622b84"];
    for (const id of j2Gates) {
      const row = WAVE6.gatedCases.find((item: { id: string }) => item.id === id);
      expect(row?.gates).toContain("ZENITH_TEST_J2_RECEIPT=1");
      const requirement = id === "wave6-0e2f61ae68595277" ? "PROD-OBS-02" : "PROD-MACH-04";
      const command = commandsForRequirement(requirement).commands.find((item: { id?: string }) => item.id === id);
      expect(command?.env).toEqual({
        ZENITH_JOURNEY_RECEIPT: "<absolute-new-private-J2-receipt.json>",
        ZENITH_TEST_J2_RECEIPT: "1",
      });
    }
    const j2Sources = fs.readFileSync("tests/e2e/default/journey-receipt-gated.test.ts", "utf8");
    const uxSources = fs.readFileSync("tests/e2e/default/ux-receipt-gated.test.ts", "utf8");
    expect(j2Sources).toContain("describe.skipIf(!enabled)");
    expect(j2Sources).toContain("throw new Error('j2:private-receipt-required')");
    expect(uxSources).toContain("describe.skipIf(!enabled)");
    expect(uxSources).toContain("throw new Error('ux01:private-receipt-required')");
    const otherGate = commandsForRequirement("PROD-LIFE-10").commands.find((item: { id?: string }) => item.id === "wave6-5615dc34e8887f07");
    expect(otherGate?.env).toBeUndefined();
    expect(verify?.verify).toEqual(["node", "scripts/ci/wave6-gates.mjs", "--case", gate.id, "--report", `.data-ci-lane/${gate.id}.json`]);

    const expectedWave6 = (requirement: string, id: string) => {
      const plan = commandsForRequirement(requirement);
      return plan.commands.some((command: { id?: string }) => command.id === id);
    };
    expect(expectedWave6("PROD-LIFE-09", "wave6-d619a3904fed6789")).toBe(true);
    expect(expectedWave6("PROD-LIFE-10", "wave6-5615dc34e8887f07")).toBe(true);
    expect(expectedWave6("PROD-OBS-04", "wave6-72ab835f34c19371")).toBe(true);
    expect(expectedWave6("PROD-MACH-03", "wave6-55718f085353604a")).toBe(true);
    expect(expectedWave6("PROD-OBS-02", "wave6-0e2f61ae68595277")).toBe(true);
    expect(expectedWave6("PROD-MACH-04", "wave6-80bfa8cded622b84")).toBe(true);
    expect(WAVE6.requirements["PROD-MACH-04"]).toEqual(expect.arrayContaining([
      "tests/e2e/default/journey.spec.mjs", "tests/e2e/default/receipt.test.ts", "tests/e2e/default/journey-receipt-gated.test.ts",
    ]));
    expect(WAVE6.requirements["PROD-LIFE-11"]).toEqual(expect.arrayContaining([
      "tests/release/drivers/d4.test.ts", "tests/release/drivers/export-data.test.ts",
    ]));
    expect(manifestFor("drivers-d4-export").requirements).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: "tests/release/drivers/d4.operated.test.ts" }),
    ]));
    expect(manifestFor("j15-operated-restore").requirements).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: "tests/acceptance/operated-restore.engine.test.ts" }),
    ]));
    const life10 = WAVE6.gatedCases.find((item: { id: string }) => item.id === "wave6-5615dc34e8887f07");
    expect(life10.prerequisites).toEqual(expect.arrayContaining([
      "ZENITH_LIFE10_BROWSER_FIXTURES_FILE", "ZENITH_MFA_BROWSER_FIXTURES_FILE",
    ]));
  });

  it("rejects missing, skipped, failed and wrong-title evidence for every gated identity", () => {
    for (const item of WAVE6.gatedCases) {
      const accepted = { success: true, testResults: [{ name: path.resolve(item.file), status: "passed", assertionResults: [{ fullName: item.fullName, title: item.test, ancestorTitles: [item.ancestorSuite, item.suite].filter(Boolean), status: "passed" }] }] };
      expect(reportFailures([item], accepted, process.cwd()), item.id).toEqual([]);
      const wrongTitle = structuredClone(accepted); wrongTitle.testResults[0].assertionResults[0].title += " unrelated";
      expect(reportFailures([item], wrongTitle, process.cwd())).toHaveLength(1);
      for (const status of ["skipped", "pending", "failed"]) {
        const report = { success: true, testResults: [{ name: path.resolve(item.file), status: "passed", assertionResults: [{ fullName: item.fullName, title: item.test, ancestorTitles: [item.suite], status }] }] };
        expect(reportFailures([item], report, process.cwd()).length, item.id).toBeGreaterThan(0);
      }
      expect(reportFailures([item], { success: true, testResults: [] }, process.cwd())).toHaveLength(1);
    }
  });
});
