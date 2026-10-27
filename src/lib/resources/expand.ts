/**
 * Manifest → portable resource graph (ADR-0003).
 *
 * `expandManifest(manifest, env)` compiles an application description into the
 * primitives every driver, policy, placement and incident path speaks. The
 * network, subnets, firewall rules, load balancer, DNS and certificates are
 * DERIVED from routes and bindings; the user never writes them. It is pure and
 * deterministic: every list is sorted before use and every object's keys are
 * sorted on the way out, so equal manifests (in any array order) produce
 * byte-identical graphs, digests included. `graph.notes` is the audit trail.
 *
 * Derivation rules (each one emits a `notes` line where it applies):
 *
 *  topology   One `network/main` in the environment's place, plus
 *             `subnet/public-<z>` and `subnet/private-<z>` per zone. Zones:
 *             `placement.zones`, else 2 for production and 1 otherwise, raised
 *             to 2 when `tolerateSingleFailure` or `availabilityTarget >= 99.9`,
 *             or AWS RDS / highly available Redis requires two private AZs.
 *             A network exists only if something needs one (services, cron
 *             jobs, postgres, redis, the load balancer): a bucket-and-queue
 *             manifest gets none. Kubernetes has no subnets: its network is a
 *             namespace and zones become topology spread. A node moved to
 *             another place by `nodePlacement` gets its own network there
 *             (`network/<provider>-<region>`).
 *  workloads  web/worker → `container_service/<n>`; cron → `scheduled_job/<n>`;
 *             static → `static_site/<n>`. A git source adds
 *             `build_pipeline/<n>` and (not for static) `container_registry/<n>`;
 *             an image source needs no build. Managed workloads also get
 *             `log_group/<n>` and `identity/<n>`.
 *  data       postgres/redis/object_store/queue → `<kind>/<n>`, placed in the
 *             private subnets (postgres, redis). `email` has no portable
 *             primitive: it is skipped with a note, and bindings to it derive
 *             nothing.
 *  routing    Routes bound to a managed web service → one
 *             `load_balancer/public`, plus `firewall/internet-to-lb*` and
 *             `firewall/lb-to-<svc>`. Every routed host → `tls_certificate/<h>`
 *             (when tls), `dns_record/<h>` (when managedDns) and a REFERENCED
 *             `dns_zone/<apex>`: Zenith never creates a customer's zone.
 *             Routes into referenced services, workers or nothing derive no
 *             infrastructure and say so.
 *  bindings   sql → firewall on 5432, cache → 6379, service→service http →
 *             the target's port; blob and queue bindings reach cloud APIs, so
 *             they become identity grants, not firewall rules. On AWS, Redis cache
 *             bindings also grant `connect` for IAM authentication. No firewall rule
 *             is derived into a non-managed target (Zenith never mutates it).
 *  secrets    An env var with a `secretRef` → a `secret/<key>-<digest>` node
 *             (managed for `vault:` refs, referenced otherwise) whose spec is
 *             the reference only, plus a `reads_secret` edge. An inline value
 *             is never copied next to a secretRef; a credential-looking key (or
 *             a URL with embedded credentials) holding an inline value is kept
 *             as authored and flagged. Credentials embedded in a git repo URL
 *             or a resource's externalRef are REMOVED from the graph, with a
 *             note: those are addresses, and an address is not a secret store.
 *  identity   `identity/<svc>` holds least-privilege grants as data: exact
 *             target addresses, explicit verbs, never a wildcard.
 *  ownership  referenced/external manifest nodes keep that ownership (and
 *             `externalRef`) and get no derived infrastructure.
 *  native     `native[]` entries become `provider_native/<id>` nodes with their
 *             registry-validated config.
 *  crossings  A relation between nodes in different providers/regions adds a
 *             `cross_cloud:` / `cross_region:` note.
 *
 * Native types come from `native-types.ts`; a kind with no mapping stays in the
 * graph as `unsupported:<provider>:<kind>` with a note.
 *
 * Limits, stated: expansion does not price, place or evaluate policy; it does
 * not know whether a driver exists for a node; DNS apex inference is a
 * heuristic without a public-suffix list; CIDR carving is arithmetic, not a
 * check against the customer's existing networks.
 */
import { SIZE_SPECS } from "@/lib/cost/pricing";
import type { AnyManifest } from "./manifest-v2";
import { findInlineSecretPaths, looksSecretKey, stripUrlCredentials } from "./secrets";
import { parseNativeConfig } from "./native-registry";
import { buildContext, placesNeedingNetwork, tuningFor, type Ctx, type ExpandEnv, type SvcInfo } from "./expand-context";
import { analyzeBindings, analyzeEnv, analyzeRoutes, grant, LB_ADDRESS } from "./expand-analyze";
import { contain, emitTopology, netDeps, networkOrigins, propagateNamespaces, type Topologies } from "./expand-topology";
import { emitFirewalls, emitRouting } from "./expand-routing";
import { cmp, finalizeGraph, manifestDigest, ManifestExpansionError, secretAddress, uniqSorted } from "./expand-support";
import type {
  ArtifactSpec,
  BuildPipelineSpec,
  ContainerRegistrySpec,
  ContainerServiceSpec,
  IdentitySpec,
  LogGroupSpec,
  ObjectStoreSpec,
  PostgresSpec,
  QueueSpec,
  RedisSpec,
  ScheduledJobSpec,
  SecretSpec,
  StaticSiteSpec,
} from "./specs";
import type { ProviderKey, ResourceGraph } from "./types";

export { ManifestExpansionError, manifestDigest } from "./expand-support";
export type { ExpandEnv } from "./expand-context";

/* ---------------------------------- data ---------------------------------- */

function emitData(ctx: Ctx, topo: Topologies): void {
  const b = ctx.b;
  const stateful: string[] = [];
  for (const info of ctx.ress.values()) {
    const r = info.r;
    if (!info.modelled) {
      b.note("email", `${info.address.replace("email/", "")} (email) has no portable primitive and is not in the graph; mail relays are not provisioned through the resource graph yet, and bindings to it derive nothing.`);
      continue;
    }
    const hasConfig = Object.keys(r.config).length > 0;
    for (const [k, v] of Object.entries(r.config))
      if (typeof v === "string" && looksSecretKey(k) && v.length > 0)
        b.note("secrets", `${info.address} config.${k} looks like a credential held inline in the manifest. It is kept as authored, not moved; graphs and plans should not carry it.`);
    const ref = r.externalRef === undefined ? undefined : stripUrlCredentials(r.externalRef);
    if (ref?.stripped) b.note("secrets", `${info.address} externalRef embeds credentials in its URL; they were removed from the graph. Keep credentials in a secretRef.`);
    if (!info.managed) {
      b.note("ownership", `${info.address} is ${r.ownership}; Zenith reads it and never mutates it.`);
      b.add({
        address: info.address,
        kind: r.kind as "postgres" | "redis" | "object_store" | "queue",
        place: info.place,
        ownership: r.ownership,
        externalRef: ref?.value,
        spec: { size: r.size, ...(r.kind === "postgres" || r.kind === "redis" ? { engine: r.kind } : {}), ...(hasConfig ? { config: { ...r.config } } : {}) },
        origin: [r.id],
      });
      continue;
    }

    const t = tuningFor(ctx.v2, info.place.provider);
    const common = {
      size: r.size,
      ...(hasConfig ? { config: { ...r.config } } : {}),
      deletionPolicy: ctx.policies.deletion,
      encryption: true as const,
    };
    const ha = t.highAvailability ?? (ctx.availabilityDemand !== undefined && ctx.zones >= 2);
    if ((r.kind === "postgres" || r.kind === "redis") && ha && t.highAvailability === undefined)
      b.note("availability", `${info.address} gets highAvailability because ${ctx.availabilityDemand}.`);
    stateful.push(info.address);

    if (r.kind === "postgres") {
      const instanceClass = t.instanceClass?.(r.name) ?? t.dbClass;
      const spec: PostgresSpec = {
        ...common,
        engine: "postgres",
        version: String(r.config.version ?? t.postgresVersion ?? "16"),
        highAvailability: ha,
        backup: ctx.policies.backup,
        credentials: "generated",
        subnetTier: "private",
        zones: ctx.zones,
        ...(instanceClass ? { instanceClass } : {}),
        ...(t.storageClass ? { storageClass: t.storageClass } : {}),
      };
      b.add({ address: info.address, kind: "postgres", place: info.place, spec: { ...spec }, origin: [r.id], dependsOn: netDeps(topo, info.place, "private") });
      contain(ctx, topo, info.place, info.address, "private");
    } else if (r.kind === "redis") {
      const spec: RedisSpec = {
        ...common,
        engine: "redis",
        highAvailability: ha,
        backup: ctx.policies.backup,
        subnetTier: "private",
        zones: ctx.zones,
        ...(t.instanceClass?.(r.name) ? { instanceClass: t.instanceClass(r.name) } : {}),
        ...(t.storageClass ? { storageClass: t.storageClass } : {}),
      };
      b.add({ address: info.address, kind: "redis", place: info.place, spec: { ...spec }, origin: [r.id], dependsOn: netDeps(topo, info.place, "private") });
      contain(ctx, topo, info.place, info.address, "private");
    } else if (r.kind === "object_store") {
      const spec: ObjectStoreSpec = { ...common, versioning: ctx.policies.backup !== "none", publicAccess: false };
      b.add({ address: info.address, kind: "object_store", place: info.place, spec: { ...spec }, origin: [r.id] });
    } else {
      const spec: QueueSpec = { ...common };
      b.add({ address: info.address, kind: "queue", place: info.place, spec: { ...spec }, origin: [r.id] });
    }
  }
  if (stateful.length)
    b.note("policies", `deletion=${ctx.policies.deletion} and backup=${ctx.policies.backup} apply to ${stateful.join(", ")}.`);
  const inNetwork = [...ctx.ress.values()].filter((i) => i.managed && i.modelled && (i.r.kind === "postgres" || i.r.kind === "redis")).map((i) => i.address);
  if (inNetwork.length) b.note("topology", `${inNetwork.join(", ")} ${inNetwork.length === 1 ? "is" : "are"} placed in the private subnets, unreachable from the internet.`);
}

/* -------------------------------- workloads ------------------------------- */

function artifactFor(info: SvcInfo): ArtifactSpec {
  const src = info.s.source;
  if (src.type === "image") return { type: "image", ref: src.image };
  if (src.type === "blueprint") return { type: "blueprint", blueprint: src.blueprint };
  return {
    type: "built",
    pipeline: `build_pipeline/${info.name}`,
    ...(info.kind === "static_site" ? {} : { registry: `container_registry/${info.name}` }),
  };
}

function emitWorkloads(ctx: Ctx, topo: Topologies): void {
  const b = ctx.b;
  for (const info of ctx.svcs.values()) {
    const s = info.s;
    if (!info.managed) {
      b.note("ownership", `${info.address} is ${s.ownership}; Zenith does not run it and derives nothing for it.`);
      b.add({
        address: info.address,
        kind: info.kind,
        place: info.place,
        ownership: s.ownership,
        spec: { workload: s.kind, size: s.size, ...(s.kind === "web" || s.kind === "worker" ? { replicas: s.replicas } : {}), ...(s.port ? { port: s.port } : {}), ...(s.healthPath ? { healthPath: s.healthPath } : {}) },
        origin: [s.id],
      });
      continue;
    }

    const artifact = artifactFor(info);
    if (artifact.type === "blueprint" && info.place.provider !== "sandbox")
      b.note("source", `${info.address} uses blueprint source "${artifact.blueprint}", which only the sandbox provider can run; ${info.place.provider} needs an image or git source.`);

    const tuning = tuningFor(ctx.v2, info.place.provider);
    const size = SIZE_SPECS[s.size] ?? SIZE_SPECS.small;
    const isStatic = info.kind === "static_site";

    // Build chain for git sources.
    let pipeline: string | undefined;
    if (s.source.type === "git") {
      pipeline = `build_pipeline/${info.name}`;
      const registry = isStatic ? undefined : `container_registry/${info.name}`;
      if (registry) {
        const rspec: ContainerRegistrySpec = { scanOnPush: true, immutableTags: false };
        b.add({ address: registry, kind: "container_registry", place: info.place, spec: { ...rspec }, origin: [s.id] });
      }
      const repo = stripUrlCredentials(s.source.repo);
      if (repo.stripped) b.note("secrets", `${s.name}'s git repo URL embeds credentials; they were removed from the graph. Keep repository access in a secretRef.`);
      const pspec: BuildPipelineSpec = {
        source: { repo: repo.value, ref: s.source.ref, ...(s.source.dockerfile ? { dockerfile: s.source.dockerfile } : {}), ...(s.source.contextDir ? { contextDir: s.source.contextDir } : {}), ...(s.source.contextDigest ? { contextDigest: s.source.contextDigest } : {}) },
        output: registry ? { registry } : { staticSite: info.address },
        location: "customer_account",
      };
      b.add({ address: pipeline, kind: "build_pipeline", place: info.place, spec: { ...pspec }, origin: [s.id], dependsOn: registry ? [registry] : [] });
      b.note("build", `${pipeline}${registry ? ` and ${registry}` : ""} derived because ${s.name} has a git source; builds run in the customer's account.`);
      if (registry) grant(info, registry, ["pull"], "image_pull", true);
    }

    if (isStatic) {
      const spec: StaticSiteSpec = { size: s.size, artifact };
      // A static site's build runs before it can publish, so the site waits for it.
      b.add({ address: info.address, kind: "static_site", place: info.place, spec: { ...spec }, origin: [s.id], dependsOn: pipeline ? [pipeline] : [] });
      continue;
    }

    if (ctx.availabilityDemand && s.kind !== "cron" && s.replicas < 2)
      b.note("availability", `${info.address} runs ${s.replicas} replica${s.replicas === 1 ? "" : "s"} but ${ctx.availabilityDemand}; replicas are not changed automatically, so one instance loss is an outage.`);
    if (s.kind === "web" && !s.port) b.note("workload", `${info.address} has no port; it cannot be a load balancer target or a firewall destination.`);
    if (s.kind === "cron" && !s.schedule) b.note("workload", `${info.address} has no schedule; the job has nothing to trigger it.`);

    const logGroup = `log_group/${info.name}`;
    const identity = `identity/${info.name}`;
    const lspec: LogGroupSpec = { workload: info.address, retentionDays: 30 };
    b.add({ address: logGroup, kind: "log_group", place: info.place, spec: { ...lspec }, origin: [s.id] });
    grant(info, logGroup, ["write"], "own_log_group", true);
    b.note("logs", `${logGroup} derived for ${info.address} (30 day retention).`);

    const common = {
      size: s.size,
      vcpu: size.vcpu,
      memoryMb: size.memoryMb,
      artifact,
      env: info.env,
      zones: ctx.zones,
      subnetTier: "private" as const,
      ...(tuning.platformVersion ? { platformVersion: tuning.platformVersion } : {}),
      ...(tuning.shape ? { shape: tuning.shape } : {}),
      ...(tuning.ingress ? { ingress: tuning.ingress } : {}),
    };
    const dependsOn = [...netDeps(topo, info.place, "private"), logGroup, identity, ...(pipeline ? [pipeline] : []), ...info.deps];
    if (s.kind === "cron") {
      const spec: ScheduledJobSpec = { ...common, ...(s.schedule ? { schedule: s.schedule } : {}), ...(tuning.cronPolicy ? { cronPolicy: tuning.cronPolicy } : {}) };
      b.add({ address: info.address, kind: "scheduled_job", place: info.place, spec: { ...spec }, origin: [s.id], dependsOn });
    } else {
      const spec: ContainerServiceSpec = {
        ...common,
        workload: s.kind === "web" ? "web" : "worker",
        replicas: s.replicas,
        ...(s.port ? { port: s.port } : {}),
        ...(s.healthPath ? { healthPath: s.healthPath } : {}),
      };
      b.add({ address: info.address, kind: "container_service", place: info.place, spec: { ...spec }, origin: [s.id], dependsOn });
    }
    contain(ctx, topo, info.place, info.address, "private");

    const grants = [...info.grants.entries()]
      .sort(([x], [y]) => cmp(x, y))
      .map(([target, g]) => ({ target, access: uniqSorted(g.access), via: uniqSorted(g.via) }));
    const ispec: IdentitySpec = { principal: "workload", workload: info.address, grants };
    b.add({ address: identity, kind: "identity", place: info.place, spec: { ...ispec }, origin: [s.id], dependsOn: [...info.grantDeps] });
    if (grants.some((g) => g.target.includes("*"))) throw new ManifestExpansionError(`Internal: ${identity} produced a wildcard grant.`);
    b.note("identity", `${identity} holds ${grants.length} least-privilege grant${grants.length === 1 ? "" : "s"} (${grants.map((g) => g.target).join(", ")}); each names one target and explicit verbs, never a wildcard.`);
  }
}

/* --------------------------------- secrets -------------------------------- */

function emitSecrets(ctx: Ctx): void {
  const readers = new Map<string, SvcInfo[]>();
  for (const info of ctx.svcs.values())
    for (const r of info.secretReads) readers.set(r.ref, [...(readers.get(r.ref) ?? []), info]);

  for (const ref of [...readers.keys()].sort(cmp)) {
    const users = [...new Map(readers.get(ref)!.map((u) => [u.address, u])).values()].sort((x, y) => cmp(x.address, y.address));
    const address = secretAddress(ref);
    const vault = ref.startsWith("vault:");
    const spec: SecretSpec = { secretRef: ref, store: vault ? "zenith_vault" : "provider_secret_manager", purpose: "environment" };
    ctx.b.add({
      address,
      kind: "secret",
      place: users[0].place,
      ownership: vault ? "managed" : "referenced",
      externalRef: vault ? undefined : ref,
      spec: { ...spec },
      origin: users.map((u) => u.id),
    });
    if (!vault)
      ctx.b.note("secrets", `${address} refers to ${ref}, which is not Zenith's secret store; it is treated as referenced and the provider must resolve it at deploy time.`);
    for (const u of users) for (const r of u.secretReads.filter((x) => x.ref === ref)) ctx.b.edge(u.address, address, "reads_secret", r.key);
  }
}


/** Functions carry their own scoped role/logs in the driver, with no container/network stand-in. */
function emitFunctions(ctx: Ctx): void {
  for (const f of [...(ctx.v2?.functions ?? [])].sort((a, b) => cmp(a.id, b.id))) {
    const address = `function/${f.name}`;
    if (ctx.addrByKey.has(f.id) || ctx.b.nodes.has(address)) throw new ManifestExpansionError(`Duplicate function ${f.id}.`);
    const dependsOn: string[] = [];
    for (const d of f.dependsOn ?? []) {
      const target = ctx.addrByKey.get(d);
      if (target) dependsOn.push(target);
      else ctx.b.note("function", `${address} depends on "${d}", which has no node in the graph; the dependency is dropped.`);
    }
    ctx.b.add({ address, kind: "function", place: { provider: f.provider, region: f.region }, nativeType: "aws:lambda_function",
      spec: { runtime: f.runtime, handler: f.handler, memoryMb: f.memoryMb, timeoutSec: f.timeoutSec, architecture: f.architecture, artifact: { ...f.source }, env: f.env }, origin: [f.id], dependsOn: uniqSorted(dependsOn) });
    ctx.addrByKey.set(f.id, address); ctx.addrByKey.set(f.name, address);
    for (const id of f.invokedBy) {
      const svc = ctx.svcs.get(id);
      const consumer = svc && ctx.b.nodes.get(svc.address);
      if (!consumer || !svc?.managed) throw new ManifestExpansionError(`Function ${f.id} must name a managed invoking service.`);
      consumer.dependsOn = uniqSorted([...consumer.dependsOn, address]);
      ctx.b.edge(consumer.address, address, "connects_to", "function.invoke: SigV4 IAM, exact published function ARN; credentials supplied separately");
    }
    ctx.b.note("function", `${address} is experimental Lambda: S3 version and source/package SHA-256 pinned, IAM-authenticated SDK invocation only; caller IAM credentials must be provisioned separately.`);
  }
}

/* --------------------------------- natives -------------------------------- */

function emitNatives(ctx: Ctx): void {
  const natives = [...(ctx.v2?.native ?? [])].sort((x, y) => cmp(x.id, y.id));
  for (const n of natives) {
    const address = `provider_native/${n.id}`;
    const override = ctx.v2?.nodePlacement?.[n.id];
    if (override && override.provider !== n.provider)
      throw new ManifestExpansionError(`nodePlacement moves native "${n.id}" to ${override.provider}, but its type ${n.type} belongs to ${n.provider}; a provider-native node cannot change provider.`);
    const region =
      override?.region ??
      n.region ??
      (n.provider === ctx.env.provider ? ctx.env.region : ctx.v2?.placement?.provider === n.provider ? ctx.v2.placement.regions[0] : undefined);
    if (!region) throw new ManifestExpansionError(`Native "${n.id}" is on ${n.provider}, which is not this environment's provider, and has no region. Set native[].region.`);

    const leaks = findInlineSecretPaths(n.config);
    if (leaks.length) throw new ManifestExpansionError(`native "${n.id}" config.${leaks[0]} looks like an inline secret value; use a { "secretRef": … } reference.`);
    const parsed = parseNativeConfig(n.provider, n.type, n.config);
    if (!parsed.ok) throw new ManifestExpansionError(`native "${n.id}": ${parsed.issues[0].message}`);

    const dependsOn: string[] = [];
    for (const d of n.dependsOn ?? []) {
      const target = ctx.v2?.native?.some((x) => x.id === d) ? `provider_native/${d}` : ctx.addrByKey.get(d);
      if (target) dependsOn.push(target);
      else ctx.b.note("native", `${address} depends on "${d}", which has no node in the graph; the dependency is dropped.`);
    }
    ctx.b.add({
      address,
      kind: "provider_native",
      nativeType: n.type,
      place: { provider: n.provider, region },
      spec: { type: n.type, config: parsed.config },
      origin: [n.id],
      dependsOn,
    });
    ctx.b.note("native", `${address} is a Level-3 provider-native node (${n.type}); it is kept out of the portable model and only ${n.provider}'s driver for that type can realize it.`);
  }
}

/* --------------------------------- crossings ------------------------------ */

const CROSSING_RELATIONS = new Set(["routes_to", "connects_to", "publishes_to", "consumes_from", "resolves_to", "reads_secret"]);

function noteCrossings(ctx: Ctx): void {
  for (const e of ctx.b.edgeList()) {
    if (!CROSSING_RELATIONS.has(e.relation)) continue;
    const from = ctx.b.nodes.get(e.from);
    const to = ctx.b.nodes.get(e.to);
    if (!from || !to) continue;
    const where = `${e.from} (${from.provider}/${from.region}) → ${e.to} (${to.provider}/${to.region}) via ${e.relation}${e.detail ? ` ${e.detail}` : ""}`;
    if (from.provider !== to.provider)
      ctx.b.note("cross_cloud", `${where}: traffic leaves ${from.provider}'s network; expect public-internet latency, egress charges and a separate trust boundary.`);
    else if (from.region !== to.region)
      ctx.b.note("cross_region", `${where}: expect added latency and inter-region data-transfer charges.`);
  }
}

function noteUnusedProviderConfig(ctx: Ctx): void {
  const pc = ctx.v2?.providerConfig;
  if (!pc) return;
  const used = new Set([...ctx.b.nodes.values()].map((n) => n.provider));
  const usedBy: Record<string, string[]> = { aws: ["aws", "localstack"], gcp: ["gcp"], azure: ["azure"], oci: ["oci"], kubernetes: ["kubernetes", "zenith"] };
  for (const key of Object.keys(pc).sort()) {
    if (!usedBy[key]) continue;
    if (!usedBy[key].some((p) => used.has(p as ProviderKey)))
      ctx.b.note("providerConfig", `providerConfig.${key} is set but no node in this graph is placed on ${key}; it has no effect.`);
  }
}

/* ----------------------------------- main --------------------------------- */

/**
 * Compile a manifest (V1 or V2) into the portable resource graph for one
 * environment. See the module comment for the derivation rules.
 *
 * Throws `ManifestExpansionError` only for input that cannot be addressed
 * unambiguously (duplicate ids/names, malformed names/hosts, a native node with
 * no resolvable region). Everything else that cannot be realized is kept and
 * explained in `notes`.
 */
export function expandManifest(manifest: AnyManifest, env: ExpandEnv): ResourceGraph {
  const ctx = buildContext(manifest, env);
  analyzeEnv(ctx);
  const uses = analyzeRoutes(ctx);
  const firewalls = analyzeBindings(ctx);

  const lbUses = uses.filter((u) => u.target.s.kind === "web");
  for (const u of lbUses) u.target.deps.add(LB_ADDRESS);

  const places = placesNeedingNetwork(ctx, lbUses.length > 0);
  const topo = emitTopology(ctx, places, networkOrigins(ctx, lbUses.map((u) => u.route.id)));

  emitData(ctx, topo);
  emitWorkloads(ctx, topo);
  emitSecrets(ctx);
  emitRouting(ctx, uses, topo, firewalls);
  emitFirewalls(ctx, firewalls);
  emitFunctions(ctx);
  emitNatives(ctx);
  propagateNamespaces(ctx, topo);
  noteCrossings(ctx);
  noteUnusedProviderConfig(ctx);

  return finalizeGraph(ctx.b, env.id, manifestDigest(manifest));
}
