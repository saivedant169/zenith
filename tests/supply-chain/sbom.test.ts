/**
 * PROD-OPS-09: CycloneDX SBOM generation. Pure parsing of the real repository inputs (package-lock.json, the shipped
 * Dockerfiles) plus synthetic lockfiles and `go version -m` text. The one test that needs the Go toolchain is gated on
 * ZENITH_TEST_GO (path to a go executable) and reports its skip reason; it is never counted as passed otherwise.
 */
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildSbom, dockerfileComponents, goComponents, imageComponent, main, npmComponents, npmPurl, parseGoVersionM, sriToHex, validateSbom } from "../../scripts/supply-chain/sbom.mjs";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-sbom-"));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

const integrity = (): string => `sha512-${randomBytes(64).toString("base64")}`;
const lockOf = (packages: Record<string, unknown>) => ({ lockfileVersion: 3, packages: { "": { name: "app", version: "1.0.0", dependencies: { a: "^1" }, devDependencies: { d: "^1" } }, ...packages } });
const SAMPLE_GO = [
  "/work/zenithd: go1.27.1",
  "\tpath\tgithub.com/GODOSTROYER/zenith/go/cmd/zenithd",
  "\tmod\tgithub.com/GODOSTROYER/zenith/go\t(devel)\t",
  "\tdep\texample.com/lib\tv1.2.3\th1:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG=",
  "\tdep\texample.com/old\tv0.1.0\th1:old=",
  "\t=>\texample.com/fork\tv0.1.1\th1:fork=",
  "\tbuild\t-buildmode=exe",
  "\tbuild\tGOOS=linux",
  "\tbuild\tvcs.revision=0123456789abcdef0123456789abcdef01234567",
].join("\n");

describe("npm components", () => {
  it("records name, version, purl, sha512 hash, scope and the resolved graph from a lockfile", () => {
    const ia = integrity();
    const lock = lockOf({
      "node_modules/a": { version: "1.0.0", resolved: "https://registry.npmjs.org/a/-/a-1.0.0.tgz", integrity: ia, dependencies: { "@s/b": "^1" } },
      "node_modules/@s/b": { version: "2.0.0", integrity: integrity(), license: "MIT" },
      "node_modules/d": { version: "1.0.0", integrity: integrity(), dev: true },
      "node_modules/o": { version: "1.0.0", integrity: integrity(), optional: true },
    });
    const { components, dependencies, direct } = npmComponents(lock, undefined);
    const a = components.find((c: { name: string }) => c.name === "a");
    expect(a).toMatchObject({ purl: "pkg:npm/a@1.0.0", scope: "required", hashes: [{ alg: "SHA-512", content: sriToHex(ia) }] });
    expect(components.find((c: { name: string }) => c.name === "@s/b")).toMatchObject({ purl: "pkg:npm/%40s/b@2.0.0", licenses: [{ expression: "MIT" }] });
    expect(components.find((c: { name: string }) => c.name === "d")?.scope).toBe("excluded");
    expect(components.find((c: { name: string }) => c.name === "o")?.scope).toBe("optional");
    expect(dependencies.find((d: { ref: string }) => d.ref === "pkg:npm/a@1.0.0")?.dependsOn).toEqual(["pkg:npm/%40s/b@2.0.0"]);
    expect(direct).toEqual(["pkg:npm/a@1.0.0", "pkg:npm/d@1.0.0"]);
  });

  it("keeps separate bom-refs for two installed copies of one version and resolves nested copies", () => {
    const lock = lockOf({
      "node_modules/a": { version: "1.0.0", integrity: integrity(), dependencies: { x: "^1" } },
      "node_modules/a/node_modules/x": { version: "1.0.0", integrity: integrity() },
      "node_modules/x": { version: "1.0.0", integrity: integrity() },
    });
    const { components, dependencies } = npmComponents(lock, undefined);
    const refs = components.map((c: { "bom-ref": string }) => c["bom-ref"]);
    expect(new Set(refs).size).toBe(3);
    const a = dependencies.find((d: { ref: string }) => d.ref === "pkg:npm/a@1.0.0");
    expect(a?.dependsOn).toEqual(["pkg:npm/x@1.0.0#node_modules/a/node_modules/x"]);
  });

  it("refuses a link entry and a version-less entry rather than inventing an inventory", () => {
    expect(() => npmComponents(lockOf({ "node_modules/a": { link: true, resolved: "../a" } }), undefined)).toThrow(/link/);
    expect(() => npmComponents(lockOf({ "node_modules/a": { integrity: integrity() } }), undefined)).toThrow(/no version/);
    expect(() => npmComponents({ lockfileVersion: 1, packages: {} }, undefined)).toThrow(/lockfileVersion/);
  });

  it("inventories every entry of the repository's own package-lock.json with its own sha512 hash or a verified enclosing tarball", () => {
    const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
    const expected = Object.keys(lock.packages).filter((n) => n !== "").length;
    const { components } = npmComponents(lock, JSON.parse(fs.readFileSync("package.json", "utf8")));
    expect(components).toHaveLength(expected);
    for (const c of components) {
      expect(c.purl.startsWith("pkg:npm/")).toBe(true);
      const node = c.properties.find((p: { name: string }) => p.name === "zenith:npm:node")!.value;
      if (lock.packages[node].inBundle === true) {
        expect(c.hashes).toBeUndefined(); // never mislabel a parent tarball hash as this child's hash
        const ownerNode = c.properties.find((p: { name: string }) => p.name === "zenith:npm:bundled-in-node")!.value;
        expect(node.startsWith(`${ownerNode}/node_modules/`)).toBe(true);
        expect(c.properties).toContainEqual({ name: "zenith:npm:bundle-sha512", value: sriToHex(lock.packages[ownerNode].integrity) });
      } else expect(c.hashes).toHaveLength(1);
    }
    expect(validateSbom(buildSbom({ lock, version: "1.0.0", commit: "0123456789abcdef" }))).toEqual([]);
    expect(npmPurl("@a/b", "1.0.0")).toBe("pkg:npm/%40a/b@1.0.0");
  });
});

describe("vendored npm package", () => {
  it("inventories only the vendored minimatch link and its entry, hashed over the package's own files", () => {
    const lock = lockOf({ "node_modules/minimatch": { resolved: "vendor/minimatch3-compat", link: true }, "vendor/minimatch3-compat": { name: "minimatch", version: "3.1.5-zenith.0", dev: true } });
    const { components } = npmComponents(lock, undefined);
    expect(components.map((c: { name: string; version: string; scope: string }) => [c.name, c.version, c.scope])).toEqual([["minimatch", "3.1.5-zenith.0", "excluded"], ["minimatch", "3.1.5-zenith.0", "excluded"]]);
    expect(new Set(components.map((c: { "bom-ref": string }) => c["bom-ref"])).size).toBe(2);
    for (const c of components) expect(c.hashes).toEqual([{ alg: "SHA-512", content: expect.stringMatching(/^[a-f0-9]{128}$/) }]);
    expect(() => npmComponents(lockOf({ "node_modules/other": { resolved: "vendor/minimatch3-compat", link: true } }), undefined)).toThrow(/is a link/);
    expect(() => npmComponents(lockOf({ "node_modules/minimatch": { resolved: "packages/elsewhere", link: true } }), undefined)).toThrow(/is a link/);
  });
});

describe("bundled npm provenance", () => {
  it("refuses an unhashed bundle without its pinned parent", () => {
    expect(() => npmComponents(lockOf({ "node_modules/a/node_modules/b": { version: "1.0.0", inBundle: true } }), undefined)).toThrow(/enclosing tarball/);
  });
  it("refuses fabricated or missing parent integrity evidence", () => {
    const lock = lockOf({ "node_modules/a": { version: "1.0.0", integrity: integrity() }, "node_modules/a/node_modules/b": { version: "1.0.0", inBundle: true } });
    const bom = buildSbom({ lock, version: "1.0.0", commit: "0123456789abcdef" });
    expect(validateSbom(bom)).toEqual([]);
    const bundled = bom.components.find((c: { name: string }) => c.name === "b")!;
    bundled.properties.find((p: { name: string }) => p.name === "zenith:npm:bundle-sha512")!.value = "0".repeat(128);
    expect(validateSbom(bom).join(" ")).toMatch(/verified enclosing bundle/);
  });
});

describe("go build info", () => {
  it("parses go version -m output into the module, toolchain, dependencies and replacements", () => {
    const info = parseGoVersionM(SAMPLE_GO);
    expect(info).toMatchObject({ binary: "zenithd", goVersion: "go1.27.1", main: { path: "github.com/GODOSTROYER/zenith/go" } });
    expect(info.deps).toHaveLength(2);
    expect(info.deps[1].replacedBy).toMatchObject({ path: "example.com/fork", version: "v0.1.1" });
    const { components, dependencies } = goComponents([info]);
    expect(components.map((c: { purl?: string }) => c.purl).filter(Boolean)).toEqual(expect.arrayContaining(["pkg:generic/go@1.27.1", "pkg:golang/example.com/lib@v1.2.3", "pkg:golang/example.com/fork@v0.1.1"]));
    expect(components.find((c: { name: string }) => c.name === "zenithd")).toMatchObject({ type: "application" });
    expect(dependencies[0].dependsOn).toContain("pkg:generic/go@1.27.1");
  });

  it("refuses text that is not go version -m output or has no build info", () => {
    expect(() => parseGoVersionM("hello")).toThrow(/not `go version -m`/);
    expect(() => parseGoVersionM("/x/bin: go1.27.1\n")).toThrow(/no module information/);
  });

  const go = process.env.ZENITH_TEST_GO;
  it.skipIf(!go)("reads the build info of a real binary built from go/cmd/zenith-release (set ZENITH_TEST_GO to a go executable)", () => {
    const out = path.join(scratch, process.platform === "win32" ? "zr.exe" : "zr");
    const env = { ...process.env, GOTOOLCHAIN: "local" };
    expect(spawnSync(go!, ["build", "-o", out, "./cmd/zenith-release"], { cwd: "go", env }).status).toBe(0);
    const shown = spawnSync(go!, ["version", "-m", out], { env, encoding: "utf8" });
    const info = parseGoVersionM(shown.stdout);
    expect(info.main?.path).toBe("github.com/GODOSTROYER/zenith/go");
    expect(goComponents([info]).components.length).toBeGreaterThan(1);
  });
});

describe("container inputs", () => {
  it("flags tag-only base images and records digest-pinned ones, from the shipped Dockerfiles", () => {
    const root = dockerfileComponents(fs.readFileSync("Dockerfile", "utf8"), "Dockerfile");
    expect(root.length).toBeGreaterThan(0);
    for (const c of root) {
      expect(c.hashes?.[0].content).toMatch(/^[0-9a-f]{64}$/);
      expect(c.properties).toContainEqual({ name: "zenith:pinned", value: "digest" });
    }
    const runner = dockerfileComponents(fs.readFileSync("docker/runner.Dockerfile", "utf8"), "docker/runner.Dockerfile");
    const tagOnly = runner.filter((c: { properties: { name: string; value: string }[] }) => c.properties.some((p) => p.name === "zenith:pinned" && p.value === "tag-only"));
    expect(tagOnly).toEqual([]);
    for (const name of ["golang", "gcr.io/distroless/static-debian12"]) {
      const image = runner.find((c: { name: string }) => c.name === name);
      expect(image?.hashes?.[0].content).toMatch(/^[a-f0-9]{64}$/);
      expect(image?.properties).toContainEqual({ name: "zenith:pinned", value: "digest" });
    }
    const tofu = runner.find((c: { name: string }) => c.name === "opentofu");
    expect(tofu?.hashes).toHaveLength(2);
    const worker = dockerfileComponents(fs.readFileSync("docker/worker.Dockerfile", "utf8"), "docker/worker.Dockerfile");
    expect(worker.filter((c: { type: string }) => c.type === "container")).toHaveLength(1);
    expect(worker.find((c: { type: string }) => c.type === "container")?.hashes?.[0].content).toBe("43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c");
  });

  it("does not list a later stage that builds FROM an earlier stage as an external image", () => {
    const text = "ARG B=alpine:3.22@sha256:" + "a".repeat(64) + "\nFROM ${B} AS base\nFROM base AS final\n";
    expect(dockerfileComponents(text, "x")).toHaveLength(1);
  });

  it("builds a component for a named built image and rejects a malformed digest", () => {
    const digest = `sha256:${createHash("sha256").update("img").digest("hex")}`;
    expect(imageComponent("zenith", digest)).toMatchObject({ type: "container", hashes: [{ alg: "SHA-256", content: digest.slice(7) }] });
    expect(() => imageComponent("zenith", "sha256:short")).toThrow();
  });
});

describe("document and CLI", () => {
  const lockPath = path.join(scratch, "lock.json");
  const goPath = path.join(scratch, "go.txt");
  const common = () => {
    fs.writeFileSync(lockPath, JSON.stringify(lockOf({ "node_modules/a": { version: "1.0.0", integrity: integrity() }, "node_modules/d": { version: "1.0.0", integrity: integrity(), dev: true } })));
    fs.writeFileSync(goPath, SAMPLE_GO);
  };

  it("assembles a valid CycloneDX 1.5 document that is reproducible for the same inputs", () => {
    common();
    const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    const args = { lock, goInfos: [parseGoVersionM(SAMPLE_GO)], version: "1.2.3", commit: "0123456789abcdef0123456789abcdef01234567", timestamp: "2026-10-07T00:00:00.000Z" };
    const one = buildSbom(args);
    expect(validateSbom(one)).toEqual([]);
    expect(one.specVersion).toBe("1.5");
    expect(buildSbom(args)).toEqual(one);
    expect(buildSbom({ ...args, version: "1.2.4" }).serialNumber).toBe(one.serialNumber);
    expect(() => buildSbom({ ...args, commit: "nothex" })).toThrow(/commit/);
  });

  it("catches a broken SBOM: duplicate refs, dangling dependencies, a missing npm hash, a malformed hash", () => {
    common();
    const base = buildSbom({ lock: JSON.parse(fs.readFileSync(lockPath, "utf8")), version: "1.0.0", commit: "0123456789abcdef", timestamp: "2026-10-07T00:00:00.000Z" });
    const broken = JSON.parse(JSON.stringify(base));
    broken.components.push(broken.components[0]);
    broken.dependencies.push({ ref: "ghost", dependsOn: ["ghost2"] });
    delete broken.components[1].hashes;
    broken.components[0].hashes[0].content = "zz";
    const problems = validateSbom(broken).join("\n");
    expect(problems).toMatch(/duplicate bom-ref/);
    expect(problems).toMatch(/unknown ref ghost/);
    expect(problems).toMatch(/no sha512/);
    expect(problems).toMatch(/malformed SHA-512/);
    expect(validateSbom({ bomFormat: "SPDX" })).toEqual(["not a CycloneDX 1.5 document"]);
  });

  it("the CLI writes the SBOM for the repository lockfile, Dockerfiles and a named image, and reports failures", () => {
    const out = path.join(scratch, "sbom.json");
    const text: string[] = [];
    const err: string[] = [];
    const sink = (into: string[]) => ({ write: (s: string) => { into.push(s); return true; } }) as unknown as NodeJS.WriteStream;
    const digest = `sha256:${"d".repeat(64)}`;
    const code = main(["--lock", "package-lock.json", "--package", "package.json", "--dockerfile", "Dockerfile", "--dockerfile", "docker/runner.Dockerfile", "--image", `zenith=${digest}`, "--go-version-m-file", (common(), goPath), "--version", "9.9.9", "--commit", "0123456789abcdef0123456789abcdef01234567", "--out", out], sink(text), sink(err));
    expect(err.join("")).toBe("");
    expect(code).toBe(0);
    const doc = JSON.parse(fs.readFileSync(out, "utf8"));
    expect(validateSbom(doc)).toEqual([]);
    expect(doc.components.some((c: { "bom-ref": string }) => c["bom-ref"] === `zenith-image:zenith@${digest}`)).toBe(true);
    expect(main(["--lock", "missing.json", "--out", out], sink(text), sink(err))).toBe(1);
    expect(main(["--out", out], sink(text), sink(err))).toBe(1);
  });
});
