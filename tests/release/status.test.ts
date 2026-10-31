/** Synthetic receipts and ephemeral keys test the governance contract, never live/provider acceptance. */
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { publicKeyEntry } from "../../scripts/supply-chain/release.mjs";
import { EVIDENCE_FORMAT, SIGNOFF_FORMAT, canonical, inspectEvidence, readRepositoryFile, releaseSnapshotDigest, selectReleaseEvidence, sha256, signSignoff, validateReleaseStatus, verifySignoff, type EvidenceReceipt, type SignoffRecord } from "../../scripts/release/status.mjs";
import { commandText, main as laneSource } from "../../scripts/release/lane-source.mjs";
import { buildDossier, loadDossierInputs, renderMarkdown, type Ledger } from "../../scripts/release/dossier";

const commit = "a".repeat(40);
const who = "Accountable test operator";
const now = new Date("2026-10-08T00:00:00Z");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(id = "PROD-REL-03") {
  const files = new Map<string, Buffer>();
  const ledger: Ledger = { releaseCandidate: { commit }, releaseSignoffs: ["approval.json"],
    releaseStatus: { implementationComplete: true, sandboxVerified: true, pilotReady: true, productionApproved: false },
    requirements: [{ id, title: "Release test", acceptance: ["Evidence bound to the candidate"], state: "verified", dependencies: [], implementationStatus: "implementation_complete_verification_pending", owner: null, testPaths: [],
      requiredEvidence: ["contract", "local_engine", "live_sandbox", "operational_rehearsal"], evidence: [] }] };
  for (const level of ledger.requirements[0]!.requiredEvidence) {
    const mode = level === "contract" ? "contract" : level === "live_sandbox" ? "live" : "local";
    const source = `sources/${level}.json`;
    files.set(source, Buffer.from(JSON.stringify({ commit, requirements: [id], environment: "Synthetic contract fixture", command: "fixture only", mode, exitCode: 0, status: "passed", counts: { passed: 3, failed: 0, skipped: 0 } })));
    const receipt: EvidenceReceipt = { format: EVIDENCE_FORMAT, requirementId: id, level, mode, commit, environment: "Synthetic contract fixture", command: "fixture only", status: "passed", passed: 3, failed: 0, skipped: 0, exitCode: 0,
      sources: [{ path: source, sha256: sha256(files.get(source)!) }] };
    const artifact = `evidence/${level}.json`;
    const bytes = Buffer.from(JSON.stringify(receipt));
    files.set(artifact, bytes);
    ledger.requirements[0]!.evidence.push({ level, artifact, commit, sha256: sha256(bytes) });
  }
  const readEvidence = (file: string): Buffer => { const bytes = files.get(file); if (!bytes) throw new Error("missing"); return bytes; };
  const seed = randomBytes(32);
  const keys = [{ ...publicKeyEntry("test-key", seed), identity: who }];
  const options = { readEvidence, keys, now };
  const selection = selectReleaseEvidence(ledger, options);
  const body: Omit<SignoffRecord, "signature"> = { format: SIGNOFF_FORMAT, who, when: now.toISOString(), commit, scope: { status: "productionApproved", requirements: [id] }, ledgerSha256: releaseSnapshotDigest(ledger), evidence: selection.refs };
  const approval = signSignoff(body, seed, "test-key");
  files.set("approval.json", Buffer.from(JSON.stringify(approval)));
  const edit = (level: string, over: Partial<EvidenceReceipt>) => {
    const e = ledger.requirements[0]!.evidence.find((e) => e.level === level)!;
    const receipt = JSON.parse(readEvidence(e.artifact!).toString()) as EvidenceReceipt;
    const bytes = Buffer.from(JSON.stringify({ ...receipt, ...over }));
    files.set(e.artifact!, bytes); e.sha256 = sha256(bytes);
  };
  return { ledger, files, seed, keys, options, selection, body, approval, edit };
}

describe("separate release status gates", () => {
  it("permits an honest all-false ledger without evidence or a candidate", () => {
    const f = fixture();
    f.ledger.releaseStatus = { implementationComplete: false, sandboxVerified: false, pilotReady: false, productionApproved: false };
    delete f.ledger.releaseCandidate; f.ledger.requirements[0]!.evidence = [];
    expect(validateReleaseStatus(f.ledger, f.options)).toEqual([]);
  });
  it("implementation completion never implies any evidence status", () => {
    const f = fixture(); f.ledger.releaseStatus = { implementationComplete: true, sandboxVerified: false, pilotReady: false, productionApproved: false };
    f.ledger.requirements[0]!.evidence = [];
    expect(validateReleaseStatus(f.ledger, f.options)).toEqual([]);
    f.ledger.requirements[0]!.implementationStatus = "not_assessed";
    expect(validateReleaseStatus(f.ledger, f.options).join()).toContain("every implementation");
  });
  it("sandbox requires the execution levels including live sandbox, pilot also requires rehearsals", () => {
    const f = fixture(); f.ledger.releaseStatus!.pilotReady = false;
    f.ledger.requirements[0]!.evidence = f.ledger.requirements[0]!.evidence.filter((e) => e.level !== "operational_rehearsal");
    expect(validateReleaseStatus(f.ledger, f.options)).toEqual([]);
    f.ledger.releaseStatus!.pilotReady = true;
    expect(validateReleaseStatus(f.ledger, f.options).join()).toContain("operational_rehearsal");
    f.ledger.releaseStatus!.pilotReady = false;
    f.ledger.requirements[0]!.evidence = f.ledger.requirements[0]!.evidence.filter((e) => e.level !== "live_sandbox");
    expect(validateReleaseStatus(f.ledger, f.options).join()).toContain("live_sandbox");
  });
  it("refuses later flags without their prerequisites and rejects nonbooleans", () => {
    const f = fixture(); f.ledger.releaseStatus!.sandboxVerified = false;
    expect(validateReleaseStatus(f.ledger, f.options).join()).toContain("pilotReady requires sandboxVerified");
    f.ledger.releaseStatus!.productionApproved = "yes" as unknown as boolean;
    expect(validateReleaseStatus(f.ledger, f.options).join()).toContain("must be boolean");
  });
  it("refuses a missing candidate or older-commit evidence", () => {
    const f = fixture(); delete f.ledger.releaseCandidate;
    expect(validateReleaseStatus(f.ledger, f.options).join()).toContain("full release candidate SHA");
    f.ledger.releaseCandidate = { commit: "b".repeat(40) };
    expect(validateReleaseStatus(f.ledger, f.options).join()).toContain("missing passing contract");
  });
  it.each([{ status: "skipped", skipped: 1 }, { status: "failed", failed: 1 }, { exitCode: 1 }, { passed: 0 } ] as Partial<EvidenceReceipt>[])("refuses nonpassing receipts %j", (over) => {
    const f = fixture(); f.edit("live_sandbox", over);
    expect(validateReleaseStatus(f.ledger, f.options).join()).toContain("live_sandbox");
  });
  it("a newer failed entry does not erase genuine passing evidence at the same candidate", () => {
    const f = fixture(); f.ledger.requirements[0]!.evidence.push({ level: "contract", commit, artifact: "absent.json" });
    expect(validateReleaseStatus(f.ledger, f.options)).toEqual([]);
  });
  it("permits local control-plane rehearsal but refuses local cloud-intrinsic rehearsal", () => {
    const f = fixture(); expect(validateReleaseStatus(f.ledger, f.options)).toEqual([]);
    const cloud = fixture("PROD-MIX-05");
    expect(validateReleaseStatus(cloud.ledger, cloud.options).join()).toContain("operational_rehearsal");
  });
  it("cannot relabel a contract source as live or hide failure counts in its source", () => {
    const f = fixture(); f.edit("live_sandbox", { mode: "contract" });
    expect(validateReleaseStatus(f.ledger, f.options).join()).toContain("live_sandbox");
    const g = fixture();
    const sourcePath = "sources/live_sandbox.json";
    const source = JSON.parse(g.files.get(sourcePath)!.toString()); source.counts.failed = 1;
    const bytes = Buffer.from(JSON.stringify(source)); g.files.set(sourcePath, bytes);
    g.edit("live_sandbox", { sources: [{ path: sourcePath, sha256: sha256(bytes) }] });
    expect(validateReleaseStatus(g.ledger, g.options).join()).toContain("live_sandbox");
  });
  it("refuses absent, changed, unbound, malformed, prose and placeholder artifacts", () => {
    for (const mutation of ["missing", "hash", "schema", "source", "placeholder"]) {
      const f = fixture(); const evidence = f.ledger.requirements[0]!.evidence[0]!;
      if (mutation === "missing") f.files.delete(evidence.artifact!);
      if (mutation === "hash") evidence.sha256 = "b".repeat(64);
      if (mutation === "schema") f.files.set(evidence.artifact!, Buffer.from("{}"));
      if (mutation === "source") f.files.delete("sources/contract.json");
      if (mutation === "placeholder") f.files.set(evidence.artifact!, Buffer.from("Pending verifier result"));
      expect(inspectEvidence("PROD-REL-03", evidence, f.options).valid, mutation).toBe(false);
    }
  });
  it("empty and unknown required evidence inventories cannot authorize a release", () => {
    const f = fixture(); f.ledger.requirements[0]!.requiredEvidence = [];
    expect(validateReleaseStatus(f.ledger, f.options).join()).toContain("no required execution evidence");
    f.ledger.requirements[0]!.requiredEvidence = ["invented"];
    expect(validateReleaseStatus(f.ledger, f.options).join()).toContain("invalid required evidence");
  });
});

describe("accountable sign-off", () => {
  it("approves only the complete unchanged inventory, evidence and candidate under a pinned human key", () => {
    const f = fixture(); f.ledger.releaseStatus!.productionApproved = true;
    expect(validateReleaseStatus(f.ledger, f.options)).toEqual([]);
    expect(verifySignoff(f.approval, f.ledger, f.selection.refs, f.keys, now)).toBe(true);
    expect(validateReleaseStatus(f.ledger, { ...f.options, keys: [] }).join()).toContain("accountable signed sign-off");
  });
  it.each(["signature", "who", "future", "commit", "scope", "duplicate", "evidence", "unknown-field"])("refuses %s tampering", (field) => {
    const f = fixture(); const record = structuredClone(f.approval);
    if (field === "signature") record.signature.value = randomBytes(64).toString("base64url");
    if (field === "who") record.who = "Other operator";
    if (field === "future") record.when = "2099-01-01T00:00:00Z";
    if (field === "commit") record.commit = "b".repeat(40);
    if (field === "scope") record.scope.requirements = ["PROD-REL-02"];
    if (field === "duplicate") record.scope.requirements.push(record.scope.requirements[0]!);
    if (field === "evidence") record.evidence.pop();
    if (field === "unknown-field") Object.assign(record, { publicKey: f.keys[0]!.publicKey });
    expect(verifySignoff(record, f.ledger, f.selection.refs, f.keys, now)).toBe(false);
  });
  it("rejects even a valid signature when the human signs incomplete scope/evidence", () => {
    const f = fixture();
    const record = signSignoff({ ...f.body, evidence: f.body.evidence.slice(1), scope: { status: "productionApproved", requirements: ["PROD-REL-02"] } }, f.seed, "test-key");
    expect(verifySignoff(record, f.ledger, f.selection.refs, f.keys, now)).toBe(false);
  });
  it("rejects a different key, duplicate key IDs, identity reassignment and unsigned drafts", () => {
    const f = fixture();
    for (const keys of [[{ ...publicKeyEntry("test-key", randomBytes(32)), identity: who }], [...f.keys, ...f.keys], [{ ...f.keys[0]!, identity: "Other operator" }]]) expect(verifySignoff(f.approval, f.ledger, f.selection.refs, keys, now)).toBe(false);
    expect(verifySignoff(f.body, f.ledger, f.selection.refs, f.keys, now)).toBe(false);
  });
  it("invalidates sign-off after changing requirements or evidence even when they remain passing", () => {
    const f = fixture(); f.ledger.requirements[0]!.acceptance.push("New acceptance clause");
    expect(verifySignoff(f.approval, f.ledger, f.selection.refs, f.keys, now)).toBe(false);
    const g = fixture(); g.ledger.requirements[0]!.evidence[0]!.result = "Edited evidence statement";
    expect(verifySignoff(g.approval, g.ledger, g.selection.refs, g.keys, now)).toBe(false);
  });
  it("signature binding is stable under JSON key order changes", () => {
    const f = fixture();
    const reordered = JSON.parse(canonical(f.approval));
    expect(verifySignoff(reordered, f.ledger, f.selection.refs, f.keys, now)).toBe(true);
  });
  it("original source coverage cannot be mapped to an unrelated requirement", () => {
    const f = fixture(); const sourcePath = "sources/contract.json";
    const source = JSON.parse(f.files.get(sourcePath)!.toString()); source.requirements = ["PROD-REL-02"];
    const bytes = Buffer.from(JSON.stringify(source)); f.files.set(sourcePath, bytes);
    f.edit("contract", { sources: [{ path: sourcePath, sha256: sha256(bytes) }] });
    expect(validateReleaseStatus(f.ledger, f.options).join()).toContain("contract");
  });
});

describe("actual files and command entry points", () => {
  function diskFixture() {
    const f = fixture(); const root = mkdtempSync(path.join(os.tmpdir(), "zenith-release-status-")); roots.push(root);
    for (const [file, bytes] of f.files) { mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), bytes); }
    const dir = path.join(root, "docs/build/production"); mkdirSync(dir, { recursive: true }); writeFileSync(path.join(dir, "ledger.json"), JSON.stringify(f.ledger));
    return { ...f, root, dir };
  }
  it("rejects traversal, absolute paths and directories", () => {
    const f = diskFixture();
    for (const file of ["../other.json", "/other.json", "C:/other.json", "sources"]) expect(() => readRepositoryFile(f.root, file)).toThrow();
  });
  it("the dossier reads exact real files and loses verification when a file disappears", () => {
    const f = diskFixture();
    const before = readFileSync(path.join(f.dir, "ledger.json"));
    const inputs = loadDossierInputs(f.root);
    const dossier = buildDossier(inputs);
    expect(dossier.rows[0]!.status).toBe("verified");
    expect(dossier.rows[0]!.environments).toEqual(["Synthetic contract fixture"]);
    rmSync(path.join(f.root, "evidence/live_sandbox.json"));
    const missing = buildDossier(loadDossierInputs(f.root));
    expect(missing.rows[0]!.status).not.toBe("verified");
    expect(renderMarkdown(missing)).toContain("DOES NOT SATISFY VERIFICATION");
    expect(readFileSync(path.join(f.dir, "ledger.json"))).toEqual(before);
  });
  it("the real ledger CLI refuses forged production approval before rendering anything", () => {
    // Run the actual entry point against an isolated copy; do not mutate the repository ledger.
    const f = diskFixture();
    mkdirSync(path.join(f.root, "scripts/build"), { recursive: true }); mkdirSync(path.join(f.root, "scripts/release"), { recursive: true });
    writeFileSync(path.join(f.root, "scripts/build/production-ledger.mjs"), readFileSync("scripts/build/production-ledger.mjs"));
    // Keep imports resolved to real code/dependencies; only root computation is redirected by the copied entry point.
    const shim = `export { validateReleaseStatus } from ${JSON.stringify(new URL("../../scripts/release/status.mjs", import.meta.url).href)};\n`;
    writeFileSync(path.join(f.root, "scripts/release/status.mjs"), shim);
    f.ledger.releaseStatus!.productionApproved = true;
    writeFileSync(path.join(f.dir, "ledger.json"), JSON.stringify(f.ledger));
    const result = spawnSync(process.execPath, [path.join(f.root, "scripts/build/production-ledger.mjs"), "--check"], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("accountable signed sign-off");
    expect(result.stdout).toBe("");
  });
  it("the evidence CLI keeps actual skips and refuses a mode upgrade", () => {
    const f = diskFixture(); const sourcePath = "sources/contract.json";
    const source = JSON.parse(readFileSync(path.join(f.root, sourcePath), "utf8")); source.counts.skipped = 2;
    writeFileSync(path.join(f.root, sourcePath), JSON.stringify(source));
    const script = path.resolve("scripts/release/evidence-cli.mjs");
    const args = [script, "--source", sourcePath, "--requirement", "PROD-REL-03", "--level", "contract", "--mode", "contract", "--out", "record.json"];
    const recorded = spawnSync(process.execPath, args, { cwd: f.root, encoding: "utf8" });
    expect(recorded.status).toBe(0);
    expect(JSON.parse(readFileSync(path.join(f.root, "record.json"), "utf8"))).toMatchObject({ status: "skipped", skipped: 2 });
    args[args.indexOf("--mode") + 1] = "live";
    const refused = spawnSync(process.execPath, args, { cwd: f.root, encoding: "utf8" });
    expect(refused.status).toBe(1); expect(refused.stderr).toContain("mode differs");
  });
});

describe("lane sources: a real contract or engine run bound for a receipt", () => {
  const head = "b".repeat(40);
  function laneRoot() {
    const root = mkdtempSync(path.join(os.tmpdir(), "zenith-lane-test-"));
    roots.push(root);
    mkdirSync(path.join(root, "tests"), { recursive: true });
    writeFileSync(path.join(root, "tests/a.test.ts"), "// fixture\n");
    return root;
  }
  const run = (root: string, report: Record<string, unknown> | null, exitCode = 0, dirty = "") => {
    const out = path.join(root, "source.json");
    const code = laneSource(["--requirement", "PROD-MIX-03", "--mode", "contract", "--environment", "Synthetic lane", "--out", out, "--root", root, "--", "tests/a.test.ts", "--maxWorkers=1"], {
      git: (_root, args) => (args[0] === "status" ? dirty : head),
      vitest: (_root, _args, reportFile) => { if (report) writeFileSync(reportFile, JSON.stringify(report)); return exitCode; },
    });
    return { code, out };
  };

  it("writes a source evidence-cli binds into a passing contract receipt", async () => {
    const root = laneRoot();
    const { code, out } = run(root, { numPassedTests: 4, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0 });
    expect(code).toBe(0);
    const source = JSON.parse(readFileSync(out, "utf8"));
    expect(source).toMatchObject({ requirements: ["PROD-MIX-03"], mode: "contract", commit: head, exitCode: 0, status: "passed", counts: { passed: 4, failed: 0, skipped: 0 },
      command: "vitest run tests/a.test.ts --maxWorkers=1", files: [{ path: "tests/a.test.ts", sha256: sha256(Buffer.from("// fixture\n")) }] });
    const { main: bind } = await import("../../scripts/release/evidence-cli.mjs");
    expect(bind(["--source", "source.json", "--requirement", "PROD-MIX-03", "--level", "contract", "--mode", "contract", "--out", path.join(root, "receipt.json")], root)).toBe(0);
    const bytes = readFileSync(path.join(root, "receipt.json"));
    const entry = { level: "contract", commit: head, artifact: "receipt.json", sha256: sha256(bytes) };
    expect(inspectEvidence("PROD-MIX-03", entry, { root }).valid).toBe(true);
  });

  it("never turns skips, failures, a missing report or a dirty tree into a pass", () => {
    expect(JSON.parse(readFileSync(run(laneRoot(), { numPassedTests: 4, numPendingTests: 1 }).out, "utf8")).status).toBe("skipped");
    expect(JSON.parse(readFileSync(run(laneRoot(), { numPassedTests: 4, numFailedTests: 1 }, 1).out, "utf8")).status).toBe("failed");
    expect(JSON.parse(readFileSync(run(laneRoot(), null, 1).out, "utf8"))).toMatchObject({ status: "failed", counts: { passed: 0, failed: 0, skipped: 0 } });
    const dirty = laneRoot();
    expect(run(dirty, { numPassedTests: 4 }, 0, " M src/x.ts").code).toBe(1);
    expect(existsSync(path.join(dirty, "source.json"))).toBe(false);
  });

  it("names a long file list by count so the command fits the receipt", () => {
    const files = Array.from({ length: 80 }, (_, i) => `tests/area/file-number-${i}.test.ts`);
    expect(commandText([...files, "--maxWorkers=1"], files)).toBe("vitest run --maxWorkers=1 over the 80 test files listed in files");
    expect(commandText(["tests/a.test.ts"], ["tests/a.test.ts"])).toBe("vitest run tests/a.test.ts");
  });
});
