/** Inactive by default. Approval requires purpose-bound signatures from an external trust authority. */
import fs from "node:fs";
import path from "node:path";
import { createHash, createPublicKey, verify } from "node:crypto";

export const SECURITY_EXCEPTION_FILE = "scripts/ci/security-exceptions.json";
export const SECURITY_EXCEPTION_AUTHORITY_FILE = "/etc/zenith/security-exception-authority.json";
const REPOSITORY = "GODOSTROYER/zenith";
export const MAX_EXCEPTION_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_REVIEW_MS = 24 * 60 * 60 * 1000;
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const sha = (v) => createHash("sha256").update(v).digest("hex");
const digest = /^[a-f0-9]{64}$/;
const ghsa = /^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/;
const namePattern = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i;
const nodePattern = /^(?:node_modules\/(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+\/)*node_modules\/(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i;
const identity = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,100}$/;
const reviewReference = /^https:\/\/github\.com\/GODOSTROYER\/zenith\/pull\/[1-9][0-9]*(?:#(?:pullrequestreview|issuecomment)-[1-9][0-9]*)?$/;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sorted = (values) => [...values].sort();
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const exact = (v, fields) => object(v) && same(sorted(Object.keys(v)), sorted(fields));
const require = (condition) => { if (!condition) throw new Error("invalid exception policy"); };
const text = (v) => typeof v === "string" && v.trim().length >= 20 && v.length <= 4000;
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  require(value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)));
  return value;
};
const severities = ["info", "low", "moderate", "high", "critical"];
const numericIdentifier = "(?:0|[1-9][0-9]*)";
const prereleaseIdentifier = `(?:${numericIdentifier}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)`;
const buildIdentifier = "[0-9A-Za-z-]+";
const exactVersion = new RegExp(`^${numericIdentifier}\\.${numericIdentifier}\\.${numericIdentifier}(?:-${prereleaseIdentifier}(?:\\.${prereleaseIdentifier})*)?(?:\\+${buildIdentifier}(?:\\.${buildIdentifier})*)?$`);
const numericPart = new RegExp(`^${numericIdentifier}$`);
const wildcardPart = /^[xX*]$/;
const comparator = /^(?:[<>]=?|[=~^])$/;
function versionOperand(value) {
  if (exactVersion.test(value)) return true;
  const parts = value.split(".");
  if (parts.length < 1 || parts.length > 3) return false;
  let wildcard = false;
  return parts.every((part) => {
    if (wildcardPart.test(part)) { wildcard = true; return true; }
    return !wildcard && numericPart.test(part);
  });
}
function normalizedRange(value) {
  require(typeof value === "string" && value.length > 0 && value.length <= 1000 && value === value.trim());
  const normalized = value.replace(/\s+/g, " ").replace(/\s*\|\|\s*/g, " || ");
  const clauses = normalized.split(" || ").map((part) => {
    const tokens = part.split(" ");
    if (tokens.includes("-")) {
      // A hyphen connects two plain versions/partials; comparator operands are invalid.
      require(tokens.length === 3 && tokens[1] === "-" && versionOperand(tokens[0]) && versionOperand(tokens[2]));
      return tokens.join(" ");
    }
    const comparisons = [];
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index];
      if (comparator.test(token)) {
        require(index + 1 < tokens.length && versionOperand(tokens[index + 1]));
        comparisons.push(token + tokens[++index]);
      } else {
        const match = /^(<=|>=|<|>|=|~|\^)?(.+)$/.exec(token);
        require(match !== null && versionOperand(match[2]));
        comparisons.push((match[1] ?? "") + match[2]);
      }
    }
    require(comparisons.length > 0);
    return comparisons.join(" ");
  });
  return clauses.join(" || ");
}

/** Current npm risk scope, independently validated and normalized before signing/comparison.
 * Includes direct advisory content, propagated severity/range and remediation information.
 */
export function securityFindingScope(finding) {
  require(object(finding) && typeof finding.name === "string" && namePattern.test(finding.name));
  require(severities.includes(finding.severity) && typeof finding.isDirect === "boolean");
  require(Array.isArray(finding.nodes) && finding.nodes.length > 0 && finding.nodes.every((v) => typeof v === "string" && nodePattern.test(v)) && new Set(finding.nodes).size === finding.nodes.length);
  require(Array.isArray(finding.effects) && finding.effects.every((v) => typeof v === "string" && namePattern.test(v)) && new Set(finding.effects).size === finding.effects.length);
  const fix = finding.fixAvailable;
  require(typeof fix === "boolean" || (exact(fix, ["name", "version", "isSemVerMajor"]) && typeof fix.name === "string" && namePattern.test(fix.name) && typeof fix.version === "string" && fix.version.length <= 1000 && exactVersion.test(fix.version) && typeof fix.isSemVerMajor === "boolean"));
  require(Array.isArray(finding.via) && finding.via.length > 0);
  const via = finding.via.map((advisory) => {
    if (typeof advisory === "string") { require(namePattern.test(advisory)); return advisory; }
    require(exact(advisory, ["source", "name", "dependency", "title", "url", "severity", "cwe", "cvss", "range"]));
    require(Number.isSafeInteger(advisory.source) && advisory.source > 0 && typeof advisory.name === "string" && namePattern.test(advisory.name) && typeof advisory.dependency === "string" && namePattern.test(advisory.dependency));
    require(typeof advisory.title === "string" && advisory.title.trim().length > 0 && advisory.title.length <= 1000 && typeof advisory.url === "string" && /^https:\/\/github\.com\/advisories\/GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/.test(advisory.url) && severities.includes(advisory.severity));
    require(Array.isArray(advisory.cwe) && advisory.cwe.every((v) => typeof v === "string" && /^CWE-[0-9]+$/.test(v)) && new Set(advisory.cwe).size === advisory.cwe.length);
    require(exact(advisory.cvss, ["score", "vectorString"]) && typeof advisory.cvss.score === "number" && Number.isFinite(advisory.cvss.score) && advisory.cvss.score >= 0 && advisory.cvss.score <= 10 && (advisory.cvss.vectorString === null || (typeof advisory.cvss.vectorString === "string" && /^CVSS:[0-9.]+\/[A-Za-z0-9:/.-]+$/.test(advisory.cvss.vectorString))));
    return { source: advisory.source, name: advisory.name, dependency: advisory.dependency, title: advisory.title, url: advisory.url, severity: advisory.severity, cwe: sorted(advisory.cwe), cvss: { score: advisory.cvss.score, vectorString: advisory.cvss.vectorString }, range: normalizedRange(advisory.range) };
  }).sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b)));
  // npm reports an entry affected only through vulnerable dependencies (every via a package name) with an empty range.
  const effectOnly = finding.range === "" && via.every((v) => typeof v === "string");
  return { package: finding.name, severity: finding.severity, range: effectOnly ? "" : normalizedRange(finding.range), isDirect: finding.isDirect, nodes: sorted(finding.nodes), effects: sorted(finding.effects), fixAvailable: typeof fix === "boolean" ? fix : { name: fix.name, version: fix.version, isSemVerMajor: fix.isSemVerMajor }, via };
}

/** Canonical UTF-8 signed request. Both roles authorize the same complete record, including
 * both identities/key IDs/references/times, with a distinct purpose for each signature.
 * This helper never creates an approval, key or signature.
 */
export function securityExceptionApprovalPayload(entry, role) {
  require(role === "reviewer" || role === "operator");
  const record = structuredClone(entry);
  if (object(record.review)) delete record.review.signature;
  if (object(record.approval)) delete record.approval.signature;
  return Buffer.from(JSON.stringify(canonical({ domain: `zenith.security-exception.${role}.v1`, repository: REPOSITORY, record })), "utf8");
}

/** The candidate checkout cannot supply its trust roots. Deployment of this root-owned
 * authority is a separate authenticated operator action, currently not configured.
 */
function readAuthority(root) {
  const absolute = fs.realpathSync(SECURITY_EXCEPTION_AUTHORITY_FILE);
  const checkout = fs.realpathSync(root);
  require(!absolute.startsWith(checkout + path.sep) && absolute !== checkout);
  require(!fs.lstatSync(SECURITY_EXCEPTION_AUTHORITY_FILE).isSymbolicLink());
  for (let directory = path.dirname(absolute);; directory = path.dirname(directory)) {
    const stat = fs.statSync(directory);
    require(stat.isDirectory() && stat.uid === 0 && (stat.mode & 0o022) === 0);
    if (directory === path.dirname(directory)) break;
  }
  const fd = fs.openSync(SECURITY_EXCEPTION_AUTHORITY_FILE, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    require(stat.isFile() && stat.uid === 0 && (stat.mode & 0o022) === 0 && stat.size > 0 && stat.size <= 65536);
    return JSON.parse(fs.readFileSync(fd, "utf8"));
  } finally { fs.closeSync(fd); }
}

function authorityKeys(authority) {
  require(exact(authority, ["schemaVersion", "repository", "reviewerKeys", "operatorKeys"]) && authority.schemaVersion === 1 && authority.repository === REPOSITORY);
  const ids = new Set(), fingerprints = new Set();
  const keys = {};
  for (const role of ["reviewer", "operator"]) {
    const entries = authority[`${role}Keys`];
    require(Array.isArray(entries) && entries.length > 0 && entries.length <= 20);
    keys[role] = new Map();
    for (const entry of entries) {
      require(exact(entry, ["id", "actor", "publicKeyPem"]));
      require(typeof entry.id === "string" && identity.test(entry.id) && !ids.has(entry.id));
      require(typeof entry.actor === "string" && identity.test(entry.actor));
      require(typeof entry.publicKeyPem === "string" && entry.publicKeyPem.length <= 1000 && /^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\n?$/.test(entry.publicKeyPem));
      const key = createPublicKey(entry.publicKeyPem);
      require(key.asymmetricKeyType === "ed25519");
      const fingerprint = sha(key.export({ format: "der", type: "spki" }));
      require(!fingerprints.has(fingerprint));
      keys[role].set(entry.id, { actor: entry.actor, key }); ids.add(entry.id); fingerprints.add(fingerprint);
    }
  }
  return keys;
}

function authenticatedApproval(entry, keys) {
  require(entry.review.reviewer !== entry.approval.operator);
  for (const role of ["reviewer", "operator"]) {
    const approval = role === "reviewer" ? entry.review : entry.approval;
    const actor = role === "reviewer" ? approval.reviewer : approval.operator;
    require(typeof approval.keyId === "string" && identity.test(approval.keyId));
    const trusted = keys[role].get(approval.keyId);
    require(trusted !== undefined && trusted.actor === actor);
    require(typeof approval.signature === "string" && /^[A-Za-z0-9+/]{86}==$/.test(approval.signature));
    require(verify(null, securityExceptionApprovalPayload(entry, role), trusted.key, Buffer.from(approval.signature, "base64")));
  }
}

function time(v) {
  require(typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v));
  const t = Date.parse(v);
  require(Number.isFinite(t) && new Date(t).toISOString() === v);
  return t;
}

function readSource(root, file) {
  const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.@()+[]-";
  require(typeof file === "string" && file.split("/").every((p) => p.length > 0 && [...p].every((c) => characters.includes(c))));
  require(!file.split("/").some((p) => p === "." || p === ".." || p === ".git" || p === "node_modules" || p.startsWith(".env")));
  const base = fs.realpathSync(root);
  let component = base;
  for (const part of file.split("/")) {
    component = path.join(component, part);
    require(!fs.lstatSync(component).isSymbolicLink());
  }
  const resolved = fs.realpathSync(path.join(base, file));
  require(!path.relative(base, resolved).split(path.sep).some((p) => p === ".git" || p === "node_modules" || p.startsWith(".env")));
  require(resolved.startsWith(base + path.sep) && fs.statSync(resolved).isFile());
  return fs.readFileSync(resolved);
}

/** Bind reviewed reachability to current application, tooling, deployment and configuration bytes.
 * Only the registry is excluded to avoid a self-referential digest. No installed/generated files.
 */
export function securitySourceDigest(root) {
  const files = [];
  const walk = (relative) => {
    if (relative === SECURITY_EXCEPTION_FILE || relative.split("/").includes("node_modules")) return;
    const absolute = path.join(root, relative);
    const stat = fs.lstatSync(absolute);
    require(!stat.isSymbolicLink());
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(absolute).sort()) walk(`${relative}/${entry}`);
    } else {
      require(stat.isFile());
      files.push({ file: relative, sha256: sha(readSource(root, relative)) });
    }
  };
  for (const dir of ["src", "workers", "scripts", "docker", "deploy", "go", "policy", "supabase", "public", "here-now-gimbal", ".github"]) {
    if (fs.existsSync(path.join(root, dir))) walk(dir);
  }
  for (const file of fs.readdirSync(root).sort()) {
    if ((file === "Dockerfile" || file === ".dockerignore" || /\.(?:json|[cm]?js|[cm]?ts|ya?ml|toml|sh)$/.test(file))) {
      const stat = fs.lstatSync(path.join(root, file));
      require(!stat.isSymbolicLink());
      if (stat.isFile()) walk(file);
    }
  }
  require(files.some((f) => f.file === "package.json") && files.some((f) => f.file === "package-lock.json"));
  return sha(JSON.stringify(files.sort((a, b) => compare(a.file, b.file))));
}

function dependencyMap(value) {
  require(value === undefined || object(value));
  const map = value ?? {};
  require(Object.entries(map).every(([name, spec]) => namePattern.test(name) && typeof spec === "string" && spec.length > 0));
  return map;
}

/** Resolve the physical dependency a Node process loads, including nested hoisting and installed peers.
 * Optional missing edges are allowed; required missing edges, links and unsupported layout fail closed.
 * dev:true is only an additional check, never a reachability proof.
 */
export function lockedReachability(lock, packageJson) {
  require(object(lock) && [2, 3].includes(lock.lockfileVersion) && object(lock.packages) && object(lock.packages[""]));
  const packages = lock.packages;
  for (const [node, entry] of Object.entries(packages)) {
    require(object(entry) && !entry.link && (node === "" || nodePattern.test(node)));
    if (node) require(typeof entry.version === "string" && entry.version.length > 0);
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) dependencyMap(entry[field]);
  }
  require(object(packageJson));
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    const normalize = (v) => Object.entries(dependencyMap(v)).sort(([a], [b]) => compare(a, b));
    require(same(normalize(packageJson[field]), normalize(packages[""][field])));
  }
  const resolve = (from, name) => {
    const parts = from ? from.split("/") : [];
    for (let n = parts.length; n >= 0; n--) {
      if (parts[n - 1] === "node_modules") continue;
      const candidate = [...parts.slice(0, n), "node_modules", name].join("/");
      if (Object.hasOwn(packages, candidate)) return candidate;
    }
    return undefined;
  };
  const edges = (entry) => {
    const deps = dependencyMap(entry.dependencies);
    const optional = dependencyMap(entry.optionalDependencies);
    const peers = dependencyMap(entry.peerDependencies);
    require(entry.peerDependenciesMeta === undefined || object(entry.peerDependenciesMeta));
    const out = new Map(Object.keys(deps).map((n) => [n, false]));
    for (const n of Object.keys(optional)) out.set(n, true);
    for (const n of Object.keys(peers)) {
      if (!out.has(n)) out.set(n, entry.peerDependenciesMeta?.[n]?.optional === true);
    }
    const bundled = entry.bundleDependencies ?? entry.bundledDependencies;
    require(bundled === undefined || typeof bundled === "boolean" || (Array.isArray(bundled) && bundled.every((n) => namePattern.test(n))));
    if (Array.isArray(bundled)) for (const n of bundled) out.set(n, false);
    return out;
  };
  const closure = (initial) => {
    const visited = new Set();
    const add = (from, names) => {
      for (const [name, optional] of names) {
        const node = resolve(from, name);
        require(node !== undefined || optional);
        if (node !== undefined && !visited.has(node)) { visited.add(node); queue.push(node); }
      }
    };
    const queue = [];
    add("", initial);
    for (let n = 0; n < queue.length; n++) add(queue[n], edges(packages[queue[n]]));
    return visited;
  };
  return {
    production: closure(edges(packages[""])),
    development: closure(new Map(Object.keys(dependencyMap(packages[""].devDependencies)).map((n) => [n, false]))),
  };
}

function nodeName(node) { return node.slice(node.lastIndexOf("node_modules/") + "node_modules/".length); }

function evidence(root, value) {
  require(exact(value, ["summary", "sources"]) && text(value.summary) && Array.isArray(value.sources) && value.sources.length > 0 && value.sources.length <= 30);
  const seen = new Set();
  for (const source of value.sources) {
    require(exact(source, ["file", "sha256"]) && typeof source.sha256 === "string" && digest.test(source.sha256) && !seen.has(source.file));
    require(source.file !== SECURITY_EXCEPTION_FILE && sha(readSource(root, source.file)) === source.sha256);
    seen.add(source.file);
  }
}

const blocked = (assessment) => ({ ...assessment, ok: false, reason: "Security exception policy or external approval authority is malformed, unauthenticated, stale, expired, unreadable or ineligible; the gate remains blocked.", accepted: [], unaccepted: assessment.findings, exceptions: [] });

/** Production entry point. The caller cannot inject keys or choose a trust-store path.
 * Invalid audits are returned unchanged; an empty registry needs no authority.
 */
export function applySecurityExceptions(assessment, report, lockBytes, registry, root) {
  if (assessment.validated !== true) return assessment;
  try {
    const authority = Array.isArray(registry?.exceptions) && registry.exceptions.length > 0 ? readAuthority(root) : undefined;
    return evaluateSecurityExceptions(assessment, report, lockBytes, registry, root, Date.now(), authority, Date.now);
  } catch { return blocked(assessment); }
}

/** Verification core for explicit trusted public anchors and synthetic in-memory unit fixtures.
 * This does not establish the authority of caller-supplied keys. The production gate always
 * uses applySecurityExceptions, which loads only the fixed external trust store.
 */
export function evaluateSecurityExceptions(assessment, report, lockBytes, registry, root, now, authority, finalClock = () => now) {
  if (assessment.validated !== true) return assessment;
  try {
    require(Number.isSafeInteger(now) && now >= 0);
    require(exact(registry, ["schemaVersion", "exceptions"]) && registry.schemaVersion === 1 && Array.isArray(registry.exceptions) && registry.exceptions.length <= 50);
    if (registry.exceptions.length === 0) return { ...assessment, accepted: [], unaccepted: assessment.findings, exceptions: [] };
    const keys = authorityKeys(authority);
    const lock = JSON.parse(lockBytes.toString("utf8"));
    const graph = lockedReachability(lock, JSON.parse(readSource(root, "package.json").toString("utf8")));
    const sourceDigest = securitySourceDigest(root);
    const records = new Map();
    const ids = new Set();
    for (const entry of registry.exceptions) {
      require(exact(entry, ["id", "status", "advisoryId", "advisoryScope", "lockSha256", "sourceSha256", "affectedNodes", "owner", "issuedAt", "reviewDueAt", "expiresAt", "review", "approval", "reachability", "mitigations", "primarySources"]));
      require(typeof entry.id === "string" && /^sec-[a-z0-9-]{1,80}$/.test(entry.id) && !ids.has(entry.id));
      require(entry.status === "approved" && typeof entry.advisoryId === "string" && ghsa.test(entry.advisoryId) && !records.has(entry.advisoryId));
      require(entry.lockSha256 === sha(lockBytes) && entry.sourceSha256 === sourceDigest && typeof entry.owner === "string" && identity.test(entry.owner));
      require(exact(entry.review, ["reviewer", "decision", "reviewedAt", "reference", "keyId", "signature"]) && exact(entry.approval, ["operator", "decision", "approvedAt", "reference", "keyId", "signature"]));
      require(typeof entry.review.reviewer === "string" && typeof entry.approval.operator === "string" && identity.test(entry.review.reviewer) && identity.test(entry.approval.operator) && entry.review.decision === "approved" && entry.approval.decision === "approved");
      require(typeof entry.review.reference === "string" && typeof entry.approval.reference === "string" && reviewReference.test(entry.review.reference) && reviewReference.test(entry.approval.reference));
      authenticatedApproval(entry, keys);
      const issued = time(entry.issuedAt), reviewed = time(entry.review.reviewedAt), approved = time(entry.approval.approvedAt);
      const due = time(entry.reviewDueAt), expires = time(entry.expiresAt);
      require(issued <= reviewed && reviewed <= approved && approved <= now && now < due && due <= expires && expires > issued && expires - issued <= MAX_EXCEPTION_MS && due - reviewed <= MAX_REVIEW_MS);
      evidence(root, entry.reachability); evidence(root, entry.mitigations);
      require(Array.isArray(entry.primarySources) && entry.primarySources.length > 0 && entry.primarySources.length <= 20 && new Set(entry.primarySources).size === entry.primarySources.length);
      require(entry.primarySources.includes(`https://github.com/advisories/${entry.advisoryId}`) && entry.primarySources.every((v) => {
        if (typeof v !== "string" || !/^https:\/\/[^\s]+$/.test(v)) return false;
        const url = new URL(v); return url.protocol === "https:" && !url.username && !url.password && !url.search;
      }));
      const affected = assessment.findings.filter((f) => f.advisoryIds.includes(entry.advisoryId));
      require(affected.length > 0 && Array.isArray(entry.affectedNodes) && entry.affectedNodes.length > 0 && entry.affectedNodes.length < Object.keys(lock.packages).length);
      const currentScope = affected.map((finding) => securityFindingScope(report.vulnerabilities[finding.package])).sort((a, b) => compare(a.package, b.package));
      require(same(canonical(entry.advisoryScope), canonical(currentScope)));
      const expected = [];
      for (const finding of affected) {
        const nodes = report.vulnerabilities[finding.package].nodes;
        require(new Set(nodes).size === nodes.length);
        // Bind every locked copy of each affected package, not an arbitrarily selected audit node.
        const copies = Object.keys(lock.packages).filter((n) => n && (lock.packages[n].name ?? nodeName(n)) === finding.package);
        require(same(sorted(nodes), sorted(copies)));
        for (const node of nodes) {
          const locked = lock.packages[node];
          require(nodePattern.test(node) && nodeName(node) === finding.package && object(locked) && !locked.link && locked.dev === true);
          require(graph.development.has(node) && !graph.production.has(node));
          require(typeof locked.integrity === "string" && /^sha512-[A-Za-z0-9+/]{86}==$/.test(locked.integrity));
          expected.push({ package: finding.package, node, version: locked.version, integrity: locked.integrity });
        }
      }
      const normalize = (nodes) => [...nodes].sort((a, b) => compare(a.node, b.node));
      require(entry.affectedNodes.every((n) => exact(n, ["package", "node", "version", "integrity"])) && same(normalize(entry.affectedNodes), normalize(expected)));
      records.set(entry.advisoryId, entry); ids.add(entry.id);
    }
    const accepted = [], unaccepted = [];
    for (const finding of assessment.findings) {
      if (finding.advisoryIds.every((id) => records.has(id))) {
        accepted.push({ ...finding, exceptionIds: sorted(finding.advisoryIds.map((id) => records.get(id).id)) });
      } else unaccepted.push(finding);
    }
    // Read only after source/evidence/authority/signature validation and just before clearance.
    const finalNow = finalClock();
    require(Number.isSafeInteger(finalNow) && finalNow >= now);
    require([...records.values()].every((entry) => finalNow < time(entry.reviewDueAt) && finalNow < time(entry.expiresAt)));
    return {
      ...assessment, ok: unaccepted.length === 0,
      reason: `${assessment.findings.length} known dependency findings remain present; ${accepted.length} covered by reviewed expiring exceptions, ${unaccepted.length} unaccepted.`,
      accepted, unaccepted, exceptions: [...records.values()].map((e) => ({ id: e.id, advisoryId: e.advisoryId, reviewDueAt: e.reviewDueAt, expiresAt: e.expiresAt })),
    };
  } catch {
    return blocked(assessment);
  }
}
