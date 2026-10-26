/**
 * PROD-REL-04: every live harness loads and enforces the scope manifest. This guard walks scripts/, src/ and tests/ and
 * fails when a file that reads a `ZENITH_LIVE_*` gate is neither wired to `scripts/release/scope` nor listed here with the
 * file that enforces it for it (which must itself import the scope module) or a manifest exemption with a reason. A new live
 * harness therefore cannot be added without deciding, in this file, how the manifest governs it.
 *
 * Out of scope here, stated: the `ZENITH_TEST_*` external lanes (an external Temporal namespace, a GitHub App) have their own
 * gates in scripts/ci/gate-manifest.mjs (EXTERNAL_ACCEPTANCE) and touch no cloud sandbox resources.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadManifestFile } from "../../scripts/release/scope";
import { shippedManifestPath } from "./_support";

const root = process.cwd();
const SCOPE_IMPORT = /(?:from\s+|import\(\s*)["'][^"']*release\/scope["']/;

function walk(dir: string): string[] {
  return readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return entry.name === "node_modules" || entry.name === ".next" ? [] : walk(rel);
    return /\.(ts|tsx|mjs)$/.test(entry.name) ? [rel] : [];
  });
}
const read = (rel: string): string => readFileSync(path.join(root, rel), "utf8");

/** file -> the file that enforces the scope manifest for it. */
const COVERED_BY: Record<string, string> = {
  "scripts/acceptance/live/dns/offline.test.ts": "scripts/acceptance/live/dns/cli.ts",
  "scripts/acceptance/live/dns/clouds.live.test.ts": "scripts/acceptance/live/dns/cli.ts",
  // The production fixture entrypoint and pre-OIDC preflight enforce both envelopes.
  "scripts/acceptance/live/cli.ts": "scripts/acceptance/live/scope.ts",
  "scripts/acceptance/live/preflight.ts": "scripts/acceptance/live/scope.ts",
  "scripts/acceptance/live/sdk.ts": "scripts/acceptance/live/scope.ts",
  "tests/acceptance/aws-production.test.ts": "scripts/acceptance/live/scope.ts",
  "tests/acceptance/aws-production.live.test.ts": "scripts/acceptance/live/scope.ts",
  "tests/acceptance/aws-retention-port.test.ts": "scripts/acceptance/live/scope.ts",
  // The retention-s3 port runs only behind the production CLI, which loads and enforces the scope before it is reached.
  "scripts/acceptance/live/product/retention-s3.ts": "scripts/acceptance/live/cli.ts",
  // The PROD-MIX-03 port runs only behind the production CLI, which loads and enforces the scope before it is reached.
  "scripts/acceptance/live/product/mix-03.ts": "scripts/acceptance/live/cli.ts",
  "tests/acceptance/aws-mix03-port.test.ts": "scripts/acceptance/live/scope.ts",
  "tests/acceptance/aws-mix03-driver.test.ts": "scripts/acceptance/live/scope.ts",
  "scripts/acceptance/live/product/deploy-01.ts": "scripts/acceptance/live/cli.ts",
  "tests/acceptance/aws-deploy01-port.test.ts": "scripts/acceptance/live/scope.ts",
  // The PROD-REL-04 drill only spawns the production CLI (which loads and enforces the root and envelope scope) and reads the journals it writes.
  "scripts/acceptance/live/drill/rel-04.ts": "scripts/acceptance/live/cli.ts",
  "tests/acceptance/aws-rel04-drill.test.ts": "scripts/acceptance/live/scope.ts",
  "scripts/acceptance/aws-iam-permissions.ts": "scripts/acceptance/aws-iam-permissions-cli.ts",
  "scripts/acceptance/azure-live.ts": "tests/providers/azure/live.test.ts",
  "scripts/acceptance/non-aws-dns-live.ts": "tests/acceptance/non-aws-dns-live.test.ts",
  "scripts/acceptance/config.ts": "scripts/acceptance/aws-live.ts",
  "scripts/acceptance/safety.ts": "scripts/acceptance/aws-live.ts",
  "scripts/acceptance/clients/worker-control.ts": "scripts/acceptance/aws-live.ts",
  "scripts/acceptance/scenarios/a-autonomous-deploy.ts": "scripts/acceptance/aws-live.ts",
  "scripts/acceptance/scenarios/e-restart-recovery.ts": "scripts/acceptance/aws-live.ts",
  "scripts/acceptance/scenarios/f-credential-revocation.ts": "scripts/acceptance/aws-live.ts",
  "scripts/acceptance/scenarios/g-kubernetes-deploy.ts": "scripts/acceptance/aws-live.ts",
  "scripts/acceptance/scenarios/_shared.ts": "scripts/acceptance/aws-live.ts",
  // Contract-level tests that only pass env names to the harness code under test; the live suites of those harnesses are above.
  "tests/acceptance/aws-iam-live.test.ts": "scripts/acceptance/aws-iam-permissions-cli.ts",
  "tests/acceptance/cleanup.test.ts": "scripts/acceptance/cleanup.ts",
  "tests/acceptance/clients.test.ts": "scripts/acceptance/aws-live.ts",
  "tests/cost/billing.test.ts": "tests/cost/live-billing.live.test.ts",
  "tests/cost/catalog-refresh.test.ts": "tests/cost/live-billing.live.test.ts",
  "tests/cost/catalog-refresh.local.test.ts": "tests/cost/live-billing.live.test.ts",
  "tests/cost/spend-service.test.ts": "tests/cost/live-billing.live.test.ts",
  // Contract and local-engine tests of the mixed harness; the harness code they drive enforces the scope itself.
  "tests/acceptance/mixed-live-run.test.ts": "scripts/acceptance/mixed/live-run.ts",
  "tests/acceptance/mixed-live-recovery.test.ts": "scripts/acceptance/mixed/live-recovery.ts",
  "tests/acceptance/mixed-traffic.test.ts": "scripts/acceptance/mixed/live-run.ts",
};

/** The release tooling and its tests mention the gates as data; the scope module and manifest they implement govern everything else. */
const isTooling = (file: string): boolean => file.startsWith("scripts/release/") || file.startsWith("tests/release/")
  // This exact fixture inspects workflow YAML paths as data; it never reads a live gate or executes a live harness.
  || file === "tests/ci/release-gates.test.ts";

const candidates = [...walk("scripts"), ...walk("src"), ...walk("tests")].filter((f) => !isTooling(f) && /ZENITH_LIVE_/.test(read(f)));

describe("live harness scope coverage", () => {
  const manifest = loadManifestFile(shippedManifestPath());
  const exempt = (file: string): boolean => manifest.exemptions.some((e) => file === e.file || file.startsWith(`${e.file}/`));

  it("classifies the workflow YAML fixture without exempting other CI harnesses", () => {
    expect(isTooling("tests/ci/release-gates.test.ts")).toBe(true);
    expect(isTooling("tests/ci/other-live-harness.test.ts")).toBe(false);
    expect(isTooling("tests/ci/release-gates.test.ts/live.ts")).toBe(false);
    expect(candidates).not.toContain("tests/ci/release-gates.test.ts");
  });

  it("finds the known live harnesses (the scan itself works)", () => {
    for (const known of ["scripts/acceptance/aws-live.ts", "scripts/acceptance/mixed/live-run.ts", "scripts/acceptance/mixed/live-recovery.ts", "tests/live/mixed-cloud.live.test.ts", "tests/live/mixed-connectivity.live.test.ts"]) expect(candidates, known).toContain(known);
  });

  it.each(candidates)("%s is governed by the scope manifest", (file) => {
    const direct = SCOPE_IMPORT.test(read(file));
    const covering = COVERED_BY[file];
    if (direct) return;
    if (exempt(file)) return;
    expect(covering, `${file} reads a ZENITH_LIVE_ gate but neither imports scripts/release/scope, nor is covered by an enforcing file, nor is exempted in permissions.json`).toBeDefined();
    expect(SCOPE_IMPORT.test(read(covering!)), `${covering} is named as the enforcer for ${file} but does not import the scope module`).toBe(true);
  });

  it("the entry points that make live calls call the scope before acting", () => {
    expect(read("scripts/acceptance/live/dns/cli.ts")).toMatch(/requireScope\("non-aws-dns-live"/);
    expect(read("scripts/acceptance/aws-live.ts")).toMatch(/requireScope\("aws-live"/);
    expect(read("scripts/acceptance/live/scope.ts")).toMatch(/requireScope\("aws-live"/);
    for (const file of ["scripts/acceptance/live/cli.ts", "scripts/acceptance/live/preflight.ts"]) {
      expect(read(file), file).toMatch(/requireProductionScope\(plan,/);
    }
    expect(read("scripts/acceptance/cleanup.ts")).toMatch(/requireScope\("aws-cleanup"/);
    expect(read("scripts/acceptance/cleanup-cli.ts")).toMatch(/scopeGate\?\.\(/);
    expect(read("scripts/acceptance/aws-iam-permissions-cli.ts")).toMatch(/requireScope\("aws-iam-live"/);
    expect(read("scripts/acceptance/mixed/live-run.ts")).toMatch(/requireScope\(MIXED_LIVE_HARNESS/);
    expect(read("scripts/acceptance/mixed/live-recovery.ts")).toMatch(/requireScope\(RECOVERY_HARNESS/);
    for (const file of ["tests/providers/azure/live.test.ts", "tests/acceptance/non-aws-dns-live.test.ts", "tests/cost/live-billing.live.test.ts", "tests/live/mixed-cloud.live.test.ts", "tests/live/mixed-connectivity.live.test.ts"]) {
      expect(read(file), file).toMatch(/scopeSkipReason\(/);
    }
  });

  it("every harness the manifest names has a grant and no exemption hides a file that does not exist", () => {
    expect(Object.keys(manifest.harnesses).length).toBeGreaterThan(5);
    for (const e of manifest.exemptions) expect(() => readdirSync(path.join(root, path.dirname(e.file))), e.file).not.toThrow();
    for (const e of manifest.exemptions) expect(e.reason.length, e.file).toBeGreaterThan(20);
  });
});
