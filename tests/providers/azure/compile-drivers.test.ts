import { describe, expect, it } from "vitest";
import type { TofuFragment } from "@/lib/drivers/types";
import type { ResourceNode } from "@/lib/resources/types";
import { AzureCompileError } from "@/lib/providers/azure/compile-util";
import { AZURE_DRIVERS } from "@/lib/providers/azure/drivers";
import { acaSize, isPrivateCidr, landingZoneCidrs, parseCidr } from "@/lib/providers/azure/platform";
import { BOOTSTRAP_IMAGE, memoryToMb } from "@/lib/providers/azure/drivers/compute/workload";
import { relativeName } from "@/lib/providers/azure/drivers/dns/dns-record";
import { kvSecretName } from "@/lib/providers/azure/drivers/identity/key-vault-secret";
import { assertCron } from "@/lib/providers/azure/drivers/compute/container-app-job";
import { compileAll, compileContext, mkNode, sampleGraph } from "./_helpers";

const driverFor = (n: { nativeType: string }) => AZURE_DRIVERS.find((d) => d.nativeType === n.nativeType)!;
type Body = Record<string, unknown>;

function compile(address: string, mutate: (nodes: ResourceNode[]) => void = () => undefined): TofuFragment {
  const nodes = sampleGraph();
  mutate(nodes);
  const node = nodes.find((n) => n.address === address)!;
  return driverFor(node).compile!(node, compileContext(nodes));
}
const body = (f: TofuFragment, type: string): Body => Object.values(f.resource![type])[0];
const setSpec = (address: string, patch: Body) => (nodes: ResourceNode[]) => Object.assign(nodes.find((n) => n.address === address)!.spec, patch);

describe("landing zone (network)", () => {
  it("declares the resource group, VNet, platform subnets with delegations, NSGs, private DNS, logs and the Container Apps environment", () => {
    const f = compile("network/main");
    expect(Object.keys(f.resource!).sort()).toEqual([
      "azurerm_container_app_environment", "azurerm_log_analytics_workspace", "azurerm_network_security_group", "azurerm_network_security_rule", "azurerm_private_dns_zone",
      "azurerm_private_dns_zone_virtual_network_link", "azurerm_resource_group", "azurerm_subnet", "azurerm_subnet_network_security_group_association", "azurerm_virtual_network",
    ]);
    expect(body(f, "azurerm_virtual_network").address_space).toEqual(["10.0.0.0/16"]);
    const subnets = f.resource!.azurerm_subnet;
    expect(subnets.network_main_snet_aca.delegation).toEqual([{ name: "aca", service_delegation: { name: "Microsoft.App/environments", actions: ["Microsoft.Network/virtualNetworks/subnets/join/action"] } }]);
    expect(subnets.network_main_snet_pg.delegation).toEqual([{ name: "pg", service_delegation: { name: "Microsoft.DBforPostgreSQL/flexibleServers", actions: ["Microsoft.Network/virtualNetworks/subnets/join/action"] } }]);
    expect(subnets.network_main_snet_pe.private_endpoint_network_policies).toBe("Enabled");
    expect(subnets.network_main_snet_aca.address_prefixes).toEqual(["10.0.254.0/23"]);
    expect(subnets.network_main_snet_pg.address_prefixes).toEqual(["10.0.253.192/26"]);
    expect(subnets.network_main_snet_pe.address_prefixes).toEqual(["10.0.253.128/26"]);
    const cae = body(f, "azurerm_container_app_environment");
    expect(cae).toMatchObject({ internal_load_balancer_enabled: false, zone_redundancy_enabled: true, workload_profile: [{ name: "Consumption", workload_profile_type: "Consumption" }], logs_destination: "log-analytics" });
    expect(cae.infrastructure_subnet_id).toBe("${azurerm_subnet.network_main_snet_aca.id}");
    const zones = Object.values(f.resource!.azurerm_private_dns_zone).map((z) => z.name);
    expect(zones).toEqual(expect.arrayContaining(["privatelink.redis.cache.windows.net", "privatelink.blob.core.windows.net"]));
    expect(zones.find((z) => String(z).endsWith(".private.postgres.database.azure.com"))).toBeDefined();
  });

  it("one zone means a non-zone-redundant environment; a missing CIDR is an error", () => {
    expect(body(compile("network/main", setSpec("network/main", { zones: 1 })), "azurerm_container_app_environment").zone_redundancy_enabled).toBe(false);
    expect(() => compile("network/main", (nodes) => delete nodes.find((n) => n.address === "network/main")!.spec.cidr)).toThrow(/cidr/);
    expect(() => compile("network/main", setSpec("network/main", { cidr: "10.0.0.0/24" }))).toThrow(/between \/8 and \/20/);
  });

  it("platform subnets never overlap the portable subnets expansion carves, for every /8–/20 network", () => {
    // expansion: the index-th /(N+8) slice of a /N network; public 0..2, private 10..12
    const slice = (cidr: string, index: number) => {
      const { base, bits } = parseCidr(cidr);
      const size = 2 ** (32 - (bits + 8));
      return [base + index * size, base + (index + 1) * size - 1] as const;
    };
    const range = (cidr: string) => {
      const { base, bits } = parseCidr(cidr);
      return [base, base + 2 ** (32 - bits) - 1] as const;
    };
    for (const cidr of ["10.0.0.0/16", "10.7.0.0/16", "172.16.0.0/16", "10.0.0.0/17", "10.0.0.0/18", "10.0.0.0/19", "10.0.0.0/20", "10.32.0.0/12", "10.0.0.0/8"]) {
      const lz = landingZoneCidrs(cidr);
      const vnet = range(cidr);
      const platform = [lz.aca, lz.pg, lz.pe].map(range);
      for (const p of platform) {
        expect(p[0]).toBeGreaterThanOrEqual(vnet[0]);
        expect(p[1]).toBeLessThanOrEqual(vnet[1]);
      }
      for (let i = 0; i < platform.length; i++) for (let j = i + 1; j < platform.length; j++) expect(platform[i][1] < platform[j][0] || platform[j][1] < platform[i][0]).toBe(true);
      for (const index of [0, 1, 2, 10, 11, 12]) {
        const [a, b] = slice(cidr, index);
        for (const p of platform) expect(b < p[0] || p[1] < a, `${cidr} index ${index}`).toBe(true);
      }
    }
  });

  it("isPrivateCidr recognizes RFC1918, shared and public ranges", () => {
    for (const c of ["10.0.0.0/8", "10.1.2.0/24", "172.16.0.0/12", "172.31.255.0/24", "192.168.1.0/24", "100.64.0.0/10"]) expect(isPrivateCidr(c), c).toBe(true);
    for (const c of ["0.0.0.0/0", "8.8.8.0/24", "172.32.0.0/16", "11.0.0.0/8", "10.0.0.0/7", "192.169.0.0/16"]) expect(isPrivateCidr(c), c).toBe(false);
  });

  it("portable subnets become plain subnets with their own NSG in the VNet", () => {
    const f = compile("subnet/private-a");
    expect(body(f, "azurerm_subnet")).toMatchObject({ name: "private-a", address_prefixes: ["10.0.10.0/24"] });
    expect(body(f, "azurerm_subnet")).not.toHaveProperty("delegation");
    expect(Object.keys(f.resource!).sort()).toEqual(["azurerm_network_security_group", "azurerm_subnet", "azurerm_subnet_network_security_group_association"]);
  });
});

describe("container app sizing, replicas and ingress", () => {
  it("ignores the replica range once an autoscaler owns it (field-ownership registry), and not otherwise", () => {
    const plain = body(compile("container_service/web"), "azurerm_container_app");
    expect(JSON.stringify(plain.lifecycle ?? {})).not.toContain("min_replicas");
    const scaled = body(compile("container_service/web", setSpec("container_service/web", { autoscaling: { min: 1, max: 4 } })), "azurerm_container_app");
    expect((scaled.lifecycle as { ignore_changes: string[] }).ignore_changes).toEqual(expect.arrayContaining(["template[0].min_replicas", "template[0].max_replicas"]));
  });

  it("bootstraps built jobs by digest and keeps literal job images under OpenTofu ownership", () => {
    const literal = body(compile("scheduled_job/report"), "azurerm_container_app_job");
    expect(literal).not.toHaveProperty("lifecycle");
    const built = body(compile("scheduled_job/report", (nodes) => {
      const job = nodes.find((n) => n.address === "scheduled_job/report")!;
      job.spec.artifact = { type: "built", pipeline: "build_pipeline/web", registry: "container_registry/web" };
      job.dependsOn.push("identity/web", "container_registry/web", "build_pipeline/web");
      nodes.find((n) => n.address === "identity/web")!.spec.workload = job.address;
    }), "azurerm_container_app_job");
    expect(((built.template as Body).container as Body[])[0].image).toBe(BOOTSTRAP_IMAGE);
    expect(BOOTSTRAP_IMAGE).toMatch(/@sha256:[a-f0-9]{64}$/);
    expect(built.lifecycle).toEqual({ ignore_changes: ["template[0].container[0].image", "template[0].container[0].args"] });
    expect(built.registry).toEqual([{ server: "${local.container_registry_web__login_server}", identity: "${local.identity_web__id}" }]);
  });

  it("rounds the portable size UP to a valid Consumption pair (memory = 2 Gi per vCPU)", () => {
    expect(acaSize(0.25, 256)).toMatchObject({ cpu: 0.25, memoryGi: 0.5, memoryMb: 512, adjusted: true });
    expect(acaSize(0.5, 512)).toMatchObject({ cpu: 0.5, memoryGi: 1 });
    expect(acaSize(1, 1024)).toMatchObject({ cpu: 1, memoryGi: 2 });
    expect(acaSize(2, 4096)).toMatchObject({ cpu: 2, memoryGi: 4, adjusted: false });
    // memory drives the CPU up when the ratio demands it
    expect(acaSize(0.25, 3072)).toMatchObject({ cpu: 1.5, memoryGi: 3 });
    expect(acaSize(0.3, 100)).toMatchObject({ cpu: 0.5, memoryGi: 1 });
    expect(() => acaSize(4.5, 1024)).toThrow(/4 vCPU/);
    expect(() => acaSize(0, 100)).toThrow();
    expect(memoryToMb("1Gi")).toBe(1024);
    expect(memoryToMb("0.5Gi")).toBe(512);
    expect(memoryToMb("512Mi")).toBe(512);
    expect(memoryToMb("lots")).toBeUndefined();
  });

  it("compiles the size, fixed replica counts, probes and the image of a built artifact", () => {
    const app = body(compile("container_service/web"), "azurerm_container_app");
    const tpl = app.template as Body;
    const c = (tpl.container as Body[])[0];
    expect(c).toMatchObject({ cpu: 0.5, memory: "1Gi", name: "web" });
    expect(tpl).toMatchObject({ min_replicas: 2, max_replicas: 2 });
    expect(c.image).toBe(BOOTSTRAP_IMAGE);
    expect(app.lifecycle).toEqual({ ignore_changes: ["template[0].container[0].image", "template[0].container[0].args"] });
    expect(c.args).toEqual(["-listen", ":8080", "-text", "Zenith awaiting built release"]);
    expect(c.liveness_probe).toEqual([{ transport: "HTTP", port: 8080, path: "/healthz", interval_seconds: 10, failure_count_threshold: 3, initial_delay: 5, timeout: 3 }]);
    expect(app).toMatchObject({ revision_mode: "Single", workload_profile_name: "Consumption" });
  });

  it("an image artifact is used verbatim, an ACR image pulls with the identity, a blueprint is refused", () => {
    const plain = body(compile("container_service/web", setSpec("container_service/web", { artifact: { type: "image", ref: "ghcr.io/acme/web:1.2.3" } })), "azurerm_container_app");
    expect(((plain.template as Body).container as Body[])[0].image).toBe("ghcr.io/acme/web:1.2.3");
    expect(plain).not.toHaveProperty("registry");
    expect(plain).not.toHaveProperty("lifecycle");
    const acr = body(compile("container_service/web", setSpec("container_service/web", { artifact: { type: "image", ref: "acmereg.azurecr.io/web:1" } })), "azurerm_container_app");
    expect(acr.registry).toEqual([{ server: "acmereg.azurecr.io", identity: "${local.identity_web__id}" }]);
    expect(() => compile("container_service/web", setSpec("container_service/web", { artifact: { type: "blueprint", blueprint: "hello" } }))).toThrow(/sandbox/);
  });

  it("a worker without a port has no ingress; a web service not targeted by a route is internal", () => {
    const worker = body(compile("container_service/web", (n) => Object.assign(n.find((x) => x.address === "container_service/web")!.spec, { workload: "worker", port: undefined, healthPath: undefined })), "azurerm_container_app");
    expect(worker).not.toHaveProperty("ingress");
    const f = compile("container_service/web", (nodes) => {
      const lb = nodes.find((n) => n.address === "load_balancer/public")!;
      lb.spec.routes = [];
    });
    expect((body(f, "azurerm_container_app").ingress as Body).external_enabled).toBe(false);
  });

  it("secret env entries need an identity and a dependency on the secret node", () => {
    expect(() =>
      compile("container_service/web", (nodes) => {
        const web = nodes.find((n) => n.address === "container_service/web")!;
        web.dependsOn = web.dependsOn.filter((d) => d !== "identity/web");
        web.spec.artifact = { type: "image", ref: "nginx:1" };
      })
    ).toThrow(/identity/);
    expect(() =>
      compile("container_service/web", (nodes) => {
        const web = nodes.find((n) => n.address === "container_service/web")!;
        web.dependsOn = web.dependsOn.filter((d) => !d.startsWith("secret/"));
      })
    ).toThrow(/not in the graph as a dependency/);
    expect(() =>
      compile("container_service/web", (nodes) => {
        const s = nodes.find((n) => n.address === "secret/session-key-1a2b3c4d")!;
        s.ownership = "referenced";
        s.externalRef = "arn:aws:secretsmanager:us-east-1:123456789012:secret:x";
      })
    ).toThrow(/Key Vault/);
  });

  it("a job compiles a cron trigger, or a manual trigger when it has no schedule", () => {
    const job = body(compile("scheduled_job/report"), "azurerm_container_app_job");
    expect(job).toMatchObject({ schedule_trigger_config: { cron_expression: "0 2 * * *", parallelism: 1, replica_completion_count: 1 }, replica_timeout_in_seconds: 1800 });
    expect(((job.template as Body).container as Body[])[0]).toMatchObject({ cpu: 0.25, memory: "0.5Gi", image: "ghcr.io/acme/report:1.4.2" });
    const manual = body(compile("scheduled_job/report", setSpec("scheduled_job/report", { schedule: undefined })), "azurerm_container_app_job");
    expect(manual).toHaveProperty("manual_trigger_config");
    expect(manual).not.toHaveProperty("schedule_trigger_config");
    expect(() => assertCron("0 2 * *", "x")).toThrow();
    expect(() => assertCron("0 2 * * * ; rm -rf /", "x")).toThrow();
    expect(assertCron("  */5  *  *  *  MON-FRI ", "x")).toBe("*/5 * * * MON-FRI");
  });
});

describe("PostgreSQL mapping", () => {
  it("maps size, version, HA zones, backups and GRS", () => {
    const f = compile("postgres/db");
    expect(body(f, "azurerm_postgresql_flexible_server")).toMatchObject({ version: "16", sku_name: "GP_Standard_D2ds_v5", storage_mb: 65536, backup_retention_days: 14, geo_redundant_backup_enabled: false, zone: "1", high_availability: { mode: "ZoneRedundant", standby_availability_zone: "2" } });
    const hourly = body(compile("postgres/db", setSpec("postgres/db", { backup: "hourly" })), "azurerm_postgresql_flexible_server");
    expect(hourly).toMatchObject({ backup_retention_days: 35, geo_redundant_backup_enabled: true });
    const none = body(compile("postgres/db", setSpec("postgres/db", { backup: "none" })), "azurerm_postgresql_flexible_server");
    expect(none.backup_retention_days).toBe(7);
    const geo = body(compile("postgres/db", (n) => Object.assign(n.find((x) => x.address === "postgres/db")!.spec, { config: { geoRedundantBackup: true } })), "azurerm_postgresql_flexible_server");
    expect(geo.geo_redundant_backup_enabled).toBe(true);
  });

  it("no HA means no zone pinning; HA on a burstable size is refused instead of silently repriced", () => {
    const f = compile("postgres/db", setSpec("postgres/db", { highAvailability: false }));
    expect(body(f, "azurerm_postgresql_flexible_server")).not.toHaveProperty("high_availability");
    expect(body(f, "azurerm_postgresql_flexible_server")).not.toHaveProperty("zone");
    expect(() => compile("postgres/db", setSpec("postgres/db", { size: "small", highAvailability: true }))).toThrow(/burstable/);
    expect(body(compile("postgres/db", setSpec("postgres/db", { size: "small", highAvailability: true, instanceClass: "GP_Standard_D2ds_v5" })), "azurerm_postgresql_flexible_server").sku_name).toBe("GP_Standard_D2ds_v5");
    expect(() => compile("postgres/db", setSpec("postgres/db", { version: "9.6" }))).toThrow(/13–17/);
  });

  it("registers the deploy principal as the Entra administrator (no password exists)", () => {
    const aad = body(compile("postgres/db"), "azurerm_postgresql_flexible_server_active_directory_administrator");
    expect(aad).toMatchObject({ principal_type: "ServicePrincipal", object_id: "${local.network_main__object_id}" });
  });
});

describe("other data services", () => {
  it("redis: Basic or Standard by HA, capacity by size", () => {
    expect(body(compile("redis/cache"), "azurerm_redis_cache")).toMatchObject({ sku_name: "Basic", capacity: 1, family: "C" });
    expect(body(compile("redis/cache", setSpec("redis/cache", { highAvailability: true, size: "performance" })), "azurerm_redis_cache")).toMatchObject({ sku_name: "Standard", capacity: 3 });
  });

  it("storage: replication override is validated; versioning follows the spec", () => {
    expect(body(compile("object_store/uploads", (n) => Object.assign(n.find((x) => x.address === "object_store/uploads")!.spec, { config: { replication: "zrs" } })), "azurerm_storage_account").account_replication_type).toBe("ZRS");
    expect(() => compile("object_store/uploads", (n) => Object.assign(n.find((x) => x.address === "object_store/uploads")!.spec, { config: { replication: "RA-GRS" } }))).toThrow(/replication/);
    expect((body(compile("object_store/uploads", setSpec("object_store/uploads", { versioning: false })), "azurerm_storage_account").blob_properties as Body).versioning_enabled).toBe(false);
  });

  it("service bus: tier by size, topics need Standard, Premium is never implicit", () => {
    expect(body(compile("queue/jobs"), "azurerm_servicebus_namespace").sku).toBe("Basic");
    expect(body(compile("queue/jobs", setSpec("queue/jobs", { size: "standard" })), "azurerm_servicebus_namespace").sku).toBe("Standard");
    const asConfig = (config: Body) => (n: ResourceNode[]) => Object.assign(n.find((x) => x.address === "queue/jobs")!.spec, { config });
    expect(() => compile("queue/jobs", asConfig({ sku: "Premium" }))).toThrow(/Premium/);
    expect(() => compile("queue/jobs", asConfig({ sku: "gold" }))).toThrow(/Basic or Standard/);
    const topic = mkNode("pubsub/events", "pubsub", "azure:service_bus_topic", { size: "small", deletionPolicy: "approval", encryption: true });
    const nodes = [...sampleGraph(), topic];
    const f = driverFor(topic).compile!(topic, compileContext(nodes));
    expect(body(f, "azurerm_servicebus_namespace").sku).toBe("Standard");
    expect(f.resource).toHaveProperty("azurerm_servicebus_topic");
    const basicTopic = mkNode("pubsub/events", "pubsub", "azure:service_bus_topic", { size: "small", deletionPolicy: "approval", encryption: true, config: { sku: "Basic" } });
    expect(() => driverFor(basicTopic).compile!(basicTopic, compileContext([...sampleGraph(), basicTopic]))).toThrow(/Standard/);
  });

  it("key vault: one vault per managed secret node, the secret URI is versionless and names are valid", () => {
    const f = compile("secret/session-key-1a2b3c4d");
    expect(f.locals!.secret_session_key_1a2b3c4d__secret_uri).toBe("${azurerm_key_vault.secret_session_key_1a2b3c4d_kv.vault_uri}secrets/SESSION-KEY");
    expect(kvSecretName("vault:ws_1/env_1/DATABASE_URL")).toBe("DATABASE-URL");
    expect(kvSecretName("vault:")).toMatch(/^[0-9A-Za-z-]+$/);
    expect(kvSecretName("vault:ws/env/" + "x".repeat(300)).length).toBeLessThanOrEqual(100);
    // a referenced secret compiles to nothing
    expect(compile("secret/session-key-1a2b3c4d", (n) => (n.find((x) => x.address === "secret/session-key-1a2b3c4d")!.ownership = "referenced")).addresses).toEqual([]);
  });

  it("registry, log group and build pipeline", () => {
    expect(body(compile("container_registry/web"), "azurerm_container_registry")).toMatchObject({ sku: "Standard", admin_enabled: false });
    const q = body(compile("log_group/web"), "azurerm_log_analytics_saved_search");
    expect(q.query).toBe('ContainerAppConsoleLogs_CL | where ContainerAppName_s == "zn-k3x9q2-web" | order by TimeGenerated desc');
    expect(compile("build_pipeline/web").addresses).toEqual([]);
    expect(() => compile("build_pipeline/web", (n) => (n.find((x) => x.address === "build_pipeline/web")!.spec.output = { staticSite: "static_site/docs" }))).toThrow(/static-site/);
    expect(() => compile("build_pipeline/web", setSpec("build_pipeline/web", { location: "zenith_runner" }))).toThrow(/customer account/);
  });
});

describe("load balancer, DNS and certificates", () => {
  it("the load balancer declares nothing (Container Apps ingress is the implementation) but validates its targets", () => {
    expect(compile("load_balancer/public").addresses).toEqual([]);
    expect(() =>
      compile("load_balancer/public", (nodes) => {
        nodes.find((n) => n.address === "container_service/web")!.provider = "aws";
      })
    ).toThrow(/Azure ingress only reaches Azure container services/);
  });

  it("a subdomain gets a CNAME to the app FQDN and an asuid TXT; the apex gets an A record", () => {
    const f = compile("dns_record/app.example.com");
    expect(body(f, "azurerm_dns_cname_record")).toMatchObject({ name: "app", record: "${local.container_service_web__fqdn}", ttl: 300 });
    expect(body(f, "azurerm_dns_txt_record")).toMatchObject({ name: "asuid.app", record: [{ value: "${local.network_main__cae_verification_id}" }] });
    const apex = compile("dns_record/app.example.com", (nodes) => {
      nodes.find((n) => n.address === "dns_record/app.example.com")!.spec.name = "example.com";
      (nodes.find((n) => n.address === "load_balancer/public")!.spec.routes as Body[])[0].host = "example.com";
    });
    expect(body(apex, "azurerm_dns_a_record")).toMatchObject({ name: "@", records: ["${local.network_main__cae_static_ip}"] });
    expect(body(apex, "azurerm_dns_txt_record").name).toBe("asuid");
    expect(relativeName("a.b.example.com", "example.com")).toBe("a.b");
    expect(() => relativeName("example.org", "example.com")).toThrow(/not inside/);
    expect(() => compile("dns_record/app.example.com", (n) => (n.find((x) => x.address === "dns_record/app.example.com")!.spec.name = "other.example.com"))).toThrow(/no route/);
  });

  it("a managed zone is refused: Zenith never creates a customer's zone", () => {
    expect(() => compile("dns_zone/example.com", (n) => (n.find((x) => x.address === "dns_zone/example.com")!.ownership = "managed"))).toThrow(AzureCompileError);
    const f = compile("dns_zone/example.com");
    expect(f.data!.azurerm_dns_zone.dns_zone_example__com_zone).toEqual({ name: "example.com", resource_group_name: "dns-rg" });
    // without an externalRef the provider finds the zone by name
    const bare = compile("dns_zone/example.com", (n) => delete n.find((x) => x.address === "dns_zone/example.com")!.externalRef);
    expect(bare.data!.azurerm_dns_zone.dns_zone_example__com_zone).toEqual({ name: "example.com" });
    expect(() => compile("dns_zone/example.com", (n) => (n.find((x) => x.address === "dns_zone/example.com")!.externalRef = "arn:aws:route53:::hostedzone/Z1"))).toThrow(/ARM id/);
  });

  it("the certificate registers the hostname unbound and requests a managed certificate; binding is explicitly not declarative", () => {
    const f = compile("tls_certificate/app.example.com");
    const domain = body(f, "azurerm_container_app_custom_domain");
    expect(domain).toMatchObject({ certificate_binding_type: "Disabled", container_app_id: "${local.container_service_web__id}" });
    expect((domain.lifecycle as Body).ignore_changes).toEqual(["certificate_binding_type", "container_app_environment_certificate_id"]);
    expect(String(domain.name)).toContain("dns_record_app__example__com__fqdn");
    expect(body(f, "azurerm_container_app_environment_managed_certificate")).toMatchObject({ domain_control_validation: "CNAME", container_app_environment_id: "${local.network_main__cae_id}" });
    // apex validates over HTTP
    const apex = compile("tls_certificate/app.example.com", (nodes) => {
      (nodes.find((n) => n.address === "dns_zone/example.com")!.spec as Body).name = "app.example.com";
    });
    expect(body(apex, "azurerm_container_app_environment_managed_certificate").domain_control_validation).toBe("HTTP");
    // manual DNS validation: nothing is compiled, an apply cannot wait for the user's records
    expect(compile("tls_certificate/app.example.com", setSpec("tls_certificate/app.example.com", { validation: "dns_manual" })).addresses).toEqual([]);
    expect(() => compile("tls_certificate/app.example.com", (nodes) => (nodes.find((n) => n.address === "load_balancer/public")!.spec.routes = []))).toThrow(/no route/);
  });
});

describe("registry of drivers", () => {
  it("covers every native type of the Azure row, with documented compile restrictions", () => {
    const registered = new Set(AZURE_DRIVERS.map((d) => d.nativeType));
    expect([...registered].sort()).toEqual([
      "azure:acr_task", "azure:application_gateway", "azure:container_app", "azure:container_app_job", "azure:container_registry", "azure:dns_record_set", "azure:dns_zone", "azure:key_vault_secret",
      "azure:log_analytics_workspace", "azure:managed_certificate", "azure:network_security_rule", "azure:postgresql_flexible_server", "azure:redis_cache", "azure:service_bus_queue",
      "azure:service_bus_topic", "azure:storage_container", "azure:subnet", "azure:user_assigned_identity", "azure:virtual_network",
      "azure:mysql_flexible_server", "azure:virtual_machine", "azure:function_app", "azure:static_web_app", "azure:aks_cluster", "azure:managed_disk",
    ].sort());
  });

  it("compiles the whole sample graph in one pass without exceptions", () => {
    expect(compileAll(sampleGraph(), driverFor).size).toBe(sampleGraph().length);
  });
});
