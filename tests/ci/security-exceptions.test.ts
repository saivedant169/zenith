/** Synthetic policy records test validation only; these identities/references attest no human approval. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assessAudit } from "../../scripts/ci/security-audit.mjs";
import { applySecurityExceptions, evaluateSecurityExceptions, lockedReachability, securityFindingScope, securitySourceDigest, securityExceptionApprovalPayload, SECURITY_EXCEPTION_AUTHORITY_FILE } from "../../scripts/ci/security-exceptions.mjs";

const ADVISORY = "GHSA-abcd-2345-ghjk";
const OTHER_ADVISORY = "GHSA-2222-3333-4444";
const NOW = Date.parse("2026-10-03T01:00:00.000Z");
const CHAIN = ["dev-config", "dev-plugin", "glob", "matcher", "vulnerable"];
const sha = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
const integrity = () => `sha512-${Buffer.alloc(64, 7).toString("base64")}`;
type LockedNode = {
  version?: string; integrity?: string; dev?: boolean; link?: boolean;
  dependencies?: Record<string, string>; devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>; peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};
const advisory = (id = ADVISORY, name = "vulnerable") => ({ source: 1000001, name, dependency: name, title: "Synthetic vulnerable dependency advisory", url: `https://github.com/advisories/${id}`, severity: "high", cwe: ["CWE-400"], cvss: { score: 7.5, vectorString: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H" }, range: "<1.0.1" });
type Vulnerability = { name: string; severity: string; range: string; isDirect: boolean; nodes: string[]; effects: string[]; fixAvailable: boolean | { name: string; version: string; isSemVerMajor: boolean }; via: (string | ReturnType<typeof advisory>)[] };
const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of dirs.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-exception-policy-")); dirs.push(root);
  const packageJson = { dependencies: { runtime: "1.0.0" } as Record<string, string>, devDependencies: { "dev-config": "1.0.0" } as Record<string, string> };
  const packages: Record<string, LockedNode> = {
    "": structuredClone(packageJson), "node_modules/runtime": { version: "1.0.0", integrity: integrity() },
  };
  const vulnerabilities: Record<string, Vulnerability> = {};
  for (const [index, name] of CHAIN.entries()) {
    packages[`node_modules/${name}`] = { version: "1.0.0", integrity: integrity(), dev: true,
      ...(CHAIN[index + 1] ? { dependencies: { [CHAIN[index + 1]]: "1.0.0" } } : {}) };
    vulnerabilities[name] = { name, severity: "high", range: index === CHAIN.length - 1 ? "<1.0.1" : "*", isDirect: index === 0, nodes: [`node_modules/${name}`], effects: index ? [CHAIN[index - 1]] : [], fixAvailable: false,
      via: CHAIN[index + 1] ? [CHAIN[index + 1]] : [advisory()] };
  }
  const lock = { lockfileVersion: 3, packages };
  const report = { auditReportVersion: 2, vulnerabilities, metadata: {
    vulnerabilities: { info: 0, low: 0, moderate: 0, high: CHAIN.length, critical: 0, total: CHAIN.length }, dependencies: { total: CHAIN.length + 1 },
  } };
  fs.mkdirSync(path.join(root, "docs"));
  fs.writeFileSync(path.join(root, "docs/review.md"), "Synthetic pinned evidence, not a real reachability review or approval.\n");
  fs.mkdirSync(path.join(root, "src/app/[id]"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/app/[id]/route.ts"), "export const synthetic = true;\n");
  // Private KeyObjects stay in memory only. These synthetic anchors attest no real identity.
  const keys = { reviewer: generateKeyPairSync("ed25519"), operator: generateKeyPairSync("ed25519") };
  const authority = {
    schemaVersion: 1, repository: "GODOSTROYER/zenith",
    reviewerKeys: [{ id: "synthetic-review-key", actor: "synthetic-reviewer", publicKeyPem: keys.reviewer.publicKey.export({ type: "spki", format: "pem" }).toString() }],
    operatorKeys: [{ id: "synthetic-operator-key", actor: "synthetic-operator", publicKeyPem: keys.operator.publicKey.export({ type: "spki", format: "pem" }).toString() }],
  };
  const f = { root, packageJson, lock, report, keys, authority };
  write(f);
  return f;
}
function write(f: ReturnType<typeof fixture>) {
  fs.writeFileSync(path.join(f.root, "package.json"), JSON.stringify(f.packageJson));
  const bytes = Buffer.from(`${JSON.stringify(f.lock, null, 2)}\n`);
  fs.writeFileSync(path.join(f.root, "package-lock.json"), bytes);
  return bytes;
}
function exception(f: ReturnType<typeof fixture>) {
  const sources = [{ file: "docs/review.md", sha256: sha(fs.readFileSync(path.join(f.root, "docs/review.md"))) }];
  const entry = {
    id: "sec-synthetic-review", status: "approved", advisoryId: ADVISORY,
    advisoryScope: Object.values(f.report.vulnerabilities).map(securityFindingScope).sort((a, b) => a.package.localeCompare(b.package)),
    lockSha256: sha(fs.readFileSync(path.join(f.root, "package-lock.json"))), sourceSha256: securitySourceDigest(f.root),
    affectedNodes: CHAIN.map((name) => ({ package: name, node: `node_modules/${name}`, version: "1.0.0", integrity: integrity() })),
    owner: "synthetic-policy-owner", issuedAt: "2026-10-03T00:00:00.000Z", reviewDueAt: "2026-10-04T00:15:00.000Z", expiresAt: "2026-10-10T00:00:00.000Z",
    review: { keyId: "synthetic-review-key", signature: "", reviewer: "synthetic-reviewer", decision: "approved", reviewedAt: "2026-10-03T00:15:00.000Z", reference: "https://github.com/GODOSTROYER/zenith/pull/999999999#pullrequestreview-999999999" },
    approval: { keyId: "synthetic-operator-key", signature: "", operator: "synthetic-operator", decision: "approved", approvedAt: "2026-10-03T00:30:00.000Z", reference: "https://github.com/GODOSTROYER/zenith/pull/999999999#issuecomment-999999999" },
    reachability: { summary: "Synthetic dev-only graph; no real shipped inventory or risk approval is attested.", sources: structuredClone(sources) },
    mitigations: { summary: "Synthetic isolated-tooling controls; this fixture accepts no actual advisory.", sources: structuredClone(sources) },
    primarySources: [`https://github.com/advisories/${ADVISORY}`],
  };
  return signRecord(f, entry);
}
function signRecord<T>(f: ReturnType<typeof fixture>, entry: T): T {
  const approvals = entry as { review?: { signature: string }; approval?: { signature: string } };
  if (approvals.review) approvals.review.signature = sign(null, securityExceptionApprovalPayload(entry, "reviewer"), f.keys.reviewer.privateKey).toString("base64");
  if (approvals.approval) approvals.approval.signature = sign(null, securityExceptionApprovalPayload(entry, "operator"), f.keys.operator.privateKey).toString("base64");
  return entry;
}
function evaluate(f: ReturnType<typeof fixture>, entries: ReturnType<typeof exception>[], now = NOW) {
  return evaluateSecurityExceptions(assessAudit(f.report, 1), f.report, fs.readFileSync(path.join(f.root, "package-lock.json")), { schemaVersion: 1, exceptions: entries }, f.root, now, f.authority);
}
function rebind(f: ReturnType<typeof fixture>, entry: ReturnType<typeof exception>) {
  entry.lockSha256 = sha(write(f)); entry.sourceSha256 = securitySourceDigest(f.root); signRecord(f, entry);
}
// A virtual fixed trust-store read for production-entrypoint tests. No authority file is written.
function mockFixedAuthority(f: ReturnType<typeof fixture>, afterRead?: (file: fs.PathOrFileDescriptor) => void) {
  const fd = 2147483646;
  const realpath = fs.realpathSync.bind(fs), lstat = fs.lstatSync.bind(fs), stat = fs.statSync.bind(fs);
  const open = fs.openSync.bind(fs), fstat = fs.fstatSync.bind(fs), read = fs.readFileSync.bind(fs), close = fs.closeSync.bind(fs);
  vi.spyOn(fs, "realpathSync").mockImplementation((file, options) => file.toString() === SECURITY_EXCEPTION_AUTHORITY_FILE ? SECURITY_EXCEPTION_AUTHORITY_FILE : realpath(file, options));
  vi.spyOn(fs, "lstatSync").mockImplementation((file, options) => file.toString() === SECURITY_EXCEPTION_AUTHORITY_FILE ? { isSymbolicLink: () => false } as fs.Stats : lstat(file, options));
  vi.spyOn(fs, "statSync").mockImplementation((file, options) => ["/", "/etc", "/etc/zenith"].includes(file.toString()) ? { isDirectory: () => true, uid: 0, mode: 0o755 } as fs.Stats : stat(file, options));
  vi.spyOn(fs, "openSync").mockImplementation((file, flags, mode) => file.toString() === SECURITY_EXCEPTION_AUTHORITY_FILE ? fd : open(file, flags, mode));
  vi.spyOn(fs, "fstatSync").mockImplementation((file, options) => file === fd ? { isFile: () => true, uid: 0, mode: 0o644, size: 2048 } as fs.Stats : fstat(file, options));
  vi.spyOn(fs, "readFileSync").mockImplementation((file, options) => {
    const result = file === fd ? JSON.stringify(f.authority) : read(file, options);
    afterRead?.(file);
    return result;
  });
  vi.spyOn(fs, "closeSync").mockImplementation((file) => { if (file !== fd) close(file); });
}

describe("reviewed expiring development-only exception policy", () => {
  it("keeps an empty registry blocking all five inherited findings", () => {
    const f = fixture();
    expect(evaluate(f, [])).toMatchObject({ ok: false, accepted: [], unaccepted: expect.any(Array) });
    expect(evaluate(f, []).unaccepted).toHaveLength(5);
  });

  it("covers exactly five propagated findings while keeping the known vulnerability visible", () => {
    const f = fixture(); const record = exception(f); const result = evaluate(f, [record]);
    expect(result).toMatchObject({ ok: true, validated: true, unaccepted: [], reason: "5 known dependency findings remain present; 5 covered by reviewed expiring exceptions, 0 unaccepted." });
    expect(result.findings).toHaveLength(5); expect(result.accepted).toHaveLength(5);
    expect(result.exceptions).toEqual([{ id: record.id, advisoryId: ADVISORY, reviewDueAt: record.reviewDueAt, expiresAt: record.expiresAt }]);
    expect(result.reason).not.toMatch(/zero|No known/i);
  });

  it.each(["severity", "advisory severity", "advisory range", "propagated range", "title", "CVSS", "CWE", "remediation"])("invalidates unchanged GHSA signatures when current %s changes", (field) => {
    const f = fixture(); const r = exception(f);
    const direct = f.report.vulnerabilities.vulnerable.via[0] as ReturnType<typeof advisory>;
    if (field === "severity") {
      for (const finding of Object.values(f.report.vulnerabilities)) finding.severity = "critical";
      direct.severity = "critical"; f.report.metadata.vulnerabilities.high = 0; f.report.metadata.vulnerabilities.critical = CHAIN.length;
    }
    if (field === "advisory severity") direct.severity = "moderate";
    if (field === "advisory range") direct.range = "<2.0.0";
    if (field === "propagated range") f.report.vulnerabilities["dev-config"].range = "<2.0.0";
    if (field === "title") direct.title = "Changed advisory scope needs a fresh review";
    if (field === "CVSS") direct.cvss.score = 9.8;
    if (field === "CWE") direct.cwe = ["CWE-1333"];
    if (field === "remediation") f.report.vulnerabilities["dev-config"].fixAvailable = { name: "dev-config", version: "2.0.0", isSemVerMajor: true };
    expect(assessAudit(f.report, 1).validated).toBe(true);
    expect(evaluate(f, [r])).toMatchObject({ ok: false, accepted: [], unaccepted: expect.any(Array) });
  });

  it.each(["missing finding range", "malformed finding range", "missing advisory range", "malformed advisory range", "missing advisory severity", "missing advisory title", "missing remediation"])("refuses incomplete current scope: %s", (field) => {
    const f = fixture(); const r = exception(f); const direct = f.report.vulnerabilities.vulnerable.via[0] as ReturnType<typeof advisory>;
    if (field === "missing finding range") Reflect.deleteProperty(f.report.vulnerabilities["dev-config"], "range");
    if (field === "malformed finding range") f.report.vulnerabilities["dev-config"].range = "not-a-range";
    if (field === "missing advisory range") Reflect.deleteProperty(direct, "range");
    if (field === "malformed advisory range") Object.assign(direct, { range: { private: "scope-canary" } });
    if (field === "missing advisory severity") Reflect.deleteProperty(direct, "severity");
    if (field === "missing advisory title") Reflect.deleteProperty(direct, "title");
    if (field === "missing remediation") Reflect.deleteProperty(f.report.vulnerabilities["dev-config"], "fixAvailable");
    const assessment = assessAudit(f.report, 1);
    expect(assessment).toMatchObject({ ok: false, validated: false });
    expect(evaluateSecurityExceptions(assessment, f.report, write(f), { schemaVersion: 1, exceptions: [r] }, f.root, NOW, f.authority)).toEqual(assessment);
    expect(JSON.stringify(assessment)).not.toContain("scope-canary");
  });

  it("requires fresh signatures for an updated signed advisory snapshot", () => {
    const f = fixture(); const r = exception(f);
    f.report.vulnerabilities["dev-config"].range = "<2.0.0";
    r.advisoryScope = Object.values(f.report.vulnerabilities).map(securityFindingScope).sort((a, b) => a.package.localeCompare(b.package));
    expect(evaluate(f, [r]).ok).toBe(false);
    signRecord(f, r); expect(evaluate(f, [r]).ok).toBe(true);
  });

  const malformedVersions = ["1.0.0-.", "1.0.0+.", "1.0.0-01", "1.0.0 - <=2.0.0"];
  it.each(malformedVersions.flatMap((value) => ["finding range", "advisory range", "fix version"].map((field) => [field, value])))("rejects freshly signed malformed %s %s", (field, value) => {
    const f = fixture(); const r = exception(f); const previouslyValid = assessAudit(f.report, 1);
    const direct = f.report.vulnerabilities.vulnerable.via[0] as ReturnType<typeof advisory>;
    const snapshot = r.advisoryScope.find((scope) => scope.package === "vulnerable")!;
    if (field === "finding range") { f.report.vulnerabilities.vulnerable.range = value; snapshot.range = value; }
    if (field === "advisory range") {
      direct.range = value;
      (snapshot.via[0] as { range: string }).range = value;
    }
    if (field === "fix version") {
      const fix = { name: "vulnerable", version: value, isSemVerMajor: false };
      f.report.vulnerabilities.vulnerable.fixAvailable = fix; snapshot.fixAvailable = structuredClone(fix);
    }
    // Both synthetic signatures authorize the malformed snapshot; grammar must still refuse it.
    signRecord(f, r);
    const current = assessAudit(f.report, 1), bytes = fs.readFileSync(path.join(f.root, "package-lock.json"));
    const registry = { schemaVersion: 1, exceptions: [r] };
    expect(current).toMatchObject({ validated: false, ok: false, reason: expect.stringMatching(/^Malformed vulnerability scope for [a-z0-9@/._-]+\.$/) });
    expect(applySecurityExceptions(current, f.report, bytes, registry, f.root)).toEqual(current);
    expect(evaluateSecurityExceptions(current, f.report, bytes, registry, f.root, NOW, f.authority)).toEqual(current);
    expect(evaluateSecurityExceptions(previouslyValid, f.report, bytes, registry, f.root, NOW, f.authority)).toMatchObject({ ok: false, accepted: [] });
    expect(JSON.stringify(current)).not.toContain(value);
  });

  it.each(["<=3.0.3", "*", ">=1.0.0 <2.0.0", "1.0.0-alpha.1+build.01", "1.0.0-0+001", ">=1.0.0-alpha.1 <2.0.0 || ^3.0.0", "1.0.0 - 2.0.0"])("accepts a synthetic signed scope using supported range %s", (range) => {
    const f = fixture(); f.report.vulnerabilities.vulnerable.range = range;
    (f.report.vulnerabilities.vulnerable.via[0] as ReturnType<typeof advisory>).range = range;
    f.report.vulnerabilities.vulnerable.fixAvailable = { name: "vulnerable", version: "1.0.1-alpha.1+build.01", isSemVerMajor: false };
    const r = exception(f);
    expect(evaluate(f, [r])).toMatchObject({ validated: true, ok: true, unaccepted: [], accepted: expect.any(Array) });
    expect(evaluate(f, [r]).findings).toHaveLength(5);
  });

  it("compares signed scope independently of JSON object key ordering", () => {
    const f = fixture(); const r = exception(f);
    r.advisoryScope = JSON.parse(securityExceptionApprovalPayload(r, "reviewer").toString("utf8")).record.advisoryScope;
    // Reordering JSON object properties changes no signed canonical bytes.
    expect(evaluate(f, [r]).ok).toBe(true);
  });

  it.each(["reviewDueAt", "expiresAt"] as const)("rechecks production %s after evidence IO at exact/past boundaries", (field) => {
    for (const offset of [0, 1]) {
      const f = fixture(); const r = exception(f); const boundary = NOW + 1000;
      r.reviewDueAt = new Date(boundary).toISOString();
      if (field === "expiresAt") r.expiresAt = r.reviewDueAt;
      signRecord(f, r);
      const assessment = assessAudit(f.report, 1), bytes = fs.readFileSync(path.join(f.root, "package-lock.json"));
      const evidenceFile = fs.realpathSync(path.join(f.root, "docs/review.md"));
      let currentTime = NOW;
      mockFixedAuthority(f, (file) => { if (file.toString() === evidenceFile) currentTime = boundary + offset; });
      vi.spyOn(Date, "now").mockImplementation(() => currentTime);
      const result = applySecurityExceptions(assessment, f.report, bytes, { schemaVersion: 1, exceptions: [r] }, f.root);
      expect(currentTime).toBe(boundary + offset);
      expect(result).toMatchObject({ ok: false, accepted: [], unaccepted: expect.any(Array) });
      vi.restoreAllMocks();
    }
  });

  it("keeps synthetic clock injection exclusive to the verification core", () => {
    const f = fixture(); const r = exception(f); const assessment = assessAudit(f.report, 1), bytes = write(f);
    expect(evaluateSecurityExceptions(assessment, f.report, bytes, { schemaVersion: 1, exceptions: [r] }, f.root, NOW, f.authority).ok).toBe(true);
    mockFixedAuthority(f); vi.spyOn(Date, "now").mockReturnValue(Date.parse(r.reviewDueAt));
    expect(applySecurityExceptions(assessment, f.report, bytes, { schemaVersion: 1, exceptions: [r] }, f.root).ok).toBe(false);
    expect(Reflect.apply(applySecurityExceptions, undefined, [assessment, f.report, bytes, { schemaVersion: 1, exceptions: [r] }, f.root, NOW]).ok).toBe(false);
  });

  it("allows production validation before the deadline using the fixed authority reader", () => {
    const f = fixture(); const r = exception(f); const assessment = assessAudit(f.report, 1), bytes = write(f);
    mockFixedAuthority(f); const clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
    expect(applySecurityExceptions(assessment, f.report, bytes, { schemaVersion: 1, exceptions: [r] }, f.root).ok).toBe(true);
    expect(clock).toHaveBeenCalledTimes(2);
  });

  it("fails closed without the fixed external approval authority, even with syntactically approved metadata", () => {
    const f = fixture(); const r = exception(f);
    vi.spyOn(fs, "realpathSync").mockImplementationOnce(() => { throw new Error("synthetic missing authority"); });
    const result = applySecurityExceptions(assessAudit(f.report, 1), f.report, write(f), { schemaVersion: 1, exceptions: [r] }, f.root);
    expect(result).toMatchObject({ ok: false, accepted: [], unaccepted: expect.any(Array) });
    expect(result.unaccepted).toHaveLength(5);
  });

  it.each(["checkout anchor", "symlink anchor", "writable parent", "untrusted parent owner"])("rejects an unsafe external trust store: %s", (kind) => {
    const f = fixture(); const r = exception(f); const lockBytes = fs.readFileSync(path.join(f.root, "package-lock.json"));
    vi.spyOn(fs, "realpathSync").mockImplementation((file) => file.toString() === SECURITY_EXCEPTION_AUTHORITY_FILE
      ? (kind === "checkout anchor" ? path.join(f.root, "authority.json") : SECURITY_EXCEPTION_AUTHORITY_FILE)
      : f.root);
    vi.spyOn(fs, "lstatSync").mockReturnValue({ isSymbolicLink: () => kind === "symlink anchor" } as fs.Stats);
    vi.spyOn(fs, "statSync").mockReturnValue({ isDirectory: () => true, uid: kind === "untrusted parent owner" ? 1 : 0, mode: kind === "writable parent" ? 0o777 : 0o755 } as fs.Stats);
    const open = vi.spyOn(fs, "openSync").mockImplementation(() => { throw new Error("unsafe anchor must never be opened"); });
    const result = applySecurityExceptions(assessAudit(f.report, 1), f.report, lockBytes, { schemaVersion: 1, exceptions: [r] }, f.root);
    expect(result.ok).toBe(false); expect(open).not.toHaveBeenCalled();
  });

  it("rejects a signature for another repository domain even from an otherwise trusted key", () => {
    const f = fixture(); const r = exception(f);
    const request = JSON.parse(securityExceptionApprovalPayload(r, "reviewer").toString("utf8")); request.repository = "another/repository";
    r.review.signature = sign(null, Buffer.from(JSON.stringify(request)), f.keys.reviewer.privateKey).toString("base64");
    expect(evaluate(f, [r]).ok).toBe(false);
  });

  it.each(["review", "approval"] as const)("requires a valid %s signature instead of trusting identity metadata", (field) => {
    const f = fixture(); const r = exception(f);
    Reflect.deleteProperty(r[field], "signature"); expect(evaluate(f, [r]).ok).toBe(false);
    r[field].signature = Buffer.alloc(64, 9).toString("base64"); expect(evaluate(f, [r]).ok).toBe(false);
  });

  it("rejects signatures from unknown keys, another role, another actor or another repository", () => {
    const f = fixture(); const r = exception(f);
    r.review.keyId = "untrusted-key"; signRecord(f, r); expect(evaluate(f, [r]).ok).toBe(false);
    r.review.keyId = "synthetic-operator-key"; signRecord(f, r); expect(evaluate(f, [r]).ok).toBe(false);
    r.review.keyId = "synthetic-review-key"; r.review.reviewer = "another-reviewer"; signRecord(f, r); expect(evaluate(f, [r]).ok).toBe(false);
    r.review.reviewer = "synthetic-reviewer"; signRecord(f, r); f.authority.repository = "another/repository";
    expect(evaluate(f, [r]).ok).toBe(false);
  });

  it("rejects duplicate role anchors, shared signing keys and self review", () => {
    const f = fixture(); const r = exception(f);
    f.authority.operatorKeys[0].id = f.authority.reviewerKeys[0].id; expect(evaluate(f, [r]).ok).toBe(false);
    f.authority.operatorKeys[0].id = "synthetic-operator-key";
    f.authority.operatorKeys[0].publicKeyPem = f.authority.reviewerKeys[0].publicKeyPem; expect(evaluate(f, [r]).ok).toBe(false);
    f.authority.operatorKeys[0].publicKeyPem = f.keys.operator.publicKey.export({ type: "spki", format: "pem" }).toString();
    f.authority.operatorKeys[0].actor = "synthetic-reviewer"; r.approval.operator = "synthetic-reviewer"; signRecord(f, r);
    expect(evaluate(f, [r]).ok).toBe(false);
  });

  it.each(["record ID", "owner", "expiry", "review reference", "mitigation summary", "evidence hash", "node version"])("binds signatures to the complete request: %s", (field) => {
    const f = fixture(); const r = exception(f);
    if (field === "record ID") r.id = "sec-synthetic-other";
    if (field === "owner") r.owner = "another-owner";
    if (field === "expiry") r.expiresAt = "2026-10-09T00:00:00.000Z";
    if (field === "review reference") r.review.reference = "https://github.com/GODOSTROYER/zenith/pull/999999998";
    if (field === "mitigation summary") r.mitigations.summary = "Another mitigation narrative must receive fresh independent signatures.";
    if (field === "evidence hash") r.reachability.sources[0].sha256 = "0".repeat(64);
    if (field === "node version") r.affectedNodes[0].version = "2.0.0";
    expect(evaluate(f, [r]).ok).toBe(false);
  });

  it("uses distinct signature purposes and rejects signatures from another request", () => {
    const f = fixture(); const r = exception(f);
    r.review.signature = sign(null, securityExceptionApprovalPayload(r, "operator"), f.keys.reviewer.privateKey).toString("base64");
    expect(evaluate(f, [r]).ok).toBe(false);
    const another = exception(f); another.id = "sec-other-request"; signRecord(f, another);
    r.review.signature = another.review.signature; expect(evaluate(f, [r]).ok).toBe(false);
    signRecord(f, r); expect(evaluate(f, [r]).ok).toBe(true);
    f.authority.reviewerKeys = []; expect(evaluate(f, [r]).ok).toBe(false);
  });

  it("rejects malformed public authority material without leaking it", () => {
    const f = fixture(); const r = exception(f); const canary = randomBytes(24).toString("hex");
    f.authority.reviewerKeys[0].publicKeyPem = canary;
    const result = evaluate(f, [r]); expect(result.ok).toBe(false); expect(JSON.stringify(result)).not.toContain(canary);
  });

  const hostile: [string, (r: ReturnType<typeof exception>) => void][] = [
    ["missing signed advisory scope", (r) => { Reflect.deleteProperty(r, "advisoryScope"); }],
    ["missing approval", (r) => { Reflect.deleteProperty(r, "approval"); }],
    ["missing reviewer", (r) => { Reflect.deleteProperty(r.review, "reviewer"); }],
    ["null reviewer", (r) => { Object.assign(r.review, { reviewer: null }); }],
    ["null operator", (r) => { Object.assign(r.approval, { operator: null }); }],
    ["unreviewed proposal", (r) => { r.status = "proposed-not-approved"; }],
    ["missing approval reference", (r) => { r.approval.reference = ""; }],
    ["another repository's review", (r) => { r.review.reference = "https://github.com/untrusted/example/pull/1"; }],
    ["denied review", (r) => { r.review.decision = "denied"; }],
    ["expired", (r) => { r.expiresAt = "2026-10-03T01:00:00.000Z"; r.reviewDueAt = r.expiresAt; }],
    ["review overdue", (r) => { r.reviewDueAt = "2026-10-03T01:00:00.000Z"; }],
    ["future issuance", (r) => { r.issuedAt = "2026-10-03T02:00:00.000Z"; }],
    ["future human review", (r) => { r.review.reviewedAt = "2026-10-03T02:00:00.000Z"; }],
    ["future operator approval", (r) => { r.approval.approvedAt = "2026-10-03T02:00:00.000Z"; }],
    ["invalid calendar date", (r) => { r.issuedAt = "2026-02-30T00:00:00.000Z"; }],
    ["ambiguous timestamp", (r) => { r.issuedAt = "2026-10-03T00:00:00"; }],
    ["over seven days", (r) => { r.expiresAt = "2026-10-10T00:00:00.001Z"; }],
    ["review beyond 24 hours", (r) => { r.reviewDueAt = "2026-10-04T00:15:00.001Z"; }],
    ["wrong whole lock", (r) => { r.lockSha256 = "0".repeat(64); }],
    ["wrong source tree", (r) => { r.sourceSha256 = "0".repeat(64); }],
    ["wrong integrity", (r) => { r.affectedNodes[0].integrity = `sha512-${Buffer.alloc(64, 8).toString("base64")}`; }],
    ["wrong version", (r) => { r.affectedNodes[0].version = "2.0.0"; }],
    ["wrong node", (r) => { r.affectedNodes[0].node = "node_modules/another"; }],
    ["wrong package", (r) => { r.affectedNodes[0].package = "another"; }],
    ["unknown advisory", (r) => { r.advisoryId = OTHER_ADVISORY; r.primarySources = [`https://github.com/advisories/${OTHER_ADVISORY}`]; }],
    ["partial node inventory", (r) => { r.affectedNodes.pop(); }],
    ["duplicate affected node", (r) => { r.affectedNodes.push(structuredClone(r.affectedNodes[0])); }],
    ["missing mitigation evidence", (r) => { r.mitigations.sources = []; }],
    ["unbound source evidence", (r) => { r.reachability.sources[0].sha256 = "0".repeat(64); }],
    ["evidence path traversal", (r) => { r.reachability.sources[0].file = "../outside.md"; }],
    ["unknown assertion flag", (r) => { Object.assign(r, { productionSafe: true }); }],
  ];
  it.each(hostile)("rejects %s", (_name, change) => {
    const f = fixture(); const r = exception(f); change(r); signRecord(f, r);
    expect(evaluate(f, [r])).toMatchObject({ ok: false, accepted: [], unaccepted: expect.any(Array) });
  });

  it("rejects duplicate records even with different record IDs", () => {
    const f = fixture(); const r = exception(f);
    expect(evaluate(f, [r, r]).ok).toBe(false);
    expect(evaluate(f, [r, signRecord(f, { ...structuredClone(r), id: "sec-synthetic-other" })]).ok).toBe(false);
  });

  it("rejects a runtime dependency ancestor despite every affected dev flag remaining true", () => {
    const f = fixture(); const r = exception(f);
    f.lock.packages["node_modules/runtime"].dependencies = { "dev-config": "1.0.0" }; rebind(f, r);
    expect(CHAIN.every((n) => f.lock.packages[`node_modules/${n}`].dev)).toBe(true);
    expect(evaluate(f, [r]).ok).toBe(false);
  });

  it.each(["optionalDependencies", "peerDependencies"] as const)("rejects production reachability through %s", (field) => {
    const f = fixture(); const r = exception(f);
    f.lock.packages["node_modules/runtime"][field] = { vulnerable: "1.0.0" };
    f.lock.packages["node_modules/runtime"].peerDependenciesMeta = { vulnerable: { optional: true } }; rebind(f, r);
    expect(evaluate(f, [r]).ok).toBe(false);
  });

  it("requires development root reachability, not orphan dev flags", () => {
    const f = fixture(); const r = exception(f);
    f.packageJson.devDependencies = {}; f.lock.packages[""].devDependencies = {}; rebind(f, r);
    expect(evaluate(f, [r]).ok).toBe(false);
  });

  it("rejects a package manifest whose runtime declarations contradict the lock", () => {
    const f = fixture(); const r = exception(f);
    f.packageJson.dependencies["dev-config"] = "1.0.0"; rebind(f, r);
    expect(evaluate(f, [r]).ok).toBe(false);
  });

  it("rejects unlisted locked copies rather than trusting a partial audit node list", () => {
    const f = fixture(); const r = exception(f);
    f.lock.packages["node_modules/dev-config/node_modules/vulnerable"] = { version: "1.0.0", integrity: integrity(), dev: true };
    rebind(f, r); expect(evaluate(f, [r]).ok).toBe(false);
  });

  it("rejects missing required graph edges and unsupported linked nodes", () => {
    const f = fixture(); const r = exception(f);
    f.lock.packages["node_modules/runtime"].dependencies = { missing: "1.0.0" }; rebind(f, r);
    expect(evaluate(f, [r]).ok).toBe(false);
    delete f.lock.packages["node_modules/runtime"].dependencies;
    f.lock.packages["node_modules/vulnerable"].link = true; rebind(f, r);
    expect(evaluate(f, [r]).ok).toBe(false);
  });

  it("distinguishes nested development copies from a hoisted production dependency", () => {
    const manifest = { dependencies: { runtime: "1" }, devDependencies: { tooling: "1" } };
    const lock = { lockfileVersion: 3, packages: {
      "": manifest, "node_modules/runtime": { version: "1", dependencies: { shared: "2" } },
      "node_modules/tooling": { version: "1", dev: true, dependencies: { shared: "1" } },
      "node_modules/shared": { version: "2" }, "node_modules/tooling/node_modules/shared": { version: "1", dev: true },
    } };
    const graph = lockedReachability(lock, manifest);
    expect(graph.production.has("node_modules/shared")).toBe(true);
    expect(graph.production.has("node_modules/tooling/node_modules/shared")).toBe(false);
    expect(graph.development.has("node_modules/tooling/node_modules/shared")).toBe(true);
  });

  it("does not cover a newly propagated second advisory", () => {
    const f = fixture(); const r = exception(f);
    f.report.vulnerabilities.vulnerable.via.push(advisory(OTHER_ADVISORY));
    const result = evaluate(f, [r]);
    expect(result.ok).toBe(false); expect(result.unaccepted).toHaveLength(5);
    expect(result.findings.every((v: { advisoryIds: string[] }) => v.advisoryIds.includes(OTHER_ADVISORY))).toBe(true);
  });

  it("leaves a new unrelated finding blocking while approved findings remain visible", () => {
    const f = fixture(); const r = exception(f);
    f.lock.packages["node_modules/new-package"] = { version: "1.0.0", integrity: integrity(), dev: true };
    f.packageJson.devDependencies["new-package"] = "1.0.0"; f.lock.packages[""].devDependencies!["new-package"] = "1.0.0";
    f.report.vulnerabilities["new-package"] = { name: "new-package", severity: "high", range: "<1.0.1", isDirect: true, nodes: ["node_modules/new-package"], effects: [], fixAvailable: false, via: [advisory(OTHER_ADVISORY, "new-package")] };
    f.report.metadata.vulnerabilities.high++; f.report.metadata.vulnerabilities.total++; rebind(f, r);
    const result = evaluate(f, [r]);
    expect(result.ok).toBe(false); expect(result.accepted).toHaveLength(5); expect(result.unaccepted).toHaveLength(1);
  });

  it("invalidates reviewed source and evidence bytes without a dependency change", () => {
    const f = fixture(); const r = exception(f);
    fs.writeFileSync(path.join(f.root, "src/app/[id]/route.ts"), "import 'vulnerable';\n");
    expect(evaluate(f, [r]).ok).toBe(false);
    r.sourceSha256 = securitySourceDigest(f.root); signRecord(f, r);
    fs.appendFileSync(path.join(f.root, "docs/review.md"), "changed evidence\n");
    expect(evaluate(f, [r]).ok).toBe(false);
  });

  it.each(["inside", "outside"])("rejects a matching root configuration symlink to an %s mutable target", (location) => {
    const f = fixture(); const r = exception(f);
    const targetRoot = location === "inside" ? f.root : fs.mkdtempSync(path.join(os.tmpdir(), "zenith-config-target-"));
    if (location === "outside") dirs.push(targetRoot);
    const target = path.join(targetRoot, "mutable.md");
    fs.writeFileSync(target, "export default {};\n");
    fs.symlinkSync(target, path.join(f.root, "next.config.ts"));
    expect(() => securitySourceDigest(f.root)).toThrow();
    expect(evaluate(f, [r]).ok).toBe(false);
    fs.writeFileSync(target, "export default { changed: true };\n");
    expect(() => securitySourceDigest(f.root)).toThrow();
    expect(evaluate(f, [r]).ok).toBe(false);
  });

  it.each(["final .env", "final .git", "parent .env", "parent .git", "safe final", "safe parent"])("rejects evidence symlink components including excluded targets: %s", (kind) => {
    const f = fixture(); const r = exception(f); const canary = randomBytes(24).toString("hex");
    const parent = kind.startsWith("parent") || kind === "safe parent";
    const targetDirectory = kind.endsWith(".env") ? ".env-private" : kind.endsWith(".git") ? ".git" : "safe-evidence";
    fs.mkdirSync(path.join(f.root, targetDirectory));
    fs.writeFileSync(path.join(f.root, targetDirectory, "review.md"), canary);
    if (parent) fs.symlinkSync(path.join(f.root, targetDirectory), path.join(f.root, "docs/linked"));
    else fs.symlinkSync(path.join(f.root, targetDirectory, "review.md"), path.join(f.root, "docs/linked.md"));
    r.reachability.sources = [{ file: parent ? "docs/linked/review.md" : "docs/linked.md", sha256: sha(canary) }];
    signRecord(f, r);
    const result = evaluate(f, [r]);
    expect(result).toMatchObject({ ok: false, accepted: [] });
    expect(JSON.stringify(result)).not.toContain(canary);
    expect(result.reason).not.toContain(f.root);
    expect(result.reason).not.toContain(targetDirectory);
  });

  it("redacts filesystem failures for an evidence path before reading its contents", () => {
    const f = fixture(); const r = exception(f); const canary = randomBytes(24).toString("hex");
    const evidenceFile = fs.realpathSync(path.join(f.root, "docs/review.md"));
    const lstat = fs.lstatSync.bind(fs);
    vi.spyOn(fs, "lstatSync").mockImplementation((file, options) => {
      if (file.toString() === evidenceFile) throw new Error(`${f.root}: ${canary}`);
      return lstat(file, options);
    });
    const result = evaluate(f, [r]);
    expect(result.ok).toBe(false); expect(JSON.stringify(result)).not.toContain(canary); expect(result.reason).not.toContain(f.root);
  });

  it("keeps malformed audit/count/registry failures blocking and does not expose private details", () => {
    const f = fixture(); const r = exception(f); const canary = randomBytes(24).toString("hex");
    const invalid = assessAudit({ ...f.report, error: { summary: canary } }, 1);
    expect(applySecurityExceptions(invalid, f.report, write(f), { schemaVersion: 1, exceptions: [r] }, f.root)).toEqual(invalid);
    const zero = assessAudit({ auditReportVersion: 2, vulnerabilities: {}, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 }, dependencies: { total: 6 } } }, 0);
    const result = evaluateSecurityExceptions(zero, {}, write(f), { schemaVersion: 1, exceptions: [r], privateDetail: canary }, f.root, NOW, f.authority);
    expect(result.ok).toBe(false); expect(JSON.stringify(result)).not.toContain(canary);
    const wrongCounts = structuredClone(f.report); wrongCounts.metadata.vulnerabilities.total = 0;
    expect(applySecurityExceptions(assessAudit(wrongCounts, 1), wrongCounts, write(f), { schemaVersion: 1, exceptions: [r] }, f.root).ok).toBe(false);
  });

  it("requires removal or fresh review of stale records after an advisory disappears", () => {
    const f = fixture(); const r = exception(f);
    const report = { ...f.report, vulnerabilities: {}, metadata: { ...f.report.metadata, vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } } };
    expect(evaluateSecurityExceptions(assessAudit(report, 0), report, write(f), { schemaVersion: 1, exceptions: [r] }, f.root, NOW, f.authority).ok).toBe(false);
  });
});
