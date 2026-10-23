/** Real Mac lane. No mocks, seeded approvals, fake engine evidence or implicit opt-in. */
import { describe, expect, it } from "vitest";
import { mkdtempSync, chmodSync, realpathSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultExec } from "../../../scripts/release/acceptance-orchestrator";
import { sourceBinding } from "../../../scripts/deploy/installation.mjs";
import { Config, privateFile } from "../../../tests/e2e/default/support.mjs";
import { readState } from "../../../scripts/acceptance/default-stack/runtime.mjs";
import { hostEnvironment } from "../../../scripts/acceptance/default-stack/env.mjs";
import { validateOperatedReceipt } from "../../../scripts/release/drivers/protocol";
import { localEnvironment } from "../../../scripts/release/local-targets";

describe.skipIf(process.env.ZENITH_LOCAL_DRIVER_D4 !== "1")("J15 DRV-4 actual owned operated stack", () => {
  for (const scenarioId of ["two-tenants", "export", "adopt"] as const) {
    it(`${scenarioId}: browser authority, independent readback and owned cleanup`, async () => {
      const file = process.env[{ "two-tenants": "ZENITH_LOCAL_TWO_TENANTS_CONFIG_FILE", export: "ZENITH_LOCAL_EXPORT_CONFIG_FILE", adopt: "ZENITH_LOCAL_ADOPT_CONFIG_FILE" }[scenarioId]];
      expect(file, "Each case needs a fresh owned J1/J2 lean fixture and private config; the previous case destroys its fixture").toBeTruthy();
      const config = Config.parse(JSON.parse(privateFile(file)));
      const runId = process.env.ZENITH_LOCAL_RUN_ID ?? { "two-tenants": "drv4-tenants", export: "drv4-export", adopt: "drv4-adopt" }[scenarioId];
      const root = process.env.ZENITH_LOCAL_ROOT ?? mkdtempSync(path.join(realpathSync(os.tmpdir()), `zenith-j15-${runId}-`));
      if (!process.env.ZENITH_LOCAL_ROOT) chmodSync(root, 0o700);
      const output = path.join(root, `${scenarioId}.operated-receipt.json`), source = sourceBinding();
      const env = { ...localEnvironment(process.env), ...hostEnvironment(readState(config.stackDirectory)),
        ZENITH_LOCAL_DRIVER_D4: "1", ZENITH_LOCAL_TARGETS: "1", ZENITH_LOCAL_JOINED_DRIVERS: "1", ZENITH_DEFAULT_JOURNEY: "1", ZENITH_ACCEPTANCE_DEFAULT_STACK: "1",
        ZENITH_LOCAL_RUN_ID: runId, ZENITH_LOCAL_ROOT: root, ZENITH_LOCAL_JOURNEY_CONFIG_FILE: file, ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR: config.stackDirectory };
      // Start a fresh Node process so NODE_EXTRA_CA_CERTS is effective before Auth TLS traffic.
      // One process (tsx as a loader), so a signal or fatal exit of the driver is the child's own, not a wrapper's exit 1.
      const result = await defaultExec([process.execPath, "--import", "tsx", `scripts/release/drivers/${scenarioId}.ts`, "--run-id", runId, "--receipt", output],
        { cwd: process.cwd(), env, timeoutMs: 2_400_000 });
      if (result.code !== 0 && process.env.ZENITH_OPERATED_DIAGNOSTICS === "1") {
        // Shape only: line count and each line's leading word class, never content.
        const lines = result.stderr.split("\n").filter(Boolean);
        const heads = [...new Set(lines.map(line => (/^\s*([A-Za-z(][A-Za-z():_-]{0,30})/.exec(line)?.[1] ?? "other")))].slice(0, 25);
        process.stderr.write(`operated outside-step failed: child-stderr-shape ${JSON.stringify({ code: result.code, lines: lines.length, heads })}\n`);
      }
      expect(result.code, `Inspect the sanitized receipt at ${output}; raw child diagnostics are not published`).toBe(0);
      const receipt = validateOperatedReceipt(JSON.parse(readFileSync(output, "utf8")), { scenarioId, runId, sourceCommit: source.head, sourceDigest: source.contentSha256 });
      expect(receipt.checks.every(check => check.status === "passed")).toBe(true);
      expect(receipt.sourceDigest).toBe(source.contentSha256);
      expect(Object.keys(receipt.readbacks).length).toBeGreaterThan(0);
    }, 2_460_000);
  }
});
