/** Exercise the real Next/ESLint resolver chain after removing unpatched braces. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { ESLint } from "eslint";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const root = process.cwd();
const nextRequire = createRequire(require.resolve("@next/eslint-plugin-next"));
const getRootDirs = nextRequire("./utils/get-root-dirs") as {
  getRootDirs: (context: { cwd: string; settings: { next?: { rootDir?: string | string[] } } }) => string[];
};
const roots = (rootDir?: string | string[]) => getRootDirs.getRootDirs({
  cwd: root, settings: rootDir === undefined ? {} : { next: { rootDir } },
});

describe("Next lint dependency replacement", () => {
  let fixture: string;
  let eslint: ESLint;
  beforeAll(async () => {
    fixture = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-next-lint-"));
    for (const directory of ["web/pages", "admin/src/app/about", "01", "02", ".hidden/pages", "a[1]"]) {
      fs.mkdirSync(path.join(fixture, "apps", directory), { recursive: true });
    }
    fs.writeFileSync(path.join(fixture, "apps/web/pages/index.tsx"), "export default function Home() { return null; }");
    fs.writeFileSync(path.join(fixture, "apps/web/pages/contact.tsx"), "export default function Contact() { return null; }");
    fs.writeFileSync(path.join(fixture, "apps/admin/src/app/about/page.tsx"), "export default function About() { return null; }");
    fs.writeFileSync(path.join(fixture, "apps/not-directory"), "file");
    fs.symlinkSync(path.join(fixture, "apps/web"), path.join(fixture, "apps/linked"), "dir");
    eslint = new ESLint({ cwd: root });
    // ESLint's normal loader supplies the context needed by the Next config's
    // Rushstack patch and installs the scoped adapter before rules execute.
    await eslint.calculateConfigForFile(path.join(root, "src/app/page.tsx"));
  });
  afterAll(() => { fs.rmSync(fixture, { recursive: true, force: true }); });

  it("pins the actual replacement and removes the vulnerable chain from the complete lock", () => {
    const pkg = require(path.join(root, "package.json"));
    const lock = require(path.join(root, "package-lock.json"));
    expect(pkg.engines.node).toBe(">=22.22.2 <23");
    expect(pkg.overrides["@next/eslint-plugin-next@15.5.24"]["fast-glob"]).toBe("npm:glob@14.0.3");
    expect(nextRequire("fast-glob/package.json")).toMatchObject({ name: "glob", version: "14.0.3" });
    expect(pkg.devDependencies.picomatch).toBe("4.0.7");
    expect(require("picomatch/package.json").version).toBe("4.0.7");
    const globRequire = createRequire(nextRequire.resolve("fast-glob"));
    expect(globRequire("brace-expansion/package.json").version).toBe("5.0.12");
    const names = Object.entries(lock.packages).map(([key, value]) =>
      (value as { name?: string }).name ?? key.split("node_modules/").pop());
    expect(names).not.toContain("braces");
    expect(names).not.toContain("micromatch");
    expect(names).not.toContain("fast-glob");
    // The root's existing glob API belongs to E2B and must remain unadapted.
    expect(() => require("glob").globSync([], { onlyFiles: true })).not.toThrow();
  });

  it("uses the repository cwd when Next rootDir is absent", () => {
    expect(roots()).toEqual([root]);
  });

  it.each([
    ["apps/web", ["apps/web"]],
    ["apps/web/", ["apps/web/"]],
    ["apps/*", ["apps/01", "apps/02", "apps/a[1]", "apps/admin", "apps/linked", "apps/web"]],
    ["apps/*/", ["apps/01", "apps/02", "apps/a[1]", "apps/admin", "apps/linked", "apps/web"]],
    ["apps/a[[]1]", ["apps/a[1]"]],
    ["apps/!(web)", ["apps/.hidden", "apps/01", "apps/02", "apps/a[1]", "apps/admin", "apps/linked"]],
    ["apps/[!w]*", ["apps/.hidden", "apps/01", "apps/02", "apps/a[1]", "apps/admin", "apps/linked"]],
    ["apps/{web,admin}", ["apps/admin", "apps/web"]],
    ["apps/{web,{admin,linked}}", ["apps/admin", "apps/linked", "apps/web"]],
    ["apps/@(web|admin)", ["apps/admin", "apps/web"]],
    ["apps/{01..02}", ["apps/01", "apps/02"]],
    ["apps/{01..02..1}", ["apps/01", "apps/02"]],
    ["apps/{web,web}", ["apps/web"]],
    ["apps/.hidden", ["apps/.hidden"]],
    ["apps/linked", ["apps/linked"]],
    ["apps/not-directory", []],
    ["apps/no-match", []],
  ] as const)("retains directory-glob behavior for %s", (pattern, expected) => {
    const actualPattern = `${fixture}/${pattern}`;
    expect(roots(actualPattern).sort()).toEqual(expected.map((entry) => `${fixture}/${entry}`).sort());
  });

  it("retains relative patterns and mixed Next root arrays", () => {
    const relative = path.relative(root, path.join(fixture, "apps"));
    expect(roots(`${relative}/{web,admin}`).sort()).toEqual([`${relative}/admin`, `${relative}/web`].sort());
    expect(roots([`${relative}/web`, path.join(fixture, "apps/admin")])).toEqual([
      `${relative}/web`, path.join(fixture, "apps/admin"),
    ]);
  });

  it("follows directory symlinks in globstars without adding the base directory", () => {
    const expected = ["01", "02", "a[1]", "admin", "admin/src", "admin/src/app", "admin/src/app/about", "linked", "linked/pages", "web", "web/pages"];
    expect(roots(path.join(fixture, "apps/**")).sort()).toEqual(expected.map((entry) => path.join(fixture, "apps", entry)).sort());
  });

  it("retains the parent's negative-extglob matching at every visible depth", () => {
    const expected = [".hidden", "01", "02", "a[1]", "admin", "admin/src", "admin/src/app", "admin/src/app/about", "linked", "linked/pages", "web", "web/pages"];
    expect(roots(`${fixture}/apps/**/!(pages)`).sort()).toEqual(expected.map((entry) => `${fixture}/apps/${entry}`).sort());
  });

  it("retains the original spelling of roots reached through a parent segment", () => {
    const expected = ["01", "02", "a[1]", "admin", "linked", "web"];
    expect(roots(`${fixture}/apps/web/../*`).sort()).toEqual(expected.map((entry) => `${fixture}/apps/web/../${entry}`).sort());
  });

  it("keeps Next's internal-link rule active for page roots selected by a glob", async () => {
    const nextLint = new ESLint({
      cwd: root,
      overrideConfig: { settings: { next: { rootDir: `${fixture}/apps/{web,admin}` } } },
    });
    const [result] = await nextLint.lintText(
      'export default function Page() { return <><a href="/">Home</a><a href="/contact">Contact</a></>; }',
      { filePath: "src/app/dependency-check.tsx" },
    );
    expect(result.messages.filter((message) => message.ruleId === "@next/next/no-html-link-for-pages")).toHaveLength(2);
    expect(result.fatalErrorCount).toBe(0);
  });

  it("retains TypeScript alias/package/core resolution through Next's real resolver", async () => {
    const resolver = require("eslint-import-resolver-typescript") as {
      resolve: (source: string, file: string, options: { project: string; alwaysTryTypes: boolean }) => { found: boolean; path?: string | null };
    };
    const file = path.join(root, "src/app/page.tsx");
    const options = { project: path.join(root, "tsconfig.json"), alwaysTryTypes: true };
    expect(resolver.resolve("@/lib/hosted/contracts", file, options)).toEqual({
      found: true, path: path.join(root, "src/lib/hosted/contracts/index.ts"),
    });
    expect(resolver.resolve("react", file, options).found).toBe(true);
    expect(resolver.resolve("node:fs", file, options)).toEqual({ found: true, path: null });
    expect(resolver.resolve("@/lib/dependency-missing", file, options).found).toBe(false);
    const importLint = new ESLint({ cwd: root, overrideConfig: { rules: { "import/no-unresolved": "error" } } });
    const [valid] = await importLint.lintText(
      'import * as contracts from "@/lib/hosted/contracts"; export const names = Object.keys(contracts);',
      { filePath: "src/app/dependency-check.ts" },
    );
    expect(valid.messages.filter((message) => message.ruleId === "import/no-unresolved")).toEqual([]);
    const [missing] = await importLint.lintText('import "@/lib/dependency-missing";', { filePath: "src/app/dependency-check.ts" });
    expect(missing.messages.some((message) => message.ruleId === "import/no-unresolved")).toBe(true);
  });

  it("retains the local unused-variable and hosted-import boundary rules", async () => {
    const [result] = await eslint.lintText(
      'import "@/lib/hosted/contracts/types"; const unused = 1; export function value(_unused: string) { return 2; }',
      { filePath: "src/app/dependency-check.ts" },
    );
    expect(result.messages.filter((message) => message.ruleId === "no-restricted-imports")).toHaveLength(1);
    const unused = result.messages.filter((message) => message.ruleId === "@typescript-eslint/no-unused-vars");
    expect(unused).toHaveLength(1);
    expect(unused[0].message).toContain("'unused'");
    const [owner] = await eslint.lintText('import "@/lib/hosted/contracts/types";', { filePath: "src/lib/hosted/dependency-check.ts" });
    expect(owner.messages.filter((message) => message.ruleId === "no-restricted-imports")).toEqual([]);
  });

  it("bounds deeply nested brace input in an isolated process", () => {
    const script = `
      const { ESLint } = require("eslint");
      const { createRequire } = require("node:module");
      new ESLint({ cwd: process.cwd() }).calculateConfigForFile("src/app/page.tsx").then(() => {
        const nextRequire = createRequire(require.resolve("@next/eslint-plugin-next"));
        try {
          nextRequire("./utils/get-root-dirs").getRootDirs({ cwd: process.cwd(), settings: {
            next: { rootDir: "{".repeat(3000) + "a" + "}".repeat(3000) },
          } });
        } catch (error) { if (error instanceof RangeError) process.exit(2); }
        process.stdout.write("bounded");
      }).catch(() => process.exit(3));
    `;
    const child = spawnSync(process.execPath, ["-e", script], {
      cwd: root, timeout: 10_000, encoding: "utf8", maxBuffer: 4096,
      env: { NODE_ENV: "test", PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, NODE_OPTIONS: "--max-old-space-size=256" },
    });
    expect(child.error).toBeUndefined();
    expect(child.signal).toBeNull();
    expect(child.status).toBe(0);
    expect(child.stdout).toBe("bounded");
  });
});
