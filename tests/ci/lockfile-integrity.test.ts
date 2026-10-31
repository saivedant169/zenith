/**
 * `scripts/ci/lockfile-integrity.mjs` is the blocking half of the
 * `supply-chain` job: a lockfile may only pin registry tarballs with sha512
 * integrity hashes. These cases are the shapes a hand-edited or tool-rewritten
 * lockfile takes when it slips a package in from somewhere else.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const SCRIPT = path.resolve("scripts/ci/lockfile-integrity.mjs");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-lockfile-"));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

const HASH = `sha512-${"A".repeat(86)}==`;
const registry = (name: string, version = "1.0.0"): string =>
  `https://registry.npmjs.org/${name}/-/${name.split("/").pop()}-${version}.tgz`;

type Entry = Record<string, unknown>;

function run(packages: Record<string, Entry>, over: Record<string, unknown> = {}): { status: number | null; out: string } {
  const file = path.join(fs.mkdtempSync(path.join(scratch, "lock-")), "package-lock.json");
  fs.writeFileSync(
    file,
    JSON.stringify({ name: "x", lockfileVersion: 3, packages: { "": { name: "x" }, ...packages }, ...over })
  );
  const child = spawnSync(process.execPath, [SCRIPT, file], { encoding: "utf8" });
  return { status: child.status, out: `${child.stdout}\n${child.stderr}` };
}

const good: Record<string, Entry> = {
  "node_modules/left-pad": { version: "1.0.0", resolved: registry("left-pad"), integrity: HASH },
  "node_modules/@scope/pkg": { version: "2.0.0", resolved: registry("@scope/pkg", "2.0.0"), integrity: HASH },
};

describe("lockfile integrity", () => {
  it("accepts registry tarballs, scoped packages and entries bundled inside a parent tarball", () => {
    const { status, out } = run({
      ...good,
      "node_modules/parent": { version: "1.0.0", resolved: registry("parent"), integrity: HASH },
      "node_modules/parent/node_modules/bundled": { version: "1.0.0", inBundle: true },
    });
    expect(out).toContain("3 packages pinned");
    expect(out).toContain("1 bundled");
    expect(status).toBe(0);
  });

  it("accepts an aliased package whose tarball carries the real name", () => {
    const { status } = run({
      "node_modules/alias": { name: "real-name", version: "1.0.0", resolved: registry("real-name"), integrity: HASH },
    });
    expect(status).toBe(0);
  });

  it.each([
    ["another host", "https://evil.example.com/left-pad/-/left-pad-1.0.0.tgz"],
    ["plain http", "http://registry.npmjs.org/left-pad/-/left-pad-1.0.0.tgz"],
    ["a git dependency", "git+ssh://git@github.com/someone/left-pad.git#abc123"],
    ["a lookalike host", "https://registry.npmjs.org.evil.example/left-pad/-/left-pad-1.0.0.tgz"],
    ["credentials in the URL", "https://user:pw@registry.npmjs.org/left-pad/-/left-pad-1.0.0.tgz"],
    ["a query string", "https://registry.npmjs.org/left-pad/-/left-pad-1.0.0.tgz?token=abc"],
    ["another package's tarball", "https://registry.npmjs.org/other/-/other-1.0.0.tgz"],
    ["a non-default port", "https://registry.npmjs.org:8443/left-pad/-/left-pad-1.0.0.tgz"],
    ["no tarball at all", "https://registry.npmjs.org/left-pad"],
  ])("rejects a package resolved from %s", (_label, resolved) => {
    const { status, out } = run({ "node_modules/left-pad": { version: "1.0.0", resolved, integrity: HASH } });
    expect(status).toBe(1);
    expect(out).toContain("node_modules/left-pad");
  });

  it("rejects an entry with no integrity hash, which npm would install unverified", () => {
    const { status, out } = run({ "node_modules/left-pad": { version: "1.0.0", resolved: registry("left-pad") } });
    expect(status).toBe(1);
    expect(out).toContain("integrity is missing");
  });

  it("rejects a weak integrity hash", () => {
    const { status, out } = run({
      "node_modules/left-pad": { version: "1.0.0", resolved: registry("left-pad"), integrity: "sha1-AAAAAAAAAAAAAAAAAAAAAAAAAAA=" },
    });
    expect(status).toBe(1);
    expect(out).toContain("not a sha512 hash");
  });

  it("rejects an entry with no resolved URL that is not bundled", () => {
    const { status, out } = run({ "node_modules/left-pad": { version: "1.0.0", integrity: HASH } });
    expect(status).toBe(1);
    expect(out).toContain("no `resolved` URL");
  });

  it("rejects a local link dependency", () => {
    const { status, out } = run({ "node_modules/local": { resolved: "packages/local", link: true } });
    expect(status).toBe(1);
    expect(out).toContain("`link`");
  });

  it("accepts only the one vendored minimatch link and its own entry, never another local path", () => {
    const vendored = { "node_modules/minimatch": { resolved: "vendor/minimatch3-compat", link: true }, "vendor/minimatch3-compat": { name: "minimatch", version: "3.1.5-zenith.0", dev: true, license: "ISC" } };
    expect(run({ ...good, ...vendored }).status).toBe(0);
    for (const bad of [
      { "node_modules/minimatch": { resolved: "vendor/other", link: true } },
      { "node_modules/glob": { resolved: "vendor/minimatch3-compat", link: true } },
      { "node_modules/minimatch": { resolved: "vendor/minimatch3-compat", link: true, integrity: HASH } },
      { "vendor/other": { name: "other", version: "1.0.0" } },
    ] as Record<string, Entry>[]) expect(run({ ...good, ...bad }).status, JSON.stringify(bad)).toBe(1);
  });

  it("rejects an old lockfile format that carries no per-package integrity", () => {
    expect(run(good, { lockfileVersion: 2 }).status).toBe(1);
  });

  it("fails on an unreadable or malformed lockfile instead of passing", () => {
    const file = path.join(scratch, "broken.json");
    fs.writeFileSync(file, "{ not json");
    const child = spawnSync(process.execPath, [SCRIPT, file], { encoding: "utf8" });
    expect(child.status).toBe(1);
    const missing = spawnSync(process.execPath, [SCRIPT, path.join(scratch, "nope.json")], { encoding: "utf8" });
    expect(missing.status).toBe(1);
  });

  it("holds for this repository's own package-lock.json", () => {
    const child = spawnSync(process.execPath, [SCRIPT, path.resolve("package-lock.json")], { encoding: "utf8" });
    expect(`${child.stdout}${child.stderr}`).toContain("pinned to https://registry.npmjs.org");
    expect(child.status).toBe(0);
  });
});
