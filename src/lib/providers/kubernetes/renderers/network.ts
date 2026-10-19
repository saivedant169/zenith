/**
 * network/kubernetes_namespace → Namespace + default-deny ingress NetworkPolicy
 * firewall                     → NetworkPolicy
 * load_balancer                → Ingress
 * tls_certificate              → cert-manager Certificate
 * dns_record                   → external-dns DNSEndpoint
 *
 * Fail-closed rules for NetworkPolicy:
 *   - Every namespace Zenith creates gets a default-deny INGRESS policy.
 *   - Egress is open by default, so DNS and dependencies keep working. A
 *     network node with `spec.isolation.egress: "default-deny"` also gets a
 *     default-deny EGRESS policy and a DNS allow; every firewall whose source is
 *     a workload in that namespace then renders the matching egress allow
 *     (source pods to target pods, same ports), so a declared dependency keeps
 *     working and nothing else leaves the pod. Anything the application reaches
 *     outside the cluster (a payment API, an object store) is blocked until a
 *     rule names it; Zenith has no rule kind for external egress yet.
 *   - A rule is rendered only with an explicit `from` peer list. An empty
 *     `from` in Kubernetes means "from anywhere", so a source Zenith cannot
 *     express inside the cluster (a node on another provider) yields a policy
 *     with NO ingress rules (allow nothing) and a note, never an open rule.
 *   - Public (CIDR) sources are rendered as an `ipBlock`; because many CNIs do
 *     not match in-cluster ingress-controller traffic against `ipBlock`, the
 *     ingress controller's namespace is added as a second peer when known
 *     (`ctx.ingressControllerNamespace`, default `ingress-nginx` for class
 *     `nginx`). NetworkPolicy enforcement depends on the cluster's CNI and is
 *     unverified here.
 *
 * Cluster prerequisites Zenith does NOT install: an ingress controller,
 * cert-manager with the named ClusterIssuers, external-dns with its CRD source.
 * Observing these kinds on a cluster without the CRD reports `missing` with a
 * reason rather than pretending.
 */
import type { DnsRecordSpec, FirewallSpec, LoadBalancerSpec, NetworkSpec, TlsCertificateSpec } from "@/lib/resources/specs";
import type { ResourceNode } from "@/lib/resources/types";
import { ANNOTATION, LABEL, type K8sObject, type K8sRenderContext, type RenderResult } from "../types";
import { dnsLabel, addressLeaf, labelValue, objectName, tlsSecretName } from "../naming";
import { isRecord, sortedUnique } from "../util";
import { ctxNamespace, metadata, namespaceOf, renderError, specOf } from "./common";

const WORKLOAD_KINDS = new Set(["container_service", "static_site", "postgres", "redis", "mysql"]);
/** Pods a NetworkPolicy can select: portable workloads and the native StatefulSet (same selector labels). */
const isPodWorkload = (n: Pick<ResourceNode, "kind" | "nativeType">): boolean => WORKLOAD_KINDS.has(n.kind) || (n.kind === "provider_native" && n.nativeType === "k8s:StatefulSet");
const K8S_PROVIDERS = new Set(["kubernetes", "zenith"]);

export const DEFAULT_DENY_NAME = "zenith-default-deny-ingress";
export const DEFAULT_DENY_EGRESS_NAME = "zenith-default-deny-egress";
export const ALLOW_DNS_EGRESS_NAME = "zenith-allow-dns-egress";
export const DEFAULT_ISSUERS = { dns01: "zenith-letsencrypt-dns01", http01: "zenith-letsencrypt-http01" } as const;

/* -------------------------------- namespace -------------------------------- */

export function renderNamespace(node: ResourceNode, ctx: K8sRenderContext): RenderResult {
  const spec = specOf(node) as unknown as Partial<NetworkSpec>;
  const name = ctxNamespace(node, ctx);
  const notes: string[] = [];
  if (typeof spec.cidr === "string") notes.push(`${node.address}: a CIDR was requested but Kubernetes namespaces have no address range; pod networking is the cluster's.`);
  const ns: K8sObject = {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: metadata(node, ctx, {
      name,
      labels: {
        // baseline is enforced; restricted is reported so images that would not pass it show up as warnings
        "pod-security.kubernetes.io/enforce": "baseline",
        "pod-security.kubernetes.io/warn": "restricted",
        "pod-security.kubernetes.io/audit": "restricted",
      },
    }),
  };
  // An operator-provisioned namespace may hold workloads Zenith does not own; its policies never select them.
  const pods = ctx.provisionedNamespaces?.includes(name) ? { matchLabels: { [LABEL.partOf]: labelValue(ctx.environmentId) } } : {};
  const deny: K8sObject = {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: metadata(node, ctx, { name: DEFAULT_DENY_NAME, namespace: name }),
    spec: { podSelector: pods, policyTypes: ["Ingress"] },
  };
  const objects = [ns, deny];
  const isolation = isRecord(spec.isolation) ? spec.isolation : undefined;
  if (isolation?.egress !== undefined && isolation.egress !== "open" && isolation.egress !== "default-deny") {
    throw renderError(`${node.address}: isolation.egress must be "open" or "default-deny".`);
  }
  if (isolation?.egress === "default-deny") {
    const dnsNs = ctx.dns?.namespace ?? "kube-system";
    const dnsPods = ctx.dns?.podLabels ?? { "k8s-app": "kube-dns" };
    objects.push(
      {
        apiVersion: "networking.k8s.io/v1",
        kind: "NetworkPolicy",
        metadata: metadata(node, ctx, { name: DEFAULT_DENY_EGRESS_NAME, namespace: name }),
        spec: { podSelector: pods, policyTypes: ["Egress"] },
      },
      {
        apiVersion: "networking.k8s.io/v1",
        kind: "NetworkPolicy",
        metadata: metadata(node, ctx, { name: ALLOW_DNS_EGRESS_NAME, namespace: name }),
        spec: {
          podSelector: pods,
          policyTypes: ["Egress"],
          egress: [
            {
              to: [{ namespaceSelector: nsSelector(dnsNs), podSelector: { matchLabels: dnsPods } }],
              ports: [
                { protocol: "UDP", port: 53 },
                { protocol: "TCP", port: 53 },
              ],
            },
          ],
        },
      }
    );
    notes.push(`${node.address}: egress is default-deny with DNS allowed to ${dnsNs}; pods reach only DNS and the targets of declared firewalls, so calls to anything outside the cluster are blocked until a rule names them. Needs a CNI that enforces NetworkPolicy.`);
  }
  return { objects, notes };
}

/* -------------------------------- firewall --------------------------------- */

interface Peer {
  podSelector?: Record<string, unknown>;
  namespaceSelector?: Record<string, unknown>;
  ipBlock?: { cidr: string };
}

const podMatch = (node: Pick<ResourceNode, "address">, ctx: K8sRenderContext) => ({
  matchLabels: { [LABEL.name]: objectName(node), [LABEL.partOf]: labelValue(ctx.environmentId) },
});

const nsSelector = (ns: string) => ({ matchLabels: { "kubernetes.io/metadata.name": ns } });

function isInCluster(n: ResourceNode): boolean {
  return K8S_PROVIDERS.has(n.provider);
}

interface Backend {
  node: Pick<ResourceNode, "address">;
  port?: number;
}

/** The workloads an Ingress fronts, with the container port each is reached on. */
function backendsOf(lb: ResourceNode, ctx: K8sRenderContext): Backend[] {
  const routes = (specOf(lb) as unknown as Partial<LoadBalancerSpec>).routes;
  if (!Array.isArray(routes)) return [];
  const out = new Map<string, Backend>();
  for (const r of routes) {
    if (!isRecord(r) || typeof r.target !== "string") continue;
    const target = ctx.node?.(r.target);
    const fromSpec = target && isRecord(target.spec) && typeof target.spec.port === "number" ? target.spec.port : undefined;
    const port = typeof r.port === "number" ? r.port : fromSpec;
    out.set(r.target, { node: target ?? { address: r.target }, port });
  }
  return [...out.values()];
}

export const firewallObjectName = (node: Pick<ResourceNode, "address">): string => dnsLabel(`fw-${addressLeaf(node.address)}`);
export const firewallEgressObjectName = (node: Pick<ResourceNode, "address">): string => dnsLabel(`fw-${addressLeaf(node.address)}-egress`);

/** Whether the network node that owns `namespace` asks for default-deny egress. */
function egressIsolated(ctx: K8sRenderContext, namespace: string): boolean {
  for (const n of ctx.nodes?.() ?? []) {
    if (n.kind !== "network" && n.kind !== "kubernetes_namespace") continue;
    if (!isRecord(n.spec) || !isRecord(n.spec.isolation) || n.spec.isolation.egress !== "default-deny") continue;
    if (namespaceOf(n, ctx.environmentId, ctx.node) === namespace) return true;
  }
  return false;
}

export function renderFirewall(node: ResourceNode, ctx: K8sRenderContext): RenderResult {
  const spec = specOf(node) as unknown as Partial<FirewallSpec>;
  const notes: string[] = [];
  if (typeof spec.target !== "string" || typeof spec.port !== "number" || !Number.isInteger(spec.port) || spec.port < 1 || spec.port > 65535) {
    throw renderError(`${node.address}: firewall needs a target address and an integer port.`);
  }
  const namespace = ctxNamespace(node, ctx);
  const target = ctx.node?.(spec.target);
  if (ctx.node && !target) throw renderError(`${node.address}: firewall target ${spec.target} is not in the graph.`);
  if (target && !isInCluster(target)) throw renderError(`${node.address}: firewall target ${spec.target} is not a Kubernetes node; a NetworkPolicy can only protect pods in this cluster.`);

  // who is protected, and on which ports
  let podSelector: Record<string, unknown>;
  let ports: number[];
  if (target?.kind === "load_balancer") {
    const backends = backendsOf(target, ctx);
    const names = sortedUnique(backends.map((b) => objectName(b.node)));
    ports = sortedUnique(backends.map((b) => b.port).filter((p): p is number => typeof p === "number"));
    if (names.length === 0 || ports.length === 0) throw renderError(`${node.address}: the load balancer ${spec.target} has no backends with known ports to protect.`);
    podSelector = { matchLabels: { [LABEL.partOf]: labelValue(ctx.environmentId) }, matchExpressions: [{ key: LABEL.name, operator: "In", values: names }] };
  } else if (!target || isPodWorkload(target)) {
    podSelector = podMatch({ address: spec.target }, ctx);
    ports = [spec.port];
  } else {
    throw renderError(`${node.address}: cannot protect a ${target.kind} with a NetworkPolicy.`);
  }

  // who may connect
  const peers: Peer[] = [];
  const source: unknown = spec.source;
  if (isRecord(source) && typeof source.cidr === "string") {
    if (!/^[0-9a-fA-F:.]+\/\d{1,3}$/.test(source.cidr)) throw renderError(`${node.address}: source cidr "${source.cidr.slice(0, 50)}" is not a CIDR.`);
    peers.push({ ipBlock: { cidr: source.cidr } });
    const controllerNs = ctx.ingressControllerNamespace ?? defaultControllerNamespace(ctx, target);
    if (spec.capability === "public_http" && controllerNs) peers.push({ namespaceSelector: nsSelector(controllerNs) });
    else if (spec.capability === "public_http") notes.push(`${node.address}: the ingress controller's namespace is unknown, so only the CIDR is allowed; set ingressControllerNamespace if the CNI does not match controller traffic against ipBlock.`);
  } else if (isRecord(source) && typeof source.address === "string") {
    const src = ctx.node?.(source.address);
    if (src && !isInCluster(src)) {
      notes.push(`${node.address}: source ${source.address} is on provider ${src.provider}, which a NetworkPolicy cannot select; no ingress rule was rendered (default-deny stays in force).`);
    } else if (ctx.node && !src) {
      notes.push(`${node.address}: source ${source.address} is not in the graph; no ingress rule was rendered.`);
    } else {
      const srcNs = src ? namespaceOf(src, ctx.environmentId, ctx.node) : namespace;
      const peer: Peer = { podSelector: podMatch({ address: source.address }, ctx) };
      if (srcNs !== namespace) peer.namespaceSelector = nsSelector(srcNs);
      peers.push(peer);
    }
  } else {
    throw renderError(`${node.address}: firewall source must name an address or a cidr.`);
  }
  if (spec.crossBoundary) notes.push(`${node.address}: crossBoundary=${spec.crossBoundary}; traffic between clouds/regions also depends on routing and firewalls outside this cluster.`);

  const objects: K8sObject[] = [];
  const np: K8sObject = {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: metadata(node, ctx, {
      name: firewallObjectName(node),
      namespace,
      annotations: typeof spec.description === "string" ? { "zenith.dev/description": spec.description.slice(0, 200) } : undefined,
    }),
    spec: {
      podSelector,
      policyTypes: ["Ingress"],
      ingress: peers.length === 0 ? [] : [{ from: peers, ports: ports.map((p) => ({ protocol: "TCP", port: p })) }],
    },
  };
  objects.push(np);

  // Egress allow for the source, only when its namespace is egress-isolated and both ends are pods here.
  if (isRecord(source) && typeof source.address === "string" && target && isPodWorkload(target)) {
    const src = ctx.node?.(source.address);
    if (src && isInCluster(src) && isPodWorkload(src)) {
      const srcNs = namespaceOf(src, ctx.environmentId, ctx.node);
      if (egressIsolated(ctx, srcNs)) {
        const toNs = namespaceOf(target, ctx.environmentId, ctx.node);
        const peer: Peer = { podSelector: podMatch(target, ctx) };
        if (toNs !== srcNs) peer.namespaceSelector = nsSelector(toNs);
        objects.push({
          apiVersion: "networking.k8s.io/v1",
          kind: "NetworkPolicy",
          metadata: metadata(node, ctx, { name: firewallEgressObjectName(node), namespace: srcNs }),
          spec: { podSelector: podMatch(src, ctx), policyTypes: ["Egress"], egress: [{ to: [peer], ports: ports.map((p) => ({ protocol: "TCP", port: p })) }] },
        });
      }
    }
  }
  return { objects, notes };
}

function defaultControllerNamespace(ctx: K8sRenderContext, target: ResourceNode | undefined): string | undefined {
  if (target?.kind === "load_balancer") {
    const cls = (specOf(target) as unknown as Partial<LoadBalancerSpec>).ingressClass;
    return cls === "nginx" ? "ingress-nginx" : undefined;
  }
  const lb = ctx.nodes?.().find((n) => n.kind === "load_balancer" && isInCluster(n));
  return lb && (specOf(lb) as unknown as Partial<LoadBalancerSpec>).ingressClass === "nginx" ? "ingress-nginx" : undefined;
}

/* ----------------------------- load balancer -------------------------------- */

function certSecretFor(host: string, ctx: K8sRenderContext): string {
  const certs = (ctx.nodes?.() ?? []).filter((n) => n.kind === "tls_certificate" && isInCluster(n) && isRecord(n.spec) && typeof n.spec.domain === "string");
  for (const c of certs) {
    const domain = (c.spec as unknown as TlsCertificateSpec).domain;
    const wildcard = domain.startsWith("*.") && host.split(".").slice(1).join(".") === domain.slice(2);
    if (domain === host || wildcard) return tlsSecretName(domain);
  }
  return tlsSecretName(host);
}

export function renderLoadBalancer(node: ResourceNode, ctx: K8sRenderContext): RenderResult {
  const spec = specOf(node) as unknown as Partial<LoadBalancerSpec>;
  const namespace = ctxNamespace(node, ctx);
  const notes: string[] = [];
  if (!Array.isArray(spec.routes) || spec.routes.length === 0) throw renderError(`${node.address}: a load balancer needs at least one route.`);

  const byHost = new Map<string, { path: string; service: string; port: number }[]>();
  const tlsHosts = new Set<string>();
  for (const r of spec.routes) {
    if (!isRecord(r) || typeof r.host !== "string" || r.host === "" || typeof r.target !== "string") throw renderError(`${node.address}: every route needs a host and a target.`);
    if (!/^(\*\.)?[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/.test(r.host) || r.host.length > 253) throw renderError(`${node.address}: route host "${r.host.slice(0, 60)}" is not a valid hostname.`);
    const path = typeof r.pathPrefix === "string" && r.pathPrefix !== "" ? r.pathPrefix : "/";
    if (!path.startsWith("/") || path.length > 256) throw renderError(`${node.address}: route path "${path.slice(0, 40)}" must start with "/".`);
    const target = ctx.node?.(r.target);
    if (target) {
      if (!isInCluster(target)) throw renderError(`${node.address}: route target ${r.target} is on ${target.provider}; an Ingress can only route to Services in this cluster.`);
      const tns = namespaceOf(target, ctx.environmentId, ctx.node);
      if (tns !== namespace) throw renderError(`${node.address}: route target ${r.target} lives in namespace ${tns}, but an Ingress can only reference Services in its own namespace (${namespace}).`);
    }
    const port = typeof r.port === "number" ? r.port : target && isRecord(target.spec) && typeof target.spec.port === "number" ? target.spec.port : undefined;
    if (port === undefined || !Number.isInteger(port) || port < 1 || port > 65535) throw renderError(`${node.address}: route to ${r.target} has no known port.`);
    const list = byHost.get(r.host) ?? [];
    list.push({ path, service: objectName({ address: r.target }), port });
    byHost.set(r.host, list);
    if (r.tls === true) tlsHosts.add(r.host);
  }

  const rules = [...byHost.keys()].sort().map((host) => ({
    host,
    http: {
      paths: (byHost.get(host) ?? [])
        .slice()
        .sort((a, b) => b.path.length - a.path.length || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
        .map((p) => ({ path: p.path, pathType: "Prefix", backend: { service: { name: p.service, port: { number: p.port } } } })),
    },
  }));
  const tls = [...tlsHosts].sort().map((host) => ({ hosts: [host], secretName: certSecretFor(host, ctx) }));

  const cls = spec.ingressClass;
  const redirect = Array.isArray(spec.listeners) && spec.listeners.some((l) => isRecord(l) && l.protocol === "http" && l.redirectToHttps === true);
  const annotations: Record<string, string> = {};
  if (cls === "nginx") annotations["nginx.ingress.kubernetes.io/ssl-redirect"] = redirect ? "true" : "false";
  else if (redirect) notes.push(`${node.address}: redirectToHttps is only rendered for ingress class "nginx"; other controllers need their own annotation.`);
  if (cls === undefined) notes.push(`${node.address}: no ingress class in the spec, so the cluster's default IngressClass is used.`);
  if (!ctx.nodes) notes.push(`${node.address}: rendered without graph access; TLS secret names assume each certificate's domain equals the route host.`);

  const ing: K8sObject = {
    apiVersion: "networking.k8s.io/v1",
    kind: "Ingress",
    metadata: metadata(node, ctx, { name: objectName(node), namespace, annotations }),
    spec: {
      ...(cls !== undefined ? { ingressClassName: cls } : {}),
      ...(tls.length > 0 ? { tls } : {}),
      rules,
    },
  };
  return { objects: [ing], notes };
}

/* ------------------------------- certificate -------------------------------- */

export function certificateIssuer(node: ResourceNode, ctx: K8sRenderContext): string {
  const spec = specOf(node) as unknown as Partial<TlsCertificateSpec>;
  return spec.validation === "dns_manual"
    ? (ctx.clusterIssuers?.http01 ?? DEFAULT_ISSUERS.http01)
    : (ctx.clusterIssuers?.dns01 ?? DEFAULT_ISSUERS.dns01);
}

export function renderCertificate(node: ResourceNode, ctx: K8sRenderContext): RenderResult {
  const spec = specOf(node) as unknown as Partial<TlsCertificateSpec>;
  if (typeof spec.domain !== "string" || !/^(\*\.)?[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/.test(spec.domain)) throw renderError(`${node.address}: spec.domain is not a valid domain name.`);
  const notes: string[] = [];
  if (spec.validation === "dns_manual") {
    notes.push(`${node.address}: dns_manual validation is not a cert-manager flow; the certificate uses the HTTP-01 ClusterIssuer (${certificateIssuer(node, ctx)}), so the domain must already route to this cluster's ingress.`);
  }
  notes.push(`${node.address}: cert-manager and the ClusterIssuer "${certificateIssuer(node, ctx)}" are cluster prerequisites; Zenith does not install them.`);
  const cert: K8sObject = {
    apiVersion: "cert-manager.io/v1",
    kind: "Certificate",
    metadata: metadata(node, ctx, { name: certificateObjectName(spec.domain), namespace: ctxNamespace(node, ctx) }),
    spec: {
      secretName: tlsSecretName(spec.domain),
      dnsNames: [spec.domain],
      issuerRef: { name: certificateIssuer(node, ctx), kind: "ClusterIssuer", group: "cert-manager.io" },
      privateKey: { algorithm: "ECDSA", size: 256, rotationPolicy: "Always" },
    },
  };
  return { objects: [cert], notes };
}

export const certificateObjectName = (domain: string): string => dnsLabel(`cert-${domain}`);

/* ---------------------------------- DNS ------------------------------------ */

const IPV4 = /^(\d{1,3})(\.\d{1,3}){3}$/;
const HOSTNAME = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/i;

export function dnsRecordType(target: string): "A" | "AAAA" | "CNAME" {
  if (IPV4.test(target)) return "A";
  if (target.includes(":")) return "AAAA";
  return "CNAME";
}

export function renderDnsRecord(node: ResourceNode, ctx: K8sRenderContext): RenderResult {
  const spec = specOf(node) as unknown as Partial<DnsRecordSpec>;
  if (typeof spec.name !== "string" || !HOSTNAME.test(spec.name) || typeof spec.target !== "string") throw renderError(`${node.address}: DNS record needs a valid name and a target address.`);
  const target = ctx.resolveDnsTarget?.(spec.target);
  if (!target) {
    throw renderError(
      `${node.address}: the address of ${spec.target} is not known yet. Apply the load balancer first, read its observed address, and pass it as resolveDnsTarget.`
    );
  }
  if (!IPV4.test(target) && !target.includes(":") && !HOSTNAME.test(target)) throw renderError(`${node.address}: resolved DNS target is not a hostname or IP address.`);
  const dns: K8sObject = {
    apiVersion: "externaldns.k8s.io/v1alpha1",
    kind: "DNSEndpoint",
    metadata: metadata(node, ctx, {
      name: dnsObjectName(spec.name),
      namespace: ctxNamespace(node, ctx),
      annotations: typeof spec.zone === "string" ? { [ANNOTATION.dnsZone]: spec.zone } : undefined,
    }),
    spec: { endpoints: [{ dnsName: spec.name, recordType: dnsRecordType(target), recordTTL: 300, targets: [target] }] },
  };
  return { objects: [dns], notes: [`${node.address}: external-dns with the CRD source is a cluster prerequisite; the zone "${spec.zone ?? "?"}" must be in its domain filter.`] };
}

export const dnsObjectName = (recordName: string): string => dnsLabel(`dns-${recordName}`);
