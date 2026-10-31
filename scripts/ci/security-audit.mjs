/** Mandatory complete dependency gate. Only exact reviewed, expiring repository policy may accept risk. */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { applySecurityExceptions, securityFindingScope, SECURITY_EXCEPTION_FILE } from "./security-exceptions.mjs";

export const AUDIT_ARGS = [
  "audit", "--json", "--package-lock-only", "--include=dev", "--include=optional", "--include=peer",
  "--ignore-scripts", "--audit-level=low", "--registry=https://registry.npmjs.org",
  "--fetch-retries=1", "--fetch-timeout=30000",
];
const severities = ["info", "low", "moderate", "high", "critical"];
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const packageName = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i;
const advisoryUrl = /^https:\/\/github\.com\/advisories\/(GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4})$/;

/** Validate npm's complete report before interpreting zero findings as clearance. */
export function assessAudit(report, status) {
  try {
    if (!record(report) || report.error || report.auditReportVersion !== 2 || !record(report.vulnerabilities)) {
      throw new Error("Invalid npm audit report or registry failure.");
    }
    const entries = Object.entries(report.vulnerabilities);
    const counts = report.metadata?.vulnerabilities;
    if (!record(counts) || !severities.every((key) => count(counts[key])) ||
        !count(counts.total) || counts.total !== entries.length ||
        severities.reduce((sum, key) => sum + counts[key], 0) !== counts.total ||
        !count(report.metadata?.dependencies?.total) || report.metadata.dependencies.total === 0) {
      throw new Error("Incomplete or inconsistent npm audit counts.");
    }
    const idsByPackage = new Map();
    const advisoryContent = new Map();
    const scopesByPackage = new Map();
    for (const [name, finding] of entries) {
      if (!packageName.test(name) || !record(finding) || finding.name !== name ||
          !severities.includes(finding.severity) || typeof finding.isDirect !== "boolean" ||
          !Array.isArray(finding.nodes) || finding.nodes.length === 0 ||
          !finding.nodes.every((node) => typeof node === "string" && node.length > 0) ||
          !Array.isArray(finding.via) || finding.via.length === 0) {
        throw new Error("Malformed vulnerability entry.");
      }
      if (entries.filter(([, item]) => item.severity === finding.severity).length !== counts[finding.severity]) {
        throw new Error("Inconsistent npm audit severity counts.");
      }
      try {
        const scope = securityFindingScope(finding);
        scopesByPackage.set(name, scope);
        for (const via of scope.via) {
          if (typeof via === "string") continue;
          const content = JSON.stringify(via);
          if (advisoryContent.has(via.url) && advisoryContent.get(via.url) !== content) throw new Error("inconsistent advisory");
          advisoryContent.set(via.url, content);
        }
      }
      catch { throw new Error(`Malformed vulnerability scope for ${name}.`); }
    }
    // Every advisory reachable through `via`. npm reports peer cycles (eslint <-> @eslint-community/eslint-utils), so the
    // walk keeps a seen set instead of refusing a revisit; a name npm does not list is still unresolvable.
    const advisoryIds = (name) => {
      if (idsByPackage.has(name)) return idsByPackage.get(name);
      const ids = new Set(), seen = new Set(), pending = [name];
      while (pending.length) {
        const current = pending.pop();
        if (seen.has(current)) continue;
        seen.add(current);
        if (!Object.hasOwn(report.vulnerabilities, current)) throw new Error("Unresolvable npm audit dependency advisory.");
        for (const via of report.vulnerabilities[current].via) {
          if (typeof via === "string") pending.push(via);
          else {
            const match = record(via) && typeof via.url === "string" && advisoryUrl.exec(via.url);
            if (!match) throw new Error("Missing canonical advisory identifier.");
            ids.add(match[1]);
          }
        }
      }
      idsByPackage.set(name, ids);
      return ids;
    };
    const findings = entries.map(([name]) => ({ package: name, advisoryIds: [...advisoryIds(name)].sort(), scope: scopesByPackage.get(name) }));
    if (status !== 0 && status !== 1) throw new Error("npm audit did not complete successfully.");
    const aboveThreshold = entries.some(([, finding]) => finding.severity !== "info");
    if ((status === 0 && aboveThreshold) || (status === 1 && !aboveThreshold)) throw new Error("npm audit exit status disagrees with the configured severity threshold.");
    return {
      validated: true,
      ok: findings.length === 0,
      reason: findings.length ? `${findings.length} unresolved dependency findings block release.` : "No known dependency findings in the complete locked audit.",
      findings,
    };
  } catch (error) {
    return { ok: false, validated: false, reason: error.message, findings: [] };
  }
}

export function runSecurityAudit(root = process.cwd()) {
  let lockBytes;
  try {
    lockBytes = fs.readFileSync(path.join(root, "package-lock.json"));
    const lock = JSON.parse(lockBytes.toString("utf8"));
    if (![2, 3].includes(lock.lockfileVersion) || !record(lock.packages) || !lock.packages[""] || Object.keys(lock.packages).length < 2) {
      throw new Error("invalid lock");
    }
  } catch {
    return { ok: false, reason: "A complete committed package-lock.json is required.", findings: [] };
  }
  const npmCli = process.env.npm_execpath;
  const result = npmCli
    ? spawnSync(process.execPath, [npmCli, ...AUDIT_ARGS], { cwd: root, encoding: "utf8", timeout: 90_000, maxBuffer: 16 * 1024 * 1024 })
    : spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", AUDIT_ARGS, {
        cwd: root, encoding: "utf8", timeout: 90_000, maxBuffer: 16 * 1024 * 1024,
        shell: process.platform === "win32",
      });
  if (result.error || result.signal || result.status === null) {
    return { ok: false, reason: "npm audit unavailable, timed out or was interrupted.", findings: [] };
  }
  let report;
  try { report = JSON.parse(result.stdout); }
  catch { return { ok: false, reason: "npm audit returned malformed JSON.", findings: [] }; }
  const assessment = assessAudit(report, result.status);
  if (assessment.validated !== true) return assessment;
  try {
    const registry = JSON.parse(fs.readFileSync(path.join(root, SECURITY_EXCEPTION_FILE), "utf8"));
    // The CLI clock and fixed committed registry have no environment/flag override.
    return applySecurityExceptions(assessment, report, lockBytes, registry, root);
  } catch {
    return { ...assessment, ok: false, reason: "The committed security exception registry is missing, unreadable or malformed; the gate remains blocked.", accepted: [], unaccepted: assessment.findings, exceptions: [] };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = runSecurityAudit();
  // Never print the raw registry response: errors may contain private details.
  const emit = result.ok ? console.log : console.error;
  emit(result.reason);
  const accepted = new Set((result.accepted ?? []).map((f) => f.package));
  for (const finding of result.findings) emit(`${accepted.has(finding.package) ? "REVIEWED EXCEPTION: " : ""}${finding.package}: ${finding.advisoryIds.join(", ")}`);
  for (const exception of result.exceptions ?? []) emit(`${exception.id}: ${exception.advisoryId}; review due ${exception.reviewDueAt}; expires ${exception.expiresAt}`);
  process.exitCode = result.ok ? 0 : 1;
}
