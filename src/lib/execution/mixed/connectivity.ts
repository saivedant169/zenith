/**
 * Protected cross-cloud connectivity (PROD-MIX-05).
 *
 * A mixed plan splits one application over partitions that live in different clouds. Whatever crosses a
 * cloud or account boundary (partitions on different providers or connections; see `requiredPairs`) needs a declared,
 * checked, approved path. The DEFAULT path is a PROTECTED ENDPOINT:
 * a DNS name that resolves to the producer, behind mutual TLS (the client must present a certificate; the
 * server certificate is pinned) and an IP allowlist limited to the consumer partition's own egress
 * addresses. A VPN is an OPT-IN module (`vpn.optIn: true`): it needs non-overlapping address space and
 * keys held as vault references. This module never configures a network and never calls a cloud. It
 * judges a DECLARATION against the plan, refuses anything unsafe, and produces a digest the parent
 * approval binds (the declaration is stored on the plan and its digest is part of the approved proposal
 * input), so a person approves exactly these endpoints.
 *
 * What it proves, and what it cannot:
 *  - binding checks (partition, DNS, TLS, identity, secret, allowlist, overlap) are exact and deterministic;
 *  - it cannot see the provider's actual route tables or certificates: the gated live harness
 *    (`scripts/acceptance/mixed/connectivity-probe.ts`) probes a deployed run and is never counted as
 *    passed when skipped.
 *
 * A database is never silently public: a `database` endpoint must be mTLS-required, allowlisted to
 * single hosts that belong to the consumer's declared egress, and may not use a wildcard name.
 */
import { digest } from "@/lib/controlplane/digest";
import type { ChildReference, ChildSubplan } from "./types";

export const CONNECTIVITY_FORMAT = "zenith.mixed-connectivity.v1" as const;

export type DataClass = "database" | "service" | "function";
export type ConnectivityMode = "protected_endpoint" | "vpn";

export interface PartitionNetwork {
  partitionId: string;
  /** private address space of the partition's network(s) */
  cidrs: readonly string[];
  /** public egress addresses (NAT / function / VM) calls from this partition leave from, as host addresses or CIDRs */
  egress: readonly string[];
}

export interface ProtectedEndpoint {
  id: string;
  /** serves the endpoint */
  producerPartitionId: string;
  /** calls it */
  consumerPartitionId: string;
  dataClass: DataClass;
  mode: "protected_endpoint";
  host: string;
  port: number;
  dns: { name: string; expectedTargets: readonly string[]; ttlMaxSeconds: number };
  tls: {
    minVersion: "1.2" | "1.3";
    serverNames: readonly string[];
    /** hex SHA-256 of the server certificate SubjectPublicKeyInfo the consumer pins */
    serverSpkiSha256: string;
    clientAuth: "required";
    /** hex SHA-256 of the CA bundle that signs client certificates the producer accepts */
    clientCaDigest: string;
  };
  identity: {
    clientCertSubject: string;
    /** must equal the consumer child's connection identity digest */
    consumerConnectionIdentityDigest: string;
  };
  /** vault references only; never key or certificate bytes */
  secrets: { clientKeyRef: string; clientCertRef: string };
  /** sources the producer admits; must lie inside the consumer's declared egress */
  allowlist: readonly string[];
}

export interface VpnLink {
  id: string;
  producerPartitionId: string;
  consumerPartitionId: string;
  kind: "ipsec" | "wireguard";
  producerCidr: string;
  consumerCidr: string;
  keyRef: string;
}

export interface VpnModule {
  /** must be literally true: a VPN is never inferred or defaulted */
  optIn: boolean;
  links: readonly VpnLink[];
}

export interface ConnectivityDeclaration {
  format: typeof CONNECTIVITY_FORMAT;
  networks: readonly PartitionNetwork[];
  endpoints: readonly ProtectedEndpoint[];
  vpn?: VpnModule;
}

export type ConnectivityProblemCode =
  | "format" | "unknown_partition" | "duplicate_id" | "missing_connectivity" | "cidr_invalid" | "cidr_overlap" | "allowlist_empty" | "allowlist_wildcard"
  | "allowlist_private" | "allowlist_too_broad" | "allowlist_outside_egress" | "database_public" | "mtls_not_required" | "tls_version" | "tls_name_mismatch"
  | "tls_wildcard" | "tls_pin_missing" | "client_ca_missing" | "dns_invalid" | "dns_target_private" | "dns_ttl" | "identity_mismatch" | "secret_not_reference"
  | "inline_secret" | "vpn_not_opted_in" | "vpn_unknown_partition" | "vpn_key_not_reference" | "vpn_overlap" | "port_invalid" | "no_egress_declared";

export interface ConnectivityProblem { code: ConnectivityProblemCode; subject: string; message: string }

export interface ConnectivityPath { consumerPartitionId: string; producerPartitionId: string; via: "protected_endpoint" | "vpn"; id: string }

export interface ConnectivityAssessment {
  ok: boolean;
  problems: ConnectivityProblem[];
  /** every cross-partition dependency and the path that covers it */
  paths: ConnectivityPath[];
  /** CIDR overlaps found between partition networks; tolerated only where no private route is used */
  overlapsTolerated: { a: string; b: string }[];
  digest: string;
}

/** The slice of a parent plan the assessment reads. */
export interface ConnectivityPlanView {
  children: readonly Pick<ChildSubplan, "partitionId" | "dependsOn" | "authority" | "nodes">[];
  references: readonly Pick<ChildReference, "producerPartitionId" | "consumerPartitionId">[];
}

/* ---------------------------------- CIDR ---------------------------------- */

export interface ParsedCidr { family: 4 | 6; start: bigint; end: bigint; prefix: number; text: string }

function parseV4(text: string): bigint | undefined {
  const parts = text.split(".");
  if (parts.length !== 4) return undefined;
  let value = 0n;
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return undefined;
    const n = Number(part);
    if (n > 255) return undefined;
    value = (value << 8n) | BigInt(n);
  }
  return value;
}

function parseV6(text: string): bigint | undefined {
  if (!/^[0-9a-fA-F:]+$/.test(text) || text.includes(":::")) return undefined;
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1 && head.length !== 8) return undefined;
  if (halves.length === 2 && head.length + tail.length > 7) return undefined;
  const groups = halves.length === 2 ? [...head, ...Array(8 - head.length - tail.length).fill("0"), ...tail] : head;
  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return undefined;
    value = (value << 16n) | BigInt(`0x${group}`);
  }
  return value;
}

/** A bare address is a host route (/32 or /128). Returns undefined for anything malformed. */
export function parseCidr(input: string): ParsedCidr | undefined {
  if (typeof input !== "string" || input.length > 64) return undefined;
  const slash = input.indexOf("/");
  const addr = slash === -1 ? input : input.slice(0, slash);
  const family: 4 | 6 = addr.includes(":") ? 6 : 4;
  const bits = family === 4 ? 32 : 128;
  let prefix = bits;
  if (slash !== -1) {
    const raw = input.slice(slash + 1);
    if (!/^\d{1,3}$/.test(raw)) return undefined;
    prefix = Number(raw);
    if (prefix > bits) return undefined;
  }
  const value = family === 4 ? parseV4(addr) : parseV6(addr);
  if (value === undefined) return undefined;
  const hostBits = BigInt(bits - prefix);
  const mask = ((1n << BigInt(bits)) - 1n) ^ ((1n << hostBits) - 1n);
  // A CIDR with host bits set is ambiguous ("10.0.0.5/24"): refuse rather than silently widen it.
  if ((value & mask) !== value) return undefined;
  return { family, start: value, end: value | ((1n << hostBits) - 1n), prefix, text: input };
}

export function cidrsOverlap(a: ParsedCidr, b: ParsedCidr): boolean {
  return a.family === b.family && a.start <= b.end && b.start <= a.end;
}

export function cidrContains(outer: ParsedCidr, inner: ParsedCidr): boolean {
  return outer.family === inner.family && outer.start <= inner.start && inner.end <= outer.end;
}

const PRIVATE_RANGES: readonly string[] = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "169.254.0.0/16", "127.0.0.0/8", "fc00::/7", "fe80::/10", "::1/128"];
const PRIVATE = PRIVATE_RANGES.map((r) => parseCidr(r)!);
export const isPrivateRange = (cidr: ParsedCidr): boolean => PRIVATE.some((p) => cidrContains(p, cidr));
const isWholeInternet = (cidr: ParsedCidr): boolean => cidr.prefix === 0;

/* ------------------------------ other checks ------------------------------- */

const HOSTNAME = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;
const VAULT_REF = /^vault:[A-Za-z0-9_-]{1,128}\/[A-Za-z0-9_-]{1,128}\/[A-Za-z0-9_-]{1,128}$/;
const HEX = /^[a-f0-9]{64}$/;
const PEM_OR_KEY = /-----BEGIN [A-Z ]+-----|AKIA[0-9A-Z]{16}|-----END /;
const isIpLiteral = (text: string): boolean => parseCidr(text) !== undefined && !text.includes("/");

function* strings(value: unknown): Generator<string> {
  if (typeof value === "string") yield value;
  else if (Array.isArray(value)) for (const v of value) yield* strings(v);
  else if (value && typeof value === "object") for (const v of Object.values(value)) yield* strings(v);
}

export function connectivityDigest(declaration: ConnectivityDeclaration): string {
  return digest(declaration);
}

const pairKey = (consumer: string, producer: string): string => `${consumer}\u0000${producer}`;

/**
 * The (consumer, producer) partition pairs the plan itself says must talk AND that cross a cloud or account boundary.
 * Two partitions bound to the SAME connection (same provider, same connection id: one account, project or subscription,
 * governed by that provider's IAM) share one trust boundary, so they need no declared protected endpoint. Every other
 * pair stays required: another provider, another connection, or a partition this view cannot place (fail closed).
 * The identity comes from the plan's stored authority, which is part of its digests, never from caller input.
 */
export function requiredPairs(plan: ConnectivityPlanView): { consumer: string; producer: string }[] {
  const byId = new Map(plan.children.map((child) => [child.partitionId, child.authority]));
  const seen = new Map<string, { consumer: string; producer: string }>();
  const add = (consumer: string, producer: string): void => {
    const a = byId.get(consumer);
    const b = byId.get(producer);
    // Excuse only a proven same-boundary pair: both ids are non-empty strings and equal, and both providers are equal non-empty strings.
    // A missing or empty id never matches, so two unplaced partitions stay required (fail closed).
    const sameBoundary = a !== undefined && b !== undefined
      && typeof a.connectionId === "string" && a.connectionId.length > 0 && a.connectionId === b.connectionId
      && typeof a.provider === "string" && a.provider.length > 0 && a.provider === b.provider;
    if (sameBoundary) return;
    seen.set(pairKey(consumer, producer), { consumer, producer });
  };
  for (const child of plan.children) for (const dep of child.dependsOn) add(child.partitionId, dep);
  for (const ref of plan.references) add(ref.consumerPartitionId, ref.producerPartitionId);
  return [...seen.values()].sort((a, b) => (pairKey(a.consumer, a.producer) < pairKey(b.consumer, b.producer) ? -1 : 1));
}

const DATA_KINDS = new Set(["postgres", "mysql", "redis"]);
/** Infer what a producer partition serves from its nodes; a partition holding any datastore is treated as a database. */
export function dataClassOf(child: Pick<ChildSubplan, "nodes">): DataClass {
  if (child.nodes.some((n) => DATA_KINDS.has(n.kind))) return "database";
  if (child.nodes.some((n) => n.kind === "function")) return "function";
  return "service";
}

/**
 * Judge a declaration against a plan. Never throws for a bad declaration; returns every problem so an operator sees
 * them all at once. `ok` requires zero problems AND a covering path for every cross-partition dependency.
 */
export function assessConnectivity(plan: ConnectivityPlanView, declaration: ConnectivityDeclaration): ConnectivityAssessment {
  const problems: ConnectivityProblem[] = [];
  const add = (code: ConnectivityProblemCode, subject: string, message: string) => { problems.push({ code, subject, message }); };
  const partitions = new Map(plan.children.map((c) => [c.partitionId, c]));
  const out = (): ConnectivityAssessment => ({ ok: problems.length === 0, problems, paths, overlapsTolerated, digest: connectivityDigest(declaration) });
  const paths: ConnectivityPath[] = [];
  const overlapsTolerated: { a: string; b: string }[] = [];

  if (declaration.format !== CONNECTIVITY_FORMAT) { add("format", "declaration", "Unknown connectivity declaration format."); return out(); }
  for (const s of strings(declaration)) {
    if (PEM_OR_KEY.test(s)) { add("inline_secret", "declaration", "The declaration carries what looks like key or certificate material; only vault references are allowed."); break; }
  }

  /* networks */
  const nets = new Map<string, { cidrs: ParsedCidr[]; egress: ParsedCidr[] }>();
  for (const network of declaration.networks) {
    if (!partitions.has(network.partitionId)) { add("unknown_partition", network.partitionId, "A network is declared for a partition that is not in the plan."); continue; }
    if (nets.has(network.partitionId)) { add("duplicate_id", network.partitionId, "A partition's network is declared twice."); continue; }
    const cidrs: ParsedCidr[] = [];
    const egress: ParsedCidr[] = [];
    for (const text of network.cidrs) { const c = parseCidr(text); if (!c) add("cidr_invalid", network.partitionId, `"${String(text).slice(0, 64)}" is not a valid CIDR with clean host bits.`); else cidrs.push(c); }
    for (const text of network.egress) {
      const c = parseCidr(text);
      if (!c) add("cidr_invalid", network.partitionId, `Egress "${String(text).slice(0, 64)}" is not a valid address or CIDR.`);
      else if (isWholeInternet(c)) add("allowlist_wildcard", network.partitionId, "A partition's declared egress may not be the whole internet.");
      else if (isPrivateRange(c)) add("allowlist_private", network.partitionId, "Declared egress must be public addresses; private ranges are not reachable across clouds without a VPN.");
      else egress.push(c);
    }
    nets.set(network.partitionId, { cidrs, egress });
  }

  /* overlap between any two partitions' private space: refused where a VPN would route it, noted where it cannot matter */
  const ids = [...nets.keys()].sort();
  const vpnPairs = new Set<string>();
  for (const link of declaration.vpn?.links ?? []) { vpnPairs.add(pairKey(link.consumerPartitionId, link.producerPartitionId)); vpnPairs.add(pairKey(link.producerPartitionId, link.consumerPartitionId)); }
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = nets.get(ids[i]!)!; const b = nets.get(ids[j]!)!;
      for (const x of a.cidrs) for (const y of b.cidrs) {
        if (!cidrsOverlap(x, y)) continue;
        if (vpnPairs.has(pairKey(ids[i]!, ids[j]!))) add("cidr_overlap", `${ids[i]}<->${ids[j]}`, `${x.text} overlaps ${y.text}; a VPN between these partitions would be ambiguous. Renumber one network.`);
        else overlapsTolerated.push({ a: `${ids[i]}:${x.text}`, b: `${ids[j]}:${y.text}` });
      }
    }
  }

  /* protected endpoints */
  const endpointIds = new Set<string>();
  const covered = new Map<string, ConnectivityPath>();
  for (const ep of declaration.endpoints) {
    const where = `endpoint ${ep.id}`;
    if (endpointIds.has(ep.id)) { add("duplicate_id", ep.id, "Two endpoints share an id."); continue; }
    endpointIds.add(ep.id);
    const producer = partitions.get(ep.producerPartitionId);
    const consumer = partitions.get(ep.consumerPartitionId);
    if (!producer || !consumer || ep.producerPartitionId === ep.consumerPartitionId) { add("unknown_partition", where, "The endpoint names a producer or consumer that is not a distinct partition of the plan."); continue; }
    if (!Number.isInteger(ep.port) || ep.port < 1 || ep.port > 65535) add("port_invalid", where, "The port is not 1 to 65535.");

    // DNS binding
    if (!HOSTNAME.test(ep.host) || isIpLiteral(ep.host)) add("dns_invalid", where, "The host must be a fully qualified DNS name (no IP literal, no wildcard, lowercase).");
    if (ep.dns.name !== ep.host) add("dns_invalid", where, "dns.name must equal the host the consumer dials.");
    if (!ep.dns.expectedTargets.length) add("dns_invalid", where, "The DNS name has no expected target to prove resolution against.");
    for (const target of ep.dns.expectedTargets) {
      const parsed = parseCidr(target);
      if (parsed && isPrivateRange(parsed)) add("dns_target_private", where, "A protected endpoint resolves to a public address; a private target means it is not reachable across clouds.");
      else if (!parsed && !HOSTNAME.test(target)) add("dns_invalid", where, `Expected target "${String(target).slice(0, 80)}" is neither an address nor a DNS name.`);
    }
    if (!Number.isInteger(ep.dns.ttlMaxSeconds) || ep.dns.ttlMaxSeconds < 1 || ep.dns.ttlMaxSeconds > 3600) add("dns_ttl", where, "dns.ttlMaxSeconds must be 1 to 3600 so a rebind cannot linger.");

    // TLS binding
    if (ep.tls.clientAuth !== "required") add("mtls_not_required", where, "Client certificates must be required (mutual TLS).");
    if (ep.tls.minVersion !== "1.2" && ep.tls.minVersion !== "1.3") add("tls_version", where, "The minimum TLS version must be 1.2 or 1.3.");
    if (!ep.tls.serverNames.includes(ep.host)) add("tls_name_mismatch", where, "The certificate names must include the host the consumer dials.");
    if (ep.tls.serverNames.some((n) => n.includes("*")) && ep.dataClass === "database") add("tls_wildcard", where, "A database endpoint may not rely on a wildcard certificate name.");
    if (!HEX.test(ep.tls.serverSpkiSha256)) add("tls_pin_missing", where, "The server certificate public-key pin (SHA-256) is missing or malformed.");
    if (!HEX.test(ep.tls.clientCaDigest)) add("client_ca_missing", where, "The client CA bundle digest is missing or malformed.");

    // identity + secret bindings
    if (!ep.identity.clientCertSubject.trim()) add("identity_mismatch", where, "The client certificate subject is empty.");
    if (ep.identity.consumerConnectionIdentityDigest !== consumer.authority.connectionIdentityDigest) add("identity_mismatch", where, "The client identity is not bound to the consumer partition's connection identity.");
    for (const [name, ref] of Object.entries(ep.secrets)) if (!VAULT_REF.test(ref)) add("secret_not_reference", where, `secrets.${name} must be a vault reference (vault:<workspace>/<environment>/<name>).`);

    // allowlist
    const egress = nets.get(ep.consumerPartitionId)?.egress ?? [];
    if (!nets.has(ep.consumerPartitionId) || !egress.length) add("no_egress_declared", where, "The consumer partition declares no public egress addresses, so there is nothing an allowlist could be bound to.");
    if (!ep.allowlist.length) add("allowlist_empty", where, "An empty allowlist would admit nobody, or be 'fixed' by widening it; declare the consumer's egress addresses.");
    for (const text of ep.allowlist) {
      const entry = parseCidr(text);
      if (!entry) { add("cidr_invalid", where, `Allowlist entry "${String(text).slice(0, 64)}" is not a valid CIDR.`); continue; }
      if (isWholeInternet(entry)) { add("allowlist_wildcard", where, "The allowlist may not admit the whole internet."); continue; }
      if (isPrivateRange(entry)) { add("allowlist_private", where, "A private range cannot identify a caller across clouds (overlapping address space makes it ambiguous)."); continue; }
      const maxBroad = entry.family === 4 ? 24 : 64;
      if (ep.dataClass === "database" ? entry.prefix !== (entry.family === 4 ? 32 : 128) : entry.prefix < maxBroad) {
        add(ep.dataClass === "database" ? "database_public" : "allowlist_too_broad", where, ep.dataClass === "database" ? "A database admits single hosts only." : `Allowlist ${entry.text} is broader than /${maxBroad}.`);
        continue;
      }
      if (egress.length && !egress.some((e) => cidrContains(e, entry))) add("allowlist_outside_egress", where, `Allowlist ${entry.text} is not inside the consumer partition's declared egress.`);
    }

    const path: ConnectivityPath = { consumerPartitionId: ep.consumerPartitionId, producerPartitionId: ep.producerPartitionId, via: "protected_endpoint", id: ep.id };
    paths.push(path);
    covered.set(pairKey(ep.consumerPartitionId, ep.producerPartitionId), path);
  }

  /* VPN module (opt-in) */
  const vpn = declaration.vpn;
  if (vpn) {
    if (vpn.optIn !== true && vpn.links.length) add("vpn_not_opted_in", "vpn", "VPN links are declared but optIn is not true; a VPN is never inferred.");
    for (const link of vpn.links) {
      const where = `vpn ${link.id}`;
      if (vpn.optIn !== true) break;
      if (endpointIds.has(link.id)) { add("duplicate_id", link.id, "A VPN link reuses an endpoint id."); continue; }
      if (!partitions.has(link.producerPartitionId) || !partitions.has(link.consumerPartitionId) || link.producerPartitionId === link.consumerPartitionId) { add("vpn_unknown_partition", where, "A VPN link names a partition that is not a distinct partition of the plan."); continue; }
      const p = parseCidr(link.producerCidr); const c = parseCidr(link.consumerCidr);
      if (!p || !c) { add("cidr_invalid", where, "A VPN link CIDR is invalid."); continue; }
      if (cidrsOverlap(p, c)) add("vpn_overlap", where, `${p.text} overlaps ${c.text}; address space must be disjoint for a VPN.`);
      const declared = (id: string, cidr: ParsedCidr) => (nets.get(id)?.cidrs ?? []).some((n) => cidrContains(n, cidr));
      if (!declared(link.producerPartitionId, p) || !declared(link.consumerPartitionId, c)) add("cidr_invalid", where, "A VPN link CIDR is not inside the partition's declared network.");
      if (!VAULT_REF.test(link.keyRef)) add("vpn_key_not_reference", where, "A VPN key must be a vault reference.");
      const path: ConnectivityPath = { consumerPartitionId: link.consumerPartitionId, producerPartitionId: link.producerPartitionId, via: "vpn", id: link.id };
      paths.push(path);
      if (!covered.has(pairKey(link.consumerPartitionId, link.producerPartitionId))) covered.set(pairKey(link.consumerPartitionId, link.producerPartitionId), path);
    }
  }

  /* coverage: every dependency the plan declares crosses a boundary and needs a path */
  for (const pair of requiredPairs(plan)) {
    if (!covered.has(pairKey(pair.consumer, pair.producer))) add("missing_connectivity", `${pair.consumer}->${pair.producer}`, "The plan makes this partition depend on another, but no protected endpoint or opted-in VPN covers the path.");
  }
  return out();
}

/** The first problem as a short, caller-data-free line (for refusals and approver text). */
export function describeProblems(problems: readonly ConnectivityProblem[]): string {
  return problems.slice(0, 3).map((p) => `${p.code} (${p.subject}): ${p.message}`).join(" | ");
}

/* ------------------------------ the default ------------------------------- */

export interface EdgeFacts {
  consumerPartitionId: string;
  producerPartitionId: string;
  host: string;
  port: number;
  dnsTargets: readonly string[];
  serverSpkiSha256: string;
  clientCaDigest: string;
  clientCertSubject: string;
  clientKeyRef: string;
  clientCertRef: string;
  serverNames?: readonly string[];
  minVersion?: "1.2" | "1.3";
}

/**
 * The protected-endpoint DEFAULT: for each cross-partition dependency, an mTLS endpoint whose allowlist is exactly the
 * consumer partition's declared egress as host routes (/32), bound to the consumer's connection identity. The caller
 * supplies only the facts only it knows (host name, pins, vault references, networks). VPN is never produced here.
 */
export function defaultProtectedEndpoints(plan: ConnectivityPlanView, networks: readonly PartitionNetwork[], facts: readonly EdgeFacts[]): ConnectivityDeclaration {
  const byId = new Map(plan.children.map((c) => [c.partitionId, c]));
  const net = new Map(networks.map((n) => [n.partitionId, n]));
  const endpoints: ProtectedEndpoint[] = [];
  for (const f of [...facts].sort((a, b) => (pairKey(a.consumerPartitionId, a.producerPartitionId) < pairKey(b.consumerPartitionId, b.producerPartitionId) ? -1 : 1))) {
    const producer = byId.get(f.producerPartitionId);
    const consumer = byId.get(f.consumerPartitionId);
    if (!producer || !consumer) continue;
    const dataClass = dataClassOf(producer);
    const egress = net.get(f.consumerPartitionId)?.egress ?? [];
    endpoints.push({
      id: `ep-${f.consumerPartitionId}-to-${f.producerPartitionId}`.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 100),
      producerPartitionId: f.producerPartitionId, consumerPartitionId: f.consumerPartitionId, dataClass, mode: "protected_endpoint", host: f.host, port: f.port,
      dns: { name: f.host, expectedTargets: f.dnsTargets, ttlMaxSeconds: 300 },
      tls: { minVersion: f.minVersion ?? "1.3", serverNames: f.serverNames ?? [f.host], serverSpkiSha256: f.serverSpkiSha256, clientAuth: "required", clientCaDigest: f.clientCaDigest },
      identity: { clientCertSubject: f.clientCertSubject, consumerConnectionIdentityDigest: consumer.authority.connectionIdentityDigest },
      secrets: { clientKeyRef: f.clientKeyRef, clientCertRef: f.clientCertRef },
      // Exactly the consumer's declared egress; a database refuses anything but host routes in `assessConnectivity`.
      allowlist: [...egress],
    });
  }
  return { format: CONNECTIVITY_FORMAT, networks: [...networks], endpoints };
}

/** Approver-facing lines: exactly what approving the declaration approves. */
export function connectivityDetails(declaration: ConnectivityDeclaration, declarationDigest: string): string[] {
  const lines = [`Cross-cloud connectivity (digest ${declarationDigest.slice(0, 16)}): ${declaration.endpoints.length} protected endpoint(s)${declaration.vpn?.optIn ? `, ${declaration.vpn.links.length} opted-in VPN link(s)` : ", no VPN"}.`];
  for (const ep of declaration.endpoints.slice(0, 16)) {
    lines.push(`Endpoint ${ep.id.slice(0, 80)}: ${ep.consumerPartitionId.slice(0, 60)} calls ${ep.host.slice(0, 120)}:${ep.port} (${ep.dataClass}) over mutual TLS ${ep.tls.minVersion}+, server key pinned, admitting only ${ep.allowlist.slice(0, 6).join(", ").slice(0, 200)}${ep.allowlist.length > 6 ? ", ..." : ""}.`);
  }
  for (const link of (declaration.vpn?.optIn ? declaration.vpn.links : []).slice(0, 16)) {
    lines.push(`VPN ${link.id.slice(0, 80)} (${link.kind}): ${link.consumerCidr} <-> ${link.producerCidr}, opted in.`);
  }
  return lines;
}
