import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { AUDIT_ARGS, assessAudit, runSecurityAudit } from "../../scripts/ci/security-audit.mjs";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawnSync: spawnMock }));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-security-audit-"));
fs.writeFileSync(path.join(root, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/example": { version: "1.0.0" } } }));
fs.mkdirSync(path.join(root, "scripts/ci"), { recursive: true });
const registryFile = path.join(root, "scripts/ci/security-exceptions.json");
const emptyRegistry = JSON.stringify({ schemaVersion: 1, exceptions: [] });
fs.writeFileSync(registryFile, emptyRegistry);
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); fs.writeFileSync(registryFile, emptyRegistry); });

function report(vulnerabilities: Record<string, unknown> = {}) {
  const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: Object.keys(vulnerabilities).length };
  for (const finding of Object.values(vulnerabilities)) counts[(finding as { severity: "high" }).severity]++;
  return { auditReportVersion: 2, vulnerabilities, metadata: { vulnerabilities: counts, dependencies: { total: 2 } } };
}
const direct = (severity = "high") => ({
  name: "example", severity, range: "<1.0.1", isDirect: false, nodes: ["node_modules/example"], effects: [], fixAvailable: false,
  via: [{ source: 1000001, name: "example", dependency: "example", title: "Synthetic vulnerable dependency advisory", url: "https://github.com/advisories/GHSA-abcd-2345-ghjk", severity, cwe: ["CWE-400"], cvss: { score: 7.5, vectorString: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H" }, range: "<1.0.1" }],
});
function child(stdout: string, status: number | null = 0, extra = {}) {
  spawnMock.mockReturnValue({ stdout, stderr: "", status, signal: null, ...extra });
}

describe("mandatory dependency audit", () => {
  it("clears only a complete zero-finding report with a successful exit", () => {
    expect(assessAudit(report(), 0).ok).toBe(true);
    for (const status of [1, 2, null]) expect(assessAudit(report(), status).ok).toBe(false);
  });

  it.each(["info", "low", "moderate", "high", "critical"])("blocks %s findings in a consistent completed audit", (severity) => {
    const result = assessAudit(report({ example: direct(severity) }), severity === "info" ? 0 : 1);
    expect(result.ok).toBe(false);
    expect(result.validated).toBe(true);
    expect(result.findings).toMatchObject([{ package: "example", advisoryIds: ["GHSA-abcd-2345-ghjk"], scope: { severity, range: "<1.0.1", fixAvailable: false } }]);
  });

  it.each(["low", "moderate", "high", "critical"])("rejects status zero for %s findings before production exception evaluation", (severity) => {
    child(JSON.stringify(report({ example: direct(severity) })), 0);
    expect(runSecurityAudit(root)).toMatchObject({ ok: false, validated: false, findings: [], reason: "npm audit exit status disagrees with the configured severity threshold." });
  });

  it("distinguishes below-threshold informational reporting from an inconsistent audit exit", () => {
    const informational = report({ example: direct("info") });
    expect(assessAudit(informational, 0)).toMatchObject({ validated: true, ok: false });
    expect(assessAudit(informational, 1)).toMatchObject({ validated: false, ok: false });
  });

  it("resolves and deduplicates advisory IDs through transitive meta-vulnerabilities", () => {
    const result = assessAudit(report({
      example: direct(), parent: { name: "parent", severity: "high", range: "*", isDirect: true, nodes: ["node_modules/parent"], effects: [], fixAvailable: false, via: ["example", "example"] },
    }), 1);
    expect(result.ok).toBe(false);
    expect(result.findings[1]).toMatchObject({ package: "parent", advisoryIds: ["GHSA-abcd-2345-ghjk"], scope: { severity: "high", range: "*", via: ["example", "example"] } });
  });

  it("accepts npm's empty range on an entry affected only through a vulnerable dependency", () => {
    const result = assessAudit(report({
      example: direct(), parent: { name: "parent", severity: "high", range: "", isDirect: true, nodes: ["node_modules/parent"], effects: [], fixAvailable: true, via: ["example"] },
    }), 1);
    expect(result).toMatchObject({ validated: true, ok: false });
    expect(result.findings[1]).toMatchObject({ package: "parent", advisoryIds: ["GHSA-abcd-2345-ghjk"], scope: { range: "", via: ["example"] } });
  });

  it.each(["missing range", "empty range", "malformed range", "missing advisory range", "missing severity", "missing title", "missing remediation", "inconsistent advisory"])("rejects incomplete or inconsistent advisory scope: %s", (kind) => {
    const finding = direct();
    if (kind === "missing range") Reflect.deleteProperty(finding, "range");
    if (kind === "empty range") finding.range = "";
    if (kind === "malformed range") finding.range = "not-a-range";
    if (kind === "missing advisory range") Reflect.deleteProperty(finding.via[0], "range");
    if (kind === "missing severity") Reflect.deleteProperty(finding.via[0], "severity");
    if (kind === "missing title") Reflect.deleteProperty(finding.via[0], "title");
    if (kind === "missing remediation") Reflect.deleteProperty(finding, "fixAvailable");
    if (kind === "inconsistent advisory") finding.via.push({ ...finding.via[0], range: "<2.0.0" });
    expect(assessAudit(report({ example: finding }), 1)).toMatchObject({ ok: false, validated: false, reason: "Malformed vulnerability scope for example." });
  });

  const malformedVersions = ["1.0.0-.", "1.0.0+.", "1.0.0-01", "1.0.0 - <=2.0.0", "1.0.0-alpha..1", "1.0.0+build..1", "01.0.0"];
  it.each(malformedVersions.flatMap((value) => ["finding range", "advisory range", "fix version"].map((field) => [field, value])))("refuses malformed %s %s before production exception evaluation", (field, value) => {
    const finding = direct();
    if (field === "finding range") finding.range = value;
    if (field === "advisory range") finding.via[0].range = value;
    if (field === "fix version") Object.assign(finding, { fixAvailable: { name: "example", version: value, isSemVerMajor: false } });
    child(JSON.stringify(report({ example: finding })), 1);
    expect(runSecurityAudit(root)).toMatchObject({ ok: false, validated: false, findings: [], reason: "Malformed vulnerability scope for example." });
  });

  it.each(["<=3.0.3", "*", ">=1.0.0 <2.0.0", "1.0.0-alpha.1+build.01", "1.0.0-0+001", ">=1.0.0-alpha.1 <2.0.0 || ^3.0.0", "1.0.0 - 2.0.0", "1.2 - 2.3", "~1.2.x"])("preserves supported complete npm scope for %s", (range) => {
    const finding = direct(); finding.range = range; finding.via[0].range = range;
    expect(assessAudit(report({ example: finding }), 1)).toMatchObject({ validated: true, ok: false, findings: [{ scope: { range } }] });
  });

  it.each(["1.0.0", "1.0.0-alpha.1+build.01", "1.0.0-0+001", "1.0.0-01a"])("permits a strict remediation version %s", (version) => {
    const finding = direct(); Object.assign(finding, { fixAvailable: { name: "example", version, isSemVerMajor: false } });
    expect(assessAudit(report({ example: finding }), 1)).toMatchObject({ validated: true, ok: false });
  });

  it.each([
    null, {}, { error: { summary: "private-registry-detail" } },
    { ...report(), auditReportVersion: 1 },
    { ...report(), metadata: { vulnerabilities: { total: 0 } } },
    { ...report(), metadata: { vulnerabilities: report().metadata.vulnerabilities, dependencies: { total: 0 } } },
    { ...report({ example: direct() }), metadata: report().metadata },
    report({ example: { ...direct(), via: ["missing"] } }),
    report({ example: { ...direct(), via: ["example"] } }),
    report({ example: { ...direct(), via: [{ url: "https://untrusted.test/GHSA-abcd-2345-ghjk" }] } }),
    report({ example: { ...direct(), nodes: [] } }),
    report({ example: { ...direct(), via: [] } }),
  ])("fails closed on an incomplete or malformed report (%#)", (input) => {
    const result = assessAudit(input, 0);
    expect(result.ok).toBe(false);
    expect(result.reason).not.toContain("private-registry-detail");
  });

  it("runs a locked audit including production, dev, optional and peer packages without installing or fixing", () => {
    vi.stubEnv("npm_execpath", "/trusted/npm-cli.js");
    child(JSON.stringify(report()));
    expect(runSecurityAudit(root).ok).toBe(true);
    expect(spawnSync).toHaveBeenCalledWith(process.execPath, ["/trusted/npm-cli.js", ...AUDIT_ARGS], expect.objectContaining({ cwd: root, timeout: 90_000 }));
    expect(AUDIT_ARGS).toEqual(expect.arrayContaining(["--package-lock-only", "--include=dev", "--include=optional", "--include=peer", "--registry=https://registry.npmjs.org"]));
    expect(AUDIT_ARGS.join(" ")).not.toMatch(/fix|force|omit|only=prod/);
  });

  it.each([
    ["invalid-json-private-marker", 0, {}],
    [JSON.stringify(report()), null, { signal: "SIGTERM" }],
    [JSON.stringify(report()), 0, { error: new Error("private-error-marker") }],
    [JSON.stringify(report()), 2, {}],
  ])("blocks registry, spawn, timeout and parse failures (%#)", (stdout, status, extra) => {
    child(stdout as string, status as number | null, extra as object);
    const result = runSecurityAudit(root);
    expect(result.ok).toBe(false);
    expect(result.reason).not.toMatch(/private-(marker|error-marker)/);
  });

  it("refuses an absent lock without contacting the registry", () => {
    expect(runSecurityAudit(path.join(root, "absent")).ok).toBe(false);
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("keeps the committed empty registry inactive and all findings blocking", () => {
    child(JSON.stringify(report({ example: direct() })), 1);
    expect(runSecurityAudit(root)).toMatchObject({ ok: false, accepted: [], unaccepted: [{ package: "example" }] });
  });

  it.each(["missing", "malformed", "wrong-schema"])("fails closed on a %s registry even with zero vulnerabilities", (kind) => {
    if (kind === "missing") fs.unlinkSync(registryFile);
    else fs.writeFileSync(registryFile, kind === "malformed" ? "not-json" : JSON.stringify({ schemaVersion: 99, exceptions: [] }));
    child(JSON.stringify(report()));
    expect(runSecurityAudit(root).ok).toBe(false);
  });

  it("preserves a failed audit before any exception evaluation", () => {
    fs.writeFileSync(registryFile, "not-json");
    child(JSON.stringify({ error: { summary: "private-registry-detail" } }), 1);
    expect(runSecurityAudit(root)).toMatchObject({ ok: false, validated: false, reason: "Invalid npm audit report or registry failure.", findings: [] });
  });

  it("ignores exception bypass environment variables", () => {
    vi.stubEnv("ZENITH_SECURITY_EXCEPTION", "accept-all"); vi.stubEnv("NPM_CONFIG_AUDIT_LEVEL", "critical");
    child(JSON.stringify(report({ example: direct("low") })), 0);
    expect(runSecurityAudit(root).ok).toBe(false);
    expect(AUDIT_ARGS).toContain("--audit-level=low");
  });
});
