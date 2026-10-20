/* eslint-disable @typescript-eslint/no-explicit-any */
/** Real Cilium Gateway attachment and HTTPS routing; Docker/kind only, never a fake API. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderEnvironmentTls, environmentGatewayParent, environmentTlsNames } from "@/lib/providers/zenith/tls";
import { renderIsolationBundle } from "@/lib/providers/zenith/isolation-bundle";
import { readSubstrateConfig, managedHostname } from "@/lib/providers/zenith/substrate";
import { renderTenancy, tenantNamespace } from "@/lib/providers/zenith/tenancy";
import type { ZenithTenant } from "@/lib/providers/zenith/types";
import { Kube, eventually, randomSuffix, runPod, startPod } from "./support";

const enabled = process.env.ZENITH_TEST_GVISOR_GATEWAY === "1";
const timeout = 240_000;
describe.skipIf(!enabled)("J14 real Cilium Gateway tenant attachment and routing (needs Docker/kind)", () => {
  const kube = new Kube(process.env.KUBECONFIG ?? "");
  const run = randomSuffix(); const label = "zenith.dev/j14-gateway-run";
  const gatewayNamespace = `zenith-gateway-${run}`;
  const tenants: ZenithTenant[] = ["a", "b"].map(id => ({ workspaceId: `ws-j14-${id}-${run}`, environmentId: `env-j14-${id}-${run}`, workspaceSlug: `j14${id}`, environmentSlug: "prod", planTier: "starter" }));
  const namespaces = tenants.map(t => tenantNamespace(t.workspaceId,t.environmentId));
  const hosts: string[] = []; const gateways: string[] = []; const nodePorts: number[] = [];
  const image = process.env.ZENITH_TEST_K8S_IMAGE ?? ""; const curlImage = process.env.ZENITH_TEST_K8S_CURL_IMAGE ?? "";
  const resources = { requests: { cpu: "100m", memory: "64Mi", "ephemeral-storage": "32Mi" }, limits: { cpu: "200m", memory: "128Mi", "ephemeral-storage": "64Mi" } };
  let validated = false; let temp: string | undefined; let nodeIp: string; let ca: string;
  const receipt: Record<string, unknown> = { requirement: "PROD-MAN-04", startedAt: new Date().toISOString(), checks: {} };
  const checks = receipt.checks as Record<string,unknown>;
  const apply = (objects: object[]) => { const result = kube.apply(objects); expect(result.code,result.stderr).toBe(0); };
  const configured = () => {
    const result = readSubstrateConfig({ ZENITH_MANAGED_CLUSTER_SERVER: "https://kubernetes.invalid:6443", ZENITH_MANAGED_KUBECONFIG_REF: "vault:j14/contract", ZENITH_MANAGED_APP_DOMAIN: "apps.isolation.test", ZENITH_MANAGED_GATEWAY_NAMESPACE: gatewayNamespace, ZENITH_MANAGED_GATEWAY_CLASS: "cilium", ZENITH_MANAGED_GATEWAY_MODE: "gateway_api", ZENITH_MANAGED_FQDN_ENGINE: "cilium", ZENITH_MANAGED_RUNTIME_CLASS: "zenith-gvisor" });
    if (!result.configured) throw new Error(result.message); return result.substrate;
  };
  const route = (tenant: ZenithTenant, name: string, parentTenant = tenant, backendNamespace?: string) => ({ apiVersion: "gateway.networking.k8s.io/v1", kind: "HTTPRoute", metadata: { name, namespace: tenantNamespace(tenant.workspaceId,tenant.environmentId) },
    spec: { hostnames: [managedHostname({ service: "web", ...parentTenant, baseDomain: configured().baseDomain })], parentRefs: [environmentGatewayParent(parentTenant,configured())], rules: [{ backendRefs: [{ name: "backend", port: 8080, ...(backendNamespace ? { namespace: backendNamespace } : {}) }] }] } });
  async function routeStatus(namespace: string, name: string, type: string, status: string, reason?: string) {
    return eventually(`${namespace}/${name} ${type}=${status}`, () => {
      const value = kube.json<any>(["-n",namespace,"get","httproute",name]);
      const parent = value?.status?.parents?.find((p: any) => p.controllerName === "io.cilium/gateway-controller");
      const condition = parent?.conditions?.find((c: any) => c.type === type);
      return condition?.status === status && condition.observedGeneration === value.metadata.generation && (!reason || condition.reason === reason) ? { parent: parent.parentRef, condition } : undefined;
    },{ timeoutMs: 180_000 });
  }

  beforeAll(async () => {
    expect(process.env.KUBECONFIG).toBeTruthy(); expect(kube.contextName()).toMatch(/^kind-zenith-life07-[a-z0-9]{1,20}$/);
    expect(image).toMatch(/@sha256:[a-f0-9]{64}$/); expect(curlImage).toMatch(/@sha256:[a-f0-9]{64}$/);
    expect(kube.json<any>(["get","gatewayclass","cilium"])?.spec.controllerName).toBe("io.cilium/gateway-controller");
    expect(kube.json<any>(["get","runtimeclass","zenith-gvisor"])?.handler).toBe("runsc");
    validated = true;
    nodeIp = kube.json<any>(["get","nodes"])?.items[0].status.addresses.find((a: any) => a.type === "InternalIP").address;
    expect(nodeIp).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    apply([{ apiVersion: "v1", kind: "Namespace", metadata: { name: gatewayNamespace, labels: { [label]: run } } }]);
    const substrate = configured();
    for (const t of tenants) hosts.push(managedHostname({ service: "web", ...t, baseDomain: substrate.baseDomain }));
    // Ephemeral local TLS leaf trusted by the client: routing proof, not public ACME/DNS proof.
    temp = mkdtempSync(path.join(tmpdir(),"zenith-j14-tls-"));
    const cert = path.join(temp,"cert.pem"); const key = path.join(temp,"key.pem");
    const generated = spawnSync("openssl",["req","-x509","-newkey","rsa:2048","-nodes","-keyout",key,"-out",cert,"-days","1","-subj","/CN=J14 disposable routing","-addext",`subjectAltName=${hosts.map(h => `DNS:${h}`).join(",")}`],{ encoding: "utf8",timeout: 30_000 });
    expect(generated.status,generated.stderr).toBe(0); ca = readFileSync(cert,"utf8");
    for (let i=0;i<tenants.length;i++) {
      const t = tenants[i]; const baseline = renderTenancy(t,substrate);
      apply(baseline.objects.map(o => ({ ...o,metadata: { ...o.metadata,labels: { ...o.metadata.labels,[label]:run } } })));
      apply(renderIsolationBundle(t,substrate).fqdnEgress);
      const names = environmentTlsNames(t,substrate); gateways.push(names.gateway);
      apply([{ apiVersion: "v1",kind: "Secret",metadata: { name: names.secret,namespace: gatewayNamespace },type: "kubernetes.io/tls",data: { "tls.crt": Buffer.from(ca).toString("base64"),"tls.key": readFileSync(key).toString("base64") } }, ...renderEnvironmentTls(t,substrate).filter(o => o.kind === "Gateway")]);
      await startPod(kube,{ name:"backend",namespace: namespaces[i],image,runtimeClassName:"zenith-gvisor",resources,script:`mkdir -p /tmp/www; echo tenant-${i} > /tmp/www/index.html; exec httpd -f -p 8080 -h /tmp/www` });
      const pod = kube.json<any>(["-n",namespaces[i],"get","pod","backend"]);
      // The service uses the helper's actual labels, never an assumed selector.
      apply([{ apiVersion:"v1",kind:"Service",metadata:{name:"backend",namespace:namespaces[i]},spec:{selector:pod.metadata.labels,ports:[{port:8080,targetPort:8080}] } },route(t,"own")]);
      await routeStatus(namespaces[i],"own","Accepted","True"); await routeStatus(namespaces[i],"own","ResolvedRefs","True");
      // Cilium shortens long Service names to 63 characters; select by the Gateway API owner label instead.
      const service = await eventually(`Gateway service ${names.gateway}`,() => { const items = kube.json<any>(["-n",gatewayNamespace,"get","service","-l",`gateway.networking.k8s.io/gateway-name=${names.gateway}`])?.items ?? []; return items.length === 1 ? items[0] : undefined; },{ timeoutMs:180_000 });
      expect(service.spec.type).toBe("LoadBalancer");
      const port = service.spec.ports.find((p: any) => p.port === 443)?.nodePort; expect(port).toBeGreaterThanOrEqual(30000); nodePorts.push(port);
    }
  },timeout);
  afterAll(() => {
    if (temp) rmSync(temp,{ recursive:true,force:true });
    if (!validated) return;
    const cleanup = kube.run(["delete","namespace","-l",`${label}=${run}`,"--ignore-not-found","--wait=true","--timeout=120s"]);
    receipt.cleanup = { code:cleanup.code }; receipt.finishedAt = new Date().toISOString();
    const out = process.env.ZENITH_TEST_GATEWAY_EVIDENCE_OUT;
    if (out) { mkdirSync(path.dirname(out),{ recursive:true }); writeFileSync(out,`${JSON.stringify(receipt,null,2)}\n`); }
    expect(cleanup.code,cleanup.stderr).toBe(0);
  },timeout);
  async function request(i: number, name: string, host=hosts[i]) {
    // Trust the generated certificate and retain Host + SNI on the actual Envoy NodePort path.
    const script = `printf '%s' '${Buffer.from(ca).toString("base64")}' | base64 -d > /tmp/ca.pem; curl --fail --silent --show-error --max-time 20 --cacert /tmp/ca.pem --resolve '${host}:${nodePorts[i]}:${nodeIp}' -H 'Host: ${host}' 'https://${host}:${nodePorts[i]}/'`;
    return runPod(kube,{ name,namespace:gatewayNamespace,image:curlImage,script });
  }
  it("routes HTTPS through both real Gateways to their distinct sandbox backends",async () => {
    for (let i=0;i<2;i++) {
      const result = await request(i,`own-${i}`);
      expect(result.phase,result.log).toBe("Succeeded"); expect(result.log).toBe(`tenant-${i}`);
      checks[`own-${i}`] = { hostname:hosts[i],gateway:gateways[i],body:result.log };
    }
  },timeout);
  it("refuses a route from tenant A attaching to tenant B's listener, with B's routing still working",async () => {
    apply([route(tenants[0],"steal-listener",tenants[1])]);
    checks.foreignListener = await routeStatus(namespaces[0],"steal-listener","Accepted","False","NotAllowedByListeners");
    const result = await request(1,"after-listener-attack"); expect(result.phase,result.log).toBe("Succeeded"); expect(result.log).toBe("tenant-1");
  },timeout);
  it("refuses a cross-tenant backend without a ReferenceGrant and keeps the other tenant serving",async () => {
    const hostile = route(tenants[0],"foreign-backend",tenants[0],namespaces[1]);
    (hostile.spec.rules[0] as any).matches = [{path:{type:"PathPrefix",value:"/foreign"}}];
    apply([hostile]);
    checks.foreignBackend = await routeStatus(namespaces[0],"foreign-backend","ResolvedRefs","False","RefNotPermitted");
    const result = await request(1,"after-backend-attack"); expect(result.phase,result.log).toBe("Succeeded"); expect(result.log).toBe("tenant-1");
  },timeout);
});
