/** Offline policy checks; these do not claim native driver execution. */
import fs from "node:fs";
import path from "node:path";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";
import { manifestFor } from "../../scripts/ci/gate-manifest.mjs";

interface Job {
  if?: string;
  "runs-on": string[];
  environment: string;
  concurrency: { group: string; "cancel-in-progress": boolean };
  env: Record<string, string>;
  steps: { run?: string; if?: string; uses?: string; with?: Record<string, unknown> }[];
}
const workflow = load(fs.readFileSync(path.join(process.cwd(), ".github/workflows/ci.yml"), "utf8")) as {
  on: { workflow_dispatch?: unknown };
  concurrency: { "cancel-in-progress": string }; jobs: Record<string, Job>;
};
const lanes = [
  [
    "drv1-private-source",
    "ZENITH_LOCAL_DRV1",
    "DRV1_PRIVATE_SOURCE"
  ],
  [
    "drv1-update-rollback",
    "ZENITH_LOCAL_DRV1",
    "DRV1_UPDATE_ROLLBACK"
  ],
  [
    "drv2-drift-repair",
    "ZENITH_TEST_DRV2_OPERATED",
    "DRV2_DRIFT_REPAIR"
  ],
  [
    "drv2-crash-partition",
    "ZENITH_TEST_DRV2_OPERATED",
    "DRV2_CRASH_PARTITION"
  ],
  [
    "j15-operated-upgrade",
    "ZENITH_LOCAL_OPERATED",
    "DRV3_UPGRADE"
  ],
  [
    "j15-operated-restore",
    "ZENITH_LOCAL_OPERATED",
    "DRV3_RESTORE"
  ],
  [
    "drivers-d4-two-tenants",
    "ZENITH_LOCAL_DRIVER_D4",
    "DRV4_TWO_TENANTS"
  ],
  [
    "drivers-d4-export",
    "ZENITH_LOCAL_DRIVER_D4",
    "DRV4_EXPORT"
  ]
] as const;

describe("J15 operated CI admission", () => {
  it("supports manual dispatch", () => {
    expect(workflow.on.workflow_dispatch).toBeDefined();
  });
  it.each(lanes)("%s requires explicit trusted-push admission and an exclusive native fixture", (lane, gate, prefix) => {
    const job = workflow.jobs[lane];
    expect(job.if).toBe(`github.event_name == 'push' && vars.${gate} == '1'${lane === "drivers-d4-export" ? " && vars.ZENITH_LOCAL_EXPORT_DATA == '1'" : ""}`);
    expect(job["runs-on"]).toEqual(["self-hosted", "macOS", "ARM64", "zenith-operated"]);
    expect(job.environment).toBe("operated-rehearsal");
    expect(job.concurrency).toEqual({ group: "zenith-operated-${{ github.repository }}", "cancel-in-progress": false });
    expect(job.env[gate]).toBe("1");
    for (const [name, value] of Object.entries(manifestFor(lane).env)) expect(job.env[name]).toBe(value);
    for (const flag of ["ZENITH_LOCAL_TARGETS", "ZENITH_LOCAL_JOINED_DRIVERS", "ZENITH_ACCEPTANCE_DEFAULT_STACK", "ZENITH_DEFAULT_JOURNEY"]) expect(job.env[flag]).toBe("1");
    for (const [name, suffix] of [["ZENITH_LOCAL_ROOT", "ROOT"], ["ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR", "STACK_DIR"], ["ZENITH_LOCAL_JOURNEY_CONFIG_FILE", "CONFIG_FILE"]]) {
      expect(job.env[name]).toBe("${{ vars.ZENITH_OPERATED_" + prefix + "_" + suffix + " }}");
    }
    if (lane.startsWith("drivers-d4-")) {
      expect(job.env[lane === "drivers-d4-export" ? "ZENITH_LOCAL_EXPORT_CONFIG_FILE" : "ZENITH_LOCAL_TWO_TENANTS_CONFIG_FILE"]).toBe(job.env.ZENITH_LOCAL_JOURNEY_CONFIG_FILE);
    }
    if (lane === "drivers-d4-export") {
      expect(job.env.ZENITH_LOCAL_EXPORT_DATA).toBe("1");
      for (const name of ["ZENITH_LOCAL_EXPORT_POSTGRES_IMAGE", "ZENITH_LOCAL_EXPORT_MYSQL_IMAGE", "ZENITH_LOCAL_EXPORT_MINIO_IMAGE"]) expect(job.env[name]).toBe("${{ vars." + name + " }}");
    }
    const host = job.steps.findIndex(step => step.run?.includes("node scripts/acceptance/default-stack/env.mjs"));
    const run = job.steps.findIndex(step => step.run === `node scripts/ci/run-gate.mjs ${lane} --run`);
    expect(host).toBeGreaterThan(-1);
    expect(run).toBeGreaterThan(host);
    expect(job.steps[host].run).toContain('while IFS=\'=\' read -r key value; do');
    expect(job.steps[host].run).not.toMatch(/\beval\b|\bsource\b/);
    expect(job.steps[run].if).toBeUndefined();
  });

  it("allows cleanup to drain across pushes whenever an operated gate is enabled", () => {
    expect(workflow.concurrency["cancel-in-progress"]).toBe("${{ github.event_name != 'workflow_dispatch' && !(github.event_name == 'push' && (vars.ZENITH_LOCAL_DRV1 == '1' || vars.ZENITH_TEST_DRV2_OPERATED == '1' || vars.ZENITH_LOCAL_OPERATED == '1' || vars.ZENITH_LOCAL_DRIVER_D4 == '1')) }}");
  });
});
