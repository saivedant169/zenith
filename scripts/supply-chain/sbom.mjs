#!/usr/bin/env node
/**
 * CycloneDX 1.5 JSON SBOM generation for the Zenith release (PROD-OPS-09), with no dependency beyond node and the go tool.
 *
 *   node scripts/supply-chain/sbom.mjs --lock package-lock.json --package package.json \
 *        [--go-binary FILE]... [--go-version-m-file FILE]... [--go GO_EXECUTABLE] \
 *        [--dockerfile FILE]... [--image NAME=sha256:DIGEST]... \
 *        --version 1.2.3 --commit SHA [--timestamp ISO] --out sbom.cdx.json
 *
 * What it records, and from what (no scanner, nothing guessed):
 *  - npm: every package-lock.json entry (name, version, purl, sha512 integrity as a CycloneDX hash, registry URL,
 *    required/optional/excluded scope from the lock's dev/optional flags) and the resolved dependency graph.
 *  - go: the output of `go version -m <binary>` (the build info embedded in the binary): main module, Go toolchain
 *    version, every `dep` line. Go module hashes (h1:) are directory hashes, not file digests, so they are kept as a
 *    property, not as a CycloneDX hash.
 *  - container images: the FROM lines of each Dockerfile (ARG defaults resolved) as container components, whether the
 *    base is pinned by digest, the OpenTofu download and its pinned SHA-256s, plus the built image (name and digest)
 *    named with --image.
 *
 * Not recorded: operating-system packages inside base images (no package database is read). Every container component
 * says so in `zenith:os-packages`. The SBOM is a faithful inventory of declared and embedded build inputs, not a
 * vulnerability statement.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const SBOM_TOOL = { name: "zenith-sbom", version: "1.0.0" };
const SPEC_VERSION = "1.5";
const sha256 = (v) => createHash("sha256").update(v).digest("hex");
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const prop = (name, value) => ({ name, value: String(value) });

/* ----------------------------------- npm ----------------------------------- */

const nodeName = (node) => node.slice(node.lastIndexOf("node_modules/") + "node_modules/".length);

export function npmPurl(name, version) {
  const encoded = name.startsWith("@") ? `%40${name.slice(1)}` : name;
  return `pkg:npm/${encoded}@${version}`;
}

/** sha512-<base64> (SRI) to a lowercase hex digest, or undefined when the integrity is not sha512. */
export function sriToHex(integrity) {
  const m = /^sha512-([A-Za-z0-9+/]{86}==)$/.exec(integrity ?? "");
  return m ? Buffer.from(m[1], "base64").toString("hex") : undefined;
}

/** Physical resolution of a dependency edge, as node loads it (nearest enclosing node_modules first). */
function resolveNode(packages, from, name) {
  const parts = from ? from.split("/") : [];
  for (let n = parts.length; n >= 0; n--) {
    if (parts[n - 1] === "node_modules") continue;
    const candidate = [...parts.slice(0, n), "node_modules", name].join("/");
    if (Object.hasOwn(packages, candidate)) return candidate;
  }
  return undefined;
}

/**
 * The one in-repository npm package (scripts/ci/lockfile-integrity.mjs allows the same link): lock key -> path. Its
 * bytes come from Git, not a registry tarball, so its hash is SHA-512 over its files (sorted path, NUL, bytes, NUL).
 */
const VENDORED_LINKS = { "node_modules/minimatch": "vendor/minimatch3-compat" };
const VENDORED = new Set(Object.values(VENDORED_LINKS));
function vendoredDigest(directory) {
  const hash = createHash("sha512");
  for (const file of fs.readdirSync(directory).sort()) {
    const full = path.join(directory, file);
    if (!fs.lstatSync(full).isFile()) throw new Error(`vendored package ${directory} holds a non-file entry`);
    hash.update(file).update("\0").update(fs.readFileSync(full)).update("\0");
  }
  return hash.digest("hex");
}
const vendoredPathOf = (node, entry) => (entry.link && VENDORED_LINKS[node] === entry.resolved ? entry.resolved
  : VENDORED.has(node) && !entry.link && entry.resolved === undefined && entry.integrity === undefined ? node : undefined);

export function npmComponents(lock, packageJson) {
  if (!isObject(lock) || ![2, 3].includes(lock.lockfileVersion) || !isObject(lock.packages)) throw new Error("package-lock.json must be lockfileVersion 2 or 3");
  const packages = lock.packages;
  const nodes = Object.keys(packages).filter((n) => n !== "").sort();
  const counts = new Map();
  for (const node of nodes) {
    const entry = packages[node];
    if (entry.link && !vendoredPathOf(node, entry)) throw new Error(`lockfile entry ${node} is a link; refusing to inventory an unverifiable dependency`);
    const vendored = vendoredPathOf(node, entry), source = vendored && entry.link ? packages[vendored] ?? {} : entry;
    const key = npmPurl(source.name ?? nodeName(node), source.version);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const refOf = new Map();
  const bundledOwner = (node) => {
    let at = node.lastIndexOf("/node_modules/");
    while (at >= 0) {
      const parent = node.slice(0, at);
      const entry = packages[parent];
      if (entry && !entry.inBundle && sriToHex(entry.integrity)) return parent;
      if (!entry?.inBundle) break;
      at = parent.lastIndexOf("/node_modules/");
    }
    throw new Error(`bundled lockfile entry ${node} has no sha512-pinned enclosing tarball`);
  };
  const components = nodes.map((node) => {
    const entry = packages[node];
    const vendored = vendoredPathOf(node, entry);
    // A link entry carries only its target; name and version come from the linked package's own entry.
    const source = vendored && entry.link ? packages[vendored] ?? {} : entry;
    const name = source.name ?? nodeName(node);
    if (typeof source.version !== "string" || source.version === "") throw new Error(`lockfile entry ${node} has no version`);
    const purl = npmPurl(name, source.version);
    // The same name and version can be installed at several paths; each copy keeps its own bom-ref.
    const ref = counts.get(purl) > 1 ? `${purl}#${node}` : purl;
    refOf.set(node, ref);
    const hex = sriToHex(entry.integrity);
    const component = {
      type: "library",
      "bom-ref": ref,
      name,
      version: source.version,
      purl,
      scope: (entry.dev || source.dev) ? "excluded" : entry.optional ? "optional" : "required",
      properties: [prop("zenith:npm:node", node), prop("zenith:npm:dev", entry.dev === true), prop("zenith:npm:integrity", entry.integrity ?? "missing")],
    };
    if (vendored) {
      component.hashes = [{ alg: "SHA-512", content: vendoredDigest(vendored) }];
      component.properties.push(prop("zenith:npm:vendored-path", vendored));
    } else if (hex) component.hashes = [{ alg: "SHA-512", content: hex }];
    else if (entry.inBundle === true) {
      const owner = bundledOwner(node);
      // This hash belongs to the containing tarball, never to the child's own bytes.
      component.properties.push(prop("zenith:npm:bundled-in-node", owner), prop("zenith:npm:bundle-sha512", sriToHex(packages[owner].integrity)));
    }
    if (typeof entry.resolved === "string") component.externalReferences = [{ type: "distribution", url: entry.resolved }];
    if (typeof entry.license === "string") component.licenses = [{ expression: entry.license }];
    return component;
  });
  const dependencies = nodes.map((node) => {
    const entry = packages[node];
    const refs = new Set();
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      for (const dep of Object.keys(entry[field] ?? {})) {
        const target = resolveNode(packages, node, dep);
        if (target) refs.add(refOf.get(target));
      }
    }
    return { ref: refOf.get(node), dependsOn: [...refs].sort() };
  });
  const root = packages[""] ?? {};
  const direct = new Set();
  for (const field of ["dependencies", "optionalDependencies", "devDependencies", "peerDependencies"]) {
    for (const dep of Object.keys(root[field] ?? packageJson?.[field] ?? {})) {
      const target = resolveNode(packages, "", dep);
      if (target) direct.add(refOf.get(target));
    }
  }
  return { components, dependencies, direct: [...direct].sort() };
}

/* ------------------------------------ go ------------------------------------ */

/**
 * Parse `go version -m` output. Only the build info the toolchain embedded is used; a binary without it (or text that
 * is not that output) is an error, not an empty inventory.
 */
export function parseGoVersionM(text) {
  const lines = text.split(/\r?\n/);
  const header = /^(.+?):\s+(go[0-9][^\s]*)\s*$/.exec(lines[0] ?? "");
  if (!header) throw new Error("not `go version -m` output (missing the binary and Go version line)");
  const info = { binary: header[1].replace(/\\/g, "/").split("/").pop(), goVersion: header[2], path: undefined, main: undefined, deps: [], build: {} };
  for (const raw of lines.slice(1)) {
    const f = raw.replace(/^\t/, "").split("\t");
    if (f[0] === "path") info.path = f[1];
    else if (f[0] === "mod") info.main = { path: f[1], version: f[2] || "(devel)" };
    else if (f[0] === "dep" && f[1] && f[2]) info.deps.push({ path: f[1], version: f[2], h1: f[3] || undefined });
    else if (f[0] === "=>" && f[1] && info.deps.length) info.deps[info.deps.length - 1].replacedBy = { path: f[1], version: f[2], h1: f[3] || undefined };
    else if (f[0] === "build" && f[1]) {
      const eq = f[1].indexOf("=");
      if (eq > 0) info.build[f[1].slice(0, eq)] = f[1].slice(eq + 1);
    }
  }
  if (!info.main && !info.path) throw new Error("`go version -m` output carries no module information; the binary was built without build info");
  return info;
}

export function goPurl(modulePath, version) {
  return `pkg:golang/${modulePath.split("/").map(encodeURIComponent).join("/")}@${version}`;
}

export function goComponents(infos) {
  const components = new Map();
  const dependencies = [];
  const binaries = [];
  for (const info of infos) {
    const toolchain = { type: "platform", "bom-ref": `pkg:generic/go@${info.goVersion.replace(/^go/, "")}`, name: "go", version: info.goVersion.replace(/^go/, ""), purl: `pkg:generic/go@${info.goVersion.replace(/^go/, "")}`, properties: [prop("zenith:source", "go version -m")] };
    components.set(toolchain["bom-ref"], toolchain);
    const refs = [toolchain["bom-ref"]];
    for (const dep of info.deps) {
      const target = dep.replacedBy ?? dep;
      const purl = goPurl(target.path, target.version);
      if (!components.has(purl)) {
        components.set(purl, { type: "library", "bom-ref": purl, name: target.path, version: target.version, purl, scope: "required", properties: [prop("zenith:go:h1", target.h1 ?? "missing"), ...(dep.replacedBy ? [prop("zenith:go:replaces", `${dep.path}@${dep.version}`)] : [])] });
      }
      refs.push(purl);
    }
    const ref = `zenith-go-binary:${info.binary}`;
    const vcs = info.build["vcs.revision"];
    binaries.push({
      type: "application",
      "bom-ref": ref,
      name: info.binary,
      version: info.main?.version ?? "(devel)",
      properties: [prop("zenith:go:module", info.main?.path ?? info.path ?? ""), prop("zenith:go:package", info.path ?? ""), prop("zenith:go:version", info.goVersion), ...(vcs ? [prop("zenith:go:vcs.revision", vcs)] : []), ...Object.entries(info.build).filter(([k]) => ["GOOS", "GOARCH", "CGO_ENABLED", "-trimpath", "-ldflags"].includes(k)).map(([k, v]) => prop(`zenith:go:build:${k}`, v))],
    });
    dependencies.push({ ref, dependsOn: [...new Set(refs)].sort() });
  }
  return { components: [...components.values(), ...binaries], dependencies };
}

/* ------------------------------- container images ------------------------------- */

const DIGEST = /@sha256:([0-9a-f]{64})$/;

/** Dockerfile build inputs: base images (pinned or not) and the pinned OpenTofu download. */
export function dockerfileComponents(text, file) {
  const args = new Map();
  const stages = new Set();
  const bases = [];
  let seenFrom = false;
  const logical = text.replace(/\\\r?\n/g, " ").split(/\r?\n/);
  const expand = (s) => s.replace(/\$\{([A-Za-z0-9_]+)(?::-([^}]*))?\}|\$([A-Za-z0-9_]+)/g, (_m, a, dflt, b) => args.get(a ?? b) ?? dflt ?? `$${a ?? b}`);
  for (const line of logical) {
    const arg = /^\s*ARG\s+([A-Za-z0-9_]+)(?:=(.*))?\s*$/.exec(line);
    if (arg) { if (!seenFrom || !args.has(arg[1])) args.set(arg[1], arg[2] !== undefined ? arg[2].replace(/^["']|["']$/g, "") : args.get(arg[1]) ?? ""); continue; }
    const from = /^\s*FROM\s+(?:--[a-z-]+=\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?/i.exec(line);
    if (from) {
      seenFrom = true;
      const ref = expand(from[1]);
      if (!stages.has(ref) && ref !== "scratch") bases.push(ref);
      if (from[2]) stages.add(from[2]);
    }
  }
  const components = [];
  for (const ref of [...new Set(bases)]) {
    const digest = DIGEST.exec(ref)?.[1];
    const nameTag = ref.replace(DIGEST, "");
    const colon = nameTag.lastIndexOf(":");
    const hasTag = colon > nameTag.lastIndexOf("/");
    const name = hasTag ? nameTag.slice(0, colon) : nameTag;
    const tag = hasTag ? nameTag.slice(colon + 1) : "latest";
    const purl = `pkg:oci/${name.split("/").pop()}${digest ? `@sha256%3A${digest}` : `@${tag}`}?repository_url=${encodeURIComponent(name)}&tag=${encodeURIComponent(tag)}`;
    components.push({
      type: "container",
      "bom-ref": `zenith-base-image:${file}:${ref}`,
      name,
      version: tag,
      purl,
      ...(digest ? { hashes: [{ alg: "SHA-256", content: digest }] } : {}),
      properties: [prop("zenith:pinned", digest ? "digest" : "tag-only"), prop("zenith:dockerfile", file), prop("zenith:os-packages", "not-inventoried")],
    });
  }
  const tofuVersion = args.get("TOFU_VERSION");
  const tofuHashes = [...args.entries()].filter(([k, v]) => /^TOFU_SHA256_/.test(k) && /^[0-9a-f]{64}$/.test(v));
  if (tofuVersion && tofuHashes.length) {
    components.push({
      type: "application",
      "bom-ref": `pkg:generic/opentofu@${tofuVersion}`,
      name: "opentofu",
      version: tofuVersion,
      purl: `pkg:generic/opentofu@${tofuVersion}`,
      hashes: tofuHashes.map(([, v]) => ({ alg: "SHA-256", content: v })),
      properties: [prop("zenith:dockerfile", file), prop("zenith:pinned", "sha256-per-architecture"), ...tofuHashes.map(([k, v]) => prop(`zenith:${k.toLowerCase()}`, v))],
    });
  }
  return components;
}

export function imageComponent(name, digest, file) {
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error(`image digest for ${name} must be sha256:<64 hex>`);
  const hex = digest.slice(7);
  return {
    type: "container",
    "bom-ref": `zenith-image:${name}@${digest}`,
    name,
    version: digest,
    purl: `pkg:oci/${name.split("/").pop()}@sha256%3A${hex}?repository_url=${encodeURIComponent(name)}`,
    hashes: [{ alg: "SHA-256", content: hex }],
    properties: [prop("zenith:role", "built-image"), ...(file ? [prop("zenith:dockerfile", file)] : []), prop("zenith:os-packages", "not-inventoried")],
  };
}

/* ------------------------------- document assembly ------------------------------- */

export function buildSbom({ lock, packageJson, goInfos = [], dockerfiles = [], images = [], version, commit, timestamp }) {
  if (!/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/.test(version ?? "")) throw new Error("--version is required");
  if (!/^[0-9a-f]{7,64}$/.test(commit ?? "")) throw new Error("--commit must be a git commit hash");
  const npm = npmComponents(lock, packageJson);
  const go = goComponents(goInfos);
  const containers = [];
  for (const d of dockerfiles) containers.push(...dockerfileComponents(d.text, d.file));
  for (const i of images) containers.push(imageComponent(i.name, i.digest, i.file));
  const rootRef = `pkg:generic/zenith@${version}`;
  const all = [...npm.components, ...go.components, ...containers];
  const seen = new Set();
  const components = all.filter((c) => (seen.has(c["bom-ref"]) ? false : (seen.add(c["bom-ref"]), true)));
  const dependencies = [
    { ref: rootRef, dependsOn: [...new Set([...npm.direct, ...go.dependencies.map((d) => d.ref), ...containers.map((c) => c["bom-ref"])])].sort() },
    ...npm.dependencies,
    ...go.dependencies,
  ];
  const content = { components, dependencies: dependencies.map(d => d.ref === rootRef ? { ...d, ref: "zenith-root" } : d) };
  const hex = sha256(JSON.stringify(content));
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  return {
    bomFormat: "CycloneDX",
    specVersion: SPEC_VERSION,
    serialNumber: `urn:uuid:${uuid}`,
    version: 1,
    metadata: {
      timestamp: timestamp ?? new Date().toISOString(),
      tools: { components: [{ type: "application", name: SBOM_TOOL.name, version: SBOM_TOOL.version }] },
      component: { type: "application", "bom-ref": rootRef, name: "zenith", version, purl: rootRef, properties: [prop("zenith:git:commit", commit)] },
      properties: [prop("zenith:sbom:scope", "npm lockfile, go build info, Dockerfile inputs and named built images"), prop("zenith:sbom:os-packages", "not inventoried")],
    },
    components,
    dependencies,
  };
}

/** Structural validation of an SBOM this tool produced (and of one a verifier is handed). Returns a list of problems. */
export function validateSbom(doc) {
  const errors = [];
  if (!isObject(doc) || doc.bomFormat !== "CycloneDX" || doc.specVersion !== SPEC_VERSION) return ["not a CycloneDX 1.5 document"];
  if (!/^urn:uuid:[0-9a-f-]{36}$/.test(doc.serialNumber ?? "")) errors.push("serialNumber is not a urn:uuid");
  if (!isObject(doc.metadata?.component) || typeof doc.metadata.component["bom-ref"] !== "string") errors.push("metadata.component is missing");
  if (!Array.isArray(doc.components) || !Array.isArray(doc.dependencies)) return [...errors, "components and dependencies must be arrays"];
  const refs = new Set();
  for (const c of doc.components) {
    if (!isObject(c) || typeof c["bom-ref"] !== "string" || typeof c.name !== "string" || typeof c.type !== "string") { errors.push("a component lacks bom-ref, name or type"); continue; }
    if (refs.has(c["bom-ref"])) errors.push(`duplicate bom-ref ${c["bom-ref"]}`);
    refs.add(c["bom-ref"]);
    for (const h of c.hashes ?? []) {
      const len = { "SHA-256": 64, "SHA-512": 128 }[h.alg];
      if (!len || !new RegExp(`^[0-9a-f]{${len}}$`).test(h.content ?? "")) errors.push(`component ${c["bom-ref"]} has a malformed ${h.alg ?? "?"} hash`);
    }
    if (c.purl?.startsWith("pkg:npm/") && !(c.hashes ?? []).some((h) => h.alg === "SHA-512")) {
      const property = (item, name) => item.properties?.find(p => p.name === name)?.value;
      const ownerNode = property(c, "zenith:npm:bundled-in-node");
      const node = property(c, "zenith:npm:node");
      const owner = ownerNode && doc.components.find(item => property(item, "zenith:npm:node") === ownerNode);
      const parentHash = owner?.hashes?.find(h => h.alg === "SHA-512")?.content;
      if (!owner || !node?.startsWith(`${ownerNode}/node_modules/`) || !/^[0-9a-f]{128}$/.test(parentHash ?? "")
        || property(c, "zenith:npm:bundle-sha512") !== parentHash) errors.push(`npm component ${c["bom-ref"]} has no sha512 integrity hash or verified enclosing bundle`);
    }
  }
  const root = doc.metadata?.component?.["bom-ref"];
  const known = new Set([...refs, root]);
  for (const d of doc.dependencies) {
    if (!known.has(d.ref)) errors.push(`dependency entry for unknown ref ${d.ref}`);
    for (const t of d.dependsOn ?? []) if (!known.has(t)) errors.push(`${d.ref} depends on unknown ref ${t}`);
  }
  return errors;
}

/* ------------------------------------ CLI ------------------------------------ */

function parseArgs(argv) {
  const multi = new Set(["go-binary", "go-version-m-file", "dockerfile", "image"]);
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) throw new Error(`unexpected argument ${argv[i]}`);
    const key = argv[i].slice(2);
    const value = argv[++i];
    if (value === undefined) throw new Error(`--${key} needs a value`);
    if (multi.has(key)) (out[key] ??= []).push(value);
    else out[key] = value;
  }
  return out;
}

export function main(argv, stdout = process.stdout, stderr = process.stderr) {
  try {
    const a = parseArgs(argv);
    if (!a.lock || !a.out) throw new Error("usage: sbom.mjs --lock package-lock.json --out FILE --version V --commit SHA [--package package.json] [--go-binary F] [--go-version-m-file F] [--dockerfile F] [--image NAME=sha256:D]");
    const lock = JSON.parse(fs.readFileSync(a.lock, "utf8"));
    const packageJson = a.package ? JSON.parse(fs.readFileSync(a.package, "utf8")) : undefined;
    const goInfos = [];
    for (const file of a["go-version-m-file"] ?? []) goInfos.push(parseGoVersionM(fs.readFileSync(file, "utf8")));
    for (const binary of a["go-binary"] ?? []) {
      const run = spawnSync(a.go ?? "go", ["version", "-m", binary], { encoding: "utf8", env: { ...process.env, GOTOOLCHAIN: "local" } });
      if (run.status !== 0) throw new Error(`go version -m ${binary} failed: ${(run.stderr || run.error?.message || "").trim()}`);
      goInfos.push(parseGoVersionM(run.stdout));
    }
    const dockerfiles = (a.dockerfile ?? []).map((file) => ({ file: file.replace(/\\/g, "/"), text: fs.readFileSync(file, "utf8") }));
    const images = (a.image ?? []).map((spec) => {
      const eq = spec.indexOf("=");
      if (eq < 1) throw new Error("--image must be NAME=sha256:DIGEST");
      return { name: spec.slice(0, eq), digest: spec.slice(eq + 1) };
    });
    const sbom = buildSbom({ lock, packageJson, goInfos, dockerfiles, images, version: a.version, commit: a.commit, timestamp: a.timestamp });
    const problems = validateSbom(sbom);
    if (problems.length) throw new Error(`generated SBOM is invalid: ${problems.join("; ")}`);
    fs.writeFileSync(a.out, `${JSON.stringify(sbom, null, 2)}\n`);
    stdout.write(`${JSON.stringify({ out: a.out, components: sbom.components.length, sha256: sha256(fs.readFileSync(a.out)) })}\n`);
    return 0;
  } catch (e) {
    stderr.write(`sbom: ${e instanceof Error ? e.message : "failed"}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
