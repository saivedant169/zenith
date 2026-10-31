import { dirname, relative, resolve } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "node:module";
import { statSync } from "node:fs";
import { FlatCompat } from "@eslint/eslintrc";

// Next 15.5.24 uses only globSync(string, { onlyDirectories: true }) from
// fast-glob, in get-root-dirs. Its scoped npm alias removes the unpatched
// micromatch/braces chain. Adapt that call before FlatCompat loads the
// unchanged rules: retain literal roots, include directory symlinks and
// exclude files and the base of a trailing globstar. This is the module
// resolved by this exact Next plugin, not the root glob used by E2B.
const require = createRequire(import.meta.url);
const nextRequire = createRequire(require.resolve("@next/eslint-plugin-next"));
const nextGlob = nextRequire("fast-glob");
const nextGlobPackage = nextRequire("fast-glob/package.json");
if (nextGlobPackage.name !== "glob" || nextGlobPackage.version !== "14.0.3") {
  throw new Error("Next lint requires the reviewed glob 14.0.3 alias.");
}
const globRequire = createRequire(nextRequire.resolve("fast-glob"));
const { braceExpand } = globRequire("minimatch");
const picomatch = require("picomatch");
const adaptedGlob = Symbol.for("zenith.next-lint.globSync");
if (!nextGlob[adaptedGlob]) {
  const globSync = nextGlob.globSync;
  const isDirectory = (entry) => {
    try { return statSync(entry).isDirectory(); }
    catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
      throw error;
    }
  };
  nextGlob.globSync = (pattern, options) => {
    if (typeof pattern !== "string" || options?.onlyDirectories !== true) {
      throw new Error("Unexpected Next directory-glob API; review the lint adapter.");
    }
    if (pattern.startsWith("!") && !pattern.startsWith("!(")) return [];
    const roots = braceExpand(pattern).flatMap((expanded) => {
      const scan = picomatch.scan(expanded, { parts: true });
      if (!scan.isGlob) {
        return isDirectory(expanded) ? [expanded.replace(/\/+$/, "/")] : [];
      }
      // Glob enumerates candidates; Picomatch retains fast-glob's matching
      // options. Minimatch differs on bracket literals, negative extglobs and
      // dot directories, so it must not select the candidate set here.
      const matcher = picomatch.makeRe(expanded.replace(/^\.\//, ""), {
        dot: false, matchBase: false, nobrace: false, nocase: false,
        noext: false, noglobstar: false, posix: true, strictSlashes: false,
      });
      const base = scan.base || ".";
      const fullBase = resolve(base);
      const descendants = scan.glob.includes("/") || scan.isGlobstar ? "**" : "*";
      return globSync(`${base}/${descendants}`, {
        follow: true, dot: true, nocase: false, absolute: true,
      }).flatMap((entry) => {
        const suffix = relative(fullBase, entry).replace(/\\/g, "/");
        if (!suffix || !isDirectory(entry)) return [];
        // Preserve root spellings such as web/../*, as the original reader did.
        const spelling = base === "." ? suffix : `${base}/${suffix}`;
        const matchPath = spelling.replace(/^\.\//, "");
        return matcher.test(matchPath) || matcher.test(`${matchPath}/`) ? [spelling] : [];
      });
    });
    return [...new Set(roots)];
  };
  Object.defineProperty(nextGlob, adaptedGlob, { value: true });
}

const compat = new FlatCompat({ baseDirectory: dirname(fileURLToPath(import.meta.url)) });

/**
 * Next.js recommended rules plus TypeScript. A leading underscore marks a
 * parameter that exists to satisfy an interface and is deliberately unused —
 * the provider adapters are full of them.
 */
const config = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
    },
  },
  // The hosted contracts directory has one door: `@/lib/hosted/contracts`.
  // Reaching past the barrel makes every file that does so a place the layout
  // of that directory has to stay frozen for. Files inside src/lib/hosted are
  // exempt — that is the subsystem that owns the modules.
  {
    files: ["src/**/*.{ts,tsx}", "tests/**/*.{ts,tsx}", "scripts/**/*.ts", "workers/**/*.ts"],
    ignores: ["src/lib/hosted/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/lib/hosted/contracts/*"],
              message:
                "Import from the barrel: `@/lib/hosted/contracts`. Only files inside src/lib/hosted may reach past it.",
            },
          ],
        },
      ],
    },
  },
  { ignores: ["next-env.d.ts", ".next/**", ".data/**", ".data-*/**", "node_modules/**", "supabase/**", "public/gimbal/basis/**", "vendor/**"] },
];

// Named, because `eslint .` lints this file too and flags an anonymous default.
export default config;
