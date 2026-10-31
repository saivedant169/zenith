#!/usr/bin/env node
/**
 * Check that `package-lock.json` can only ever install what the public npm
 * registry published — the deterministic half of the `supply-chain` job in
 * .github/workflows/ci.yml.
 *
 * ## The attack this is cheap insurance against
 *
 * `npm ci` installs exactly what the lockfile says, from wherever the lockfile
 * says. A pull request that edits the lockfile by hand — or a tool that
 * "helpfully" rewrites it — can point one package at a different host, an
 * `http://` URL, a git ref, a local path, or drop its `integrity` hash so the
 * tarball is not verified at all. None of that is visible in a review of
 * `package.json`, and a 900-entry lockfile diff is not something a human
 * reads. So this reads every entry and requires, for each one:
 *
 *   - `resolved` is an `https://registry.npmjs.org/<name>/-/…tgz` URL, with no
 *     credentials, query string or fragment, and the path names the same
 *     package the lockfile entry does (a tarball of package B filed under
 *     package A is the shape a lockfile-level substitution takes);
 *   - `integrity` is a `sha512-` hash, so npm verifies the bytes it fetched;
 *   - it is not a `link` (a local-path dependency cannot be reproduced from
 *     the registry, and this repository has no workspaces).
 *
 * One in-repository package is linked on purpose: `vendor/minimatch3-compat` (the minimatch 3.x API over patched
 * minimatch 11 for the lint toolchain, GHSA-g3hv-75wg-m249). Its bytes are reviewed in Git, not fetched, so exactly
 * `node_modules/minimatch` linking to it, and its own entry, pass; any other link still fails.
 *
 * The other legitimate exception is a package with `inBundle: true`: it ships
 * inside its parent's tarball (six entries today, all under
 * `@tailwindcss/oxide-wasm32-wasi`) and so has neither field. Those are covered
 * by the parent's integrity hash.
 *
 * ## What this does not prove
 *
 * That the registry's tarball is benign — only that the lockfile pins bytes
 * from the registry. `npm audit` (the informational step next to this one)
 * speaks to known-vulnerable versions; nothing here speaks to a malicious
 * release nobody has reported. `npm ci --ignore-scripts` is what limits what a
 * bad tarball can do at install time.
 *
 * Usage:  node scripts/ci/lockfile-integrity.mjs [path/to/package-lock.json]
 * Exit:   0 every entry is registry-pinned and hashed, 1 otherwise.
 */
import fs from "node:fs";

const file = process.argv[2] ?? "package-lock.json";
const REGISTRY_HOST = "registry.npmjs.org";

let lock;
try {
  lock = JSON.parse(fs.readFileSync(file, "utf8"));
} catch (error) {
  console.error(`::error::Could not read ${file}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

/** The only local packages: lock key -> the in-repository path it must link to (or be). */
const VENDORED_LINKS = { "node_modules/minimatch": "vendor/minimatch3-compat" };
const VENDORED = new Set(Object.values(VENDORED_LINKS));

const problems = [];
const flag = (key, message) => problems.push(`${key}: ${message}`);

if (lock.lockfileVersion !== 3) {
  problems.push(`lockfileVersion is ${String(lock.lockfileVersion)}, expected 3 (npm 7+ format with per-package integrity).`);
}
if (!lock.packages || typeof lock.packages !== "object") {
  problems.push("the lockfile has no `packages` map, so nothing in it can be checked.");
}

let checked = 0;
let bundled = 0;
for (const [key, entry] of Object.entries(lock.packages ?? {})) {
  if (key === "") continue; // the root project itself
  if (entry.link && VENDORED_LINKS[key] === entry.resolved && Object.keys(entry).sort().join() === "link,resolved") continue;
  if (VENDORED.has(key) && entry.resolved === undefined && entry.integrity === undefined && !entry.link) continue;
  if (entry.link) {
    flag(key, "is a `link` (local path dependency); it cannot be reproduced from the registry.");
    continue;
  }
  if (entry.inBundle) {
    bundled += 1;
    continue;
  }
  checked += 1;

  if (typeof entry.resolved !== "string") {
    flag(key, "has no `resolved` URL.");
  } else {
    let url;
    try {
      url = new URL(entry.resolved);
    } catch {
      flag(key, `resolved is not a URL: ${entry.resolved}`);
    }
    if (url) {
      const name = entry.name ?? key.split("node_modules/").pop();
      if (url.protocol !== "https:" || url.hostname !== REGISTRY_HOST || url.port !== "") {
        flag(key, `resolves outside https://${REGISTRY_HOST}: ${url.origin}`);
      } else if (url.username || url.password || url.search || url.hash) {
        flag(key, "resolved URL carries credentials, a query string or a fragment.");
      } else if (!url.pathname.startsWith(`/${name}/-/`) || !url.pathname.endsWith(".tgz")) {
        flag(key, `resolved tarball path ${url.pathname} does not belong to package ${name}.`);
      }
    }
  }

  if (typeof entry.integrity !== "string" || !entry.integrity.startsWith("sha512-")) {
    flag(key, `integrity is ${entry.integrity === undefined ? "missing" : "not a sha512 hash"}, so npm would not verify the tarball.`);
  }
}

if (problems.length > 0) {
  for (const problem of problems.slice(0, 50)) console.error(`::error::${problem}`);
  if (problems.length > 50) console.error(`::error::…and ${problems.length - 50} more.`);
  console.error(`${file}: ${problems.length} problem(s) across ${checked} registry entries.`);
  process.exit(1);
}

console.log(`${file}: ${checked} packages pinned to https://${REGISTRY_HOST} with sha512 integrity (${bundled} bundled inside a parent tarball).`);
