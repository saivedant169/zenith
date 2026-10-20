/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * PROD-MAN-04 (two untrusted tenants) and PROD-MAN-05 (resource isolation under load)
 * acceptance against a REAL cluster. GATED: skipped, with the reason printed, unless
 *   ZENITH_TEST_TENANT_ISOLATION=1
 *   KUBECONFIG                          a private kubeconfig for a disposable kind cluster
 *   ZENITH_TEST_ISOLATION_PROFILE       kind-calico | kind-cilium | kind-existing
 *   ZENITH_TEST_K8S_IMAGE               a digest-pinned image with sh, httpd, wget, awk, dd (busybox)
 * Run it through scripts/isolation/tenant-isolation-acceptance.sh, which builds the cluster
 * (pinned node image, NetworkPolicy engine, kubelet pid limit), sets these and deletes the cluster.
 * Optional: ZENITH_TEST_ISOLATION_MUTATE_COREDNS=1 (kind only; the hostname-egress checks need
 * test names), ZENITH_TEST_ISOLATION_RUNTIME_CLASS (a RuntimeClass the cluster serves),
 * ZENITH_TEST_ISOLATION_LATENCY_FACTOR (default 5) and ZENITH_TEST_ISOLATION_LATENCY_ABS_MS
 * (default 250): the PROVISIONAL bound on a victim's p95 latency under a neighbour's load,
 * ZENITH_TEST_ISOLATION_CONTROL=1 (also measure an UNBOUNDED neighbour, recorded not asserted),
 * ZENITH_TEST_ISOLATION_EVIDENCE_OUT.
 *
 * Two tenants, rendered by the real generators (renderTenancy, renderIsolationBundle):
 *   A is the adversary, on the free plan; B is the victim, on the starter plan.
 *
 * What this proves that the policy unit tests cannot (each is a real request to a real API
 * server or a real packet through the cluster's CNI):
 *   admission   a privileged, host-mounting, root, capability-adding or unconfined pod is
 *               refused by Pod Security Admission; a system-priority pod by the quota
 *   quota       over-limit containers, a third pod past the CPU quota, 25 secrets past a
 *               quota of 20, LoadBalancer and NodePort services and a PVC on a plan with
 *               none are all refused
 *   network     A cannot reach B by pod IP or by service name (DNS resolves, the packet is
 *               dropped), B cannot reach A, an unlabeled pod in the SAME namespace cannot
 *               reach its neighbour, the gateway namespace can (control), A cannot reach the
 *               node's kubelet, the API server, or a metadata address that is really
 *               listening, while a public address that is really listening is reachable
 *               (control: the block is specific, not a broken network)
 *   hostname    (Cilium only) an allowlisted name is reachable; a resolvable name that is
 *               not allowlisted is not; a name that RESOLVES to the metadata address is
 *               not, because the deny beats the allow
 *   secrets     a ServiceAccount token of A cannot read B's secret or its own; A's
 *               operator identity can work in A and is refused everything in B, in the
 *               cluster scope and for escalation, by `can-i` and by real requests
 *   storage     a pod in A that names B's claim never gets it
 *   noisy       A's CPU, memory, disk and PID exhaustion are each bounded (CFS quota,
 *               OOM kill, ephemeral-storage eviction, pids.max), and B's p95 latency
 *               stays within the bound while all four run at once
 *
 * What it does not prove, even when it passes: any cluster but the one it ran on; cloud
 * load balancers, Gateway API route attachment (the CRDs are not installed on kind; route
 * hijack is proven by the isolation gate in tests/providers/zenith and by the RBAC refusals
 * here); a hostile runtime escape (that is the sandbox runtime's job, see
 * docs/platform/TENANT-ISOLATION.md); noisy-neighbour behaviour at production node sizes.
 * The evidence file names the cluster, the engine and every check.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyzeOperatorSeparation, bundleObjects, operatorSubjectOf, renderIsolationBundle, validateIsolationBundle } from "@/lib/providers/zenith/isolation-bundle";
import { validateTenantObjects } from "@/lib/providers/zenith/isolation";
import { readSubstrateConfig, type ZenithSubstrate } from "@/lib/providers/zenith/substrate";
import { renderTenancy, tenantNamespace } from "@/lib/providers/zenith/tenancy";
import type { ZenithTenant } from "@/lib/providers/zenith/types";
import { Kube, deletePod, eventually, latencyBound, latencyScript, parseLatency, randomSuffix, reach, restrictedPod, runPod, sleep, startPod, tokenKubeconfig, type LatencyStats } from "./support";

const profile = process.env.ZENITH_TEST_ISOLATION_PROFILE ?? "";
const image = process.env.ZENITH_TEST_K8S_IMAGE ?? "";
const DIGEST_PINNED = /^[A-Za-z0-9][A-Za-z0-9._\-/:]*@sha256:[a-f0-9]{64}$/;
const enabled = process.env.ZENITH_TEST_TENANT_ISOLATION === "1" && !!process.env.KUBECONFIG && /^kind-(calico|cilium|existing)$/.test(profile) && DIGEST_PINNED.test(image);

const factor = Number(process.env.ZENITH_TEST_ISOLATION_LATENCY_FACTOR ?? "5");
const absMs = Number(process.env.ZENITH_TEST_ISOLATION_LATENCY_ABS_MS ?? "250");
const mutateCoreDns = process.env.ZENITH_TEST_ISOLATION_MUTATE_COREDNS === "1";
const runtimeClass = process.env.ZENITH_TEST_ISOLATION_RUNTIME_CLASS;

const LONG = 600_000;
const META_IP = "169.254.169.254";
const PUBLIC_A = "203.0.113.10"; // TEST-NET-3: public address space as far as the policy is concerned
const PUBLIC_B = "203.0.113.11";

// A static title: the wave6 gate manifest matches it exactly; the profile is recorded in the evidence file.
describe.skipIf(!enabled)("PROD-MAN-04/05 two untrusted tenants on a real cluster", () => {
  const run = randomSuffix(3);
  const kube = new Kube(process.env.KUBECONFIG as string);
  const tenantA: ZenithTenant = { workspaceId: `ws-iso-a-${run}`, environmentId: `env-iso-a-${run}`, workspaceSlug: "isoa", environmentSlug: "prod", planTier: "free" };
  const tenantB: ZenithTenant = { workspaceId: `ws-iso-b-${run}`, environmentId: `env-iso-b-${run}`, workspaceSlug: "isob", environmentSlug: "prod", planTier: "starter" };
  const nsA = tenantNamespace(tenantA.workspaceId, tenantA.environmentId);
  const nsB = tenantNamespace(tenantB.workspaceId, tenantB.environmentId);
  const gwNs = `zenith-iso-gw-${run}`;
  const fxNs = `zenith-iso-fx-${run}`;
  const RUN_LABEL = "zenith.dev/acceptance-run";
  const opSa = (ns: string) => `system:serviceaccount:${operatorSubjectOf(ns).namespace}:${operatorSubjectOf(ns).name}`;

  let substrate: ZenithSubstrate;
  let engine: "calico" | "cilium" | "unknown" = "unknown";
  let fqdnMode = false;
  let createdSystemNs = false;
  let probes = 0;
  let corednsOriginal: string | undefined;
  let victimIp = "";
  let victimAIp = "";
  const evidence: { requirement: string; profile: string; startedAt: string; finishedAt?: string; cluster?: Record<string, unknown>; checks: Record<string, Record<string, unknown>> } = {
    requirement: "PROD-MAN-04+PROD-MAN-05",
    profile,
    startedAt: new Date().toISOString(),
    checks: {},
  };
  const record = (area: string, data: Record<string, unknown>) => {
    evidence.checks[area] = { ...(evidence.checks[area] ?? {}), ...data };
  };

  const labelled = <T extends { metadata: { labels?: Record<string, string> } }>(o: T): T => {
    const c = structuredClone(o);
    c.metadata.labels = { ...(c.metadata.labels ?? {}), [RUN_LABEL]: run };
    return c;
  };
  const applyOk = (objects: object[]) => {
    const r = kube.apply(objects);
    expect(r.code, r.stderr.slice(0, 800)).toBe(0);
  };

  /** One probe pod in `namespace`; the script prints REACHED or BLOCKED (or its own markers). */
  async function probe(namespace: string, script: string, over: { labels?: Record<string, string>; sa?: string } = {}): Promise<string> {
    const r = await runPod(kube, { name: `p-${run}-${++probes}`, namespace, image, script, labels: over.labels, ...(over.sa ? { serviceAccountName: over.sa } : {}) });
    expect(r.phase, `probe ${probes} in ${namespace}: ${r.log}`).toBe("Succeeded");
    return r.log.trim();
  }
  const attempt = (namespace: string, url: string, labels?: Record<string, string>) => probe(namespace, reach(url), { labels });

  const refusedBy = (r: { code: number; stderr: string }, pattern: RegExp, what: string) => {
    expect(r.code, `${what} must be refused`).not.toBe(0);
    expect(r.stderr, `${what}: ${r.stderr.slice(0, 300)}`).toMatch(pattern);
  };

  beforeAll(async () => {
    if (process.env.ZENITH_TEST_ISOLATION_REQUIRE_RUNTIME === "1") expect(runtimeClass, "the J14 runtime lane must never silently skip sandbox evaluation").toBeTruthy();
    const context = kube.contextName();
    expect(context, "the isolation suite only runs against a kind cluster named zenith-life07*").toMatch(/^kind-zenith-life07(-[a-z0-9]{1,20})?$/);
    const version = JSON.parse(kube.must(["version", "-o", "json"])).serverVersion;
    const ds = kube.json<any>(["get", "daemonsets", "-A"])?.items ?? [];
    const names = ds.map((d: any) => String(d.metadata.name));
    engine = names.includes("cilium") ? "cilium" : names.includes("calico-node") ? "calico" : "unknown";
    expect(engine, "no NetworkPolicy engine (calico-node or cilium DaemonSet) found: every network check would pass for the wrong reason").not.toBe("unknown");
    if (profile === "kind-cilium") expect(engine).toBe("cilium");
    if (profile === "kind-calico") expect(engine).toBe("calico");
    fqdnMode = engine === "cilium";
    evidence.cluster = { gitVersion: version.gitVersion, platform: version.platform, context, engine, fqdnMode };

    const operatorNs = operatorSubjectOf(nsA).namespace;
    createdSystemNs = kube.run(["get", "namespace", operatorNs]).code !== 0;
    const env: Record<string, string> = {
      ZENITH_MANAGED_CLUSTER_SERVER: "https://kubernetes.invalid:6443",
      ZENITH_MANAGED_KUBECONFIG_REF: "vault:zenith-managed/kubeconfig",
      ZENITH_MANAGED_APP_DOMAIN: "apps.isolation.test",
      ZENITH_MANAGED_GATEWAY_NAMESPACE: gwNs,
      ZENITH_MANAGED_OPERATOR_CREDENTIAL_PREFIX: "vault:zenith-managed/operators",
      ...(fqdnMode ? { ZENITH_MANAGED_FQDN_ENGINE: "cilium" } : {}),
      ...(runtimeClass ? { ZENITH_MANAGED_RUNTIME_CLASS: runtimeClass } : {}),
    };
    const cfg = readSubstrateConfig(env);
    if (!cfg.configured) throw new Error(`test substrate: ${cfg.message}`);
    substrate = cfg.substrate;

    // platform namespaces: the gateway stand-in, the fixtures and (if absent) the operator namespace
    const ns = (name: string, labels: Record<string, string> = {}) => ({ apiVersion: "v1", kind: "Namespace", metadata: { name, labels: { [RUN_LABEL]: run, ...labels } } });
    applyOk([ns(gwNs), ns(fxNs, { "pod-security.kubernetes.io/enforce": "privileged" }), ...(createdSystemNs ? [ns(operatorNs)] : [])]);

    // the fixtures: a listener on a metadata address and on two public-looking addresses, on every node
    const addrs = [META_IP, PUBLIC_A, PUBLIC_B];
    applyOk([
      labelled({
        apiVersion: "apps/v1",
        kind: "DaemonSet",
        metadata: { name: "fixture-addrs", namespace: fxNs, labels: {} },
        spec: {
          selector: { matchLabels: { app: "fixture-addrs" } },
          template: {
            metadata: { labels: { app: "fixture-addrs" } },
            spec: {
              hostNetwork: true,
              terminationGracePeriodSeconds: 5,
              tolerations: [{ operator: "Exists" }],
              containers: [
                {
                  name: "addrs",
                  image,
                  securityContext: { privileged: true, runAsUser: 0 },
                  command: [
                    "/bin/sh",
                    "-c",
                    `mkdir -p /www && echo ok > /www/index.html
for a in ${addrs.join(" ")}; do ip addr add $a/32 dev lo 2>/dev/null || true; done
trap 'for a in ${addrs.join(" ")}; do ip addr del $a/32 dev lo 2>/dev/null; done; exit 0' TERM INT
for a in ${addrs.join(" ")}; do httpd -f -p $a:443 -h /www & done
wait`,
                  ],
                },
              ],
            },
          },
        },
      }),
    ]);
    kube.must(["-n", fxNs, "rollout", "status", "daemonset/fixture-addrs", "--timeout=180s"], { timeoutMs: 200_000 });
    await sleep(3000);

    // the two tenants, from the real generators, validated before they are applied
    for (const t of [tenantA, tenantB]) {
      const baseline = renderTenancy(t, substrate);
      const bundle = renderIsolationBundle(t, substrate, fqdnMode ? { egressFqdns: t === tenantA ? ["allowed.isolation.test", "rebind.isolation.test", "*.wild.isolation.test"] : ["allowed.isolation.test"] } : {});
      validateIsolationBundle(bundle, { tenant: t, substrate });
      applyOk(baseline.objects.map(labelled));
      applyOk(bundleObjects(bundle).filter((o) => o.kind !== "CiliumNetworkPolicy" || fqdnMode).map(labelled));
    }
  }, LONG);

  afterAll(async () => {
    const notes: string[] = [];
    const sel = `${RUN_LABEL}=${run}`;
    for (const cmd of [
      ["delete", "clusterrolebinding,clusterrole", "-l", sel, "--ignore-not-found", "--wait=false"],
      ["delete", "serviceaccount", "-n", operatorSubjectOf(nsA).namespace, "-l", sel, "--ignore-not-found", "--wait=false"],
      ["delete", "namespace", "-l", sel, "--ignore-not-found", "--wait=false"],
    ]) {
      const r = kube.run(cmd);
      if (r.code !== 0) notes.push(`cleanup ${cmd.slice(0, 2).join(" ")} failed: ${r.stderr.trim().slice(0, 200)}`);
    }
    if (corednsOriginal !== undefined) {
      kube.run(["-n", "kube-system", "patch", "configmap", "coredns", "--type", "merge", "-p", JSON.stringify({ data: { Corefile: corednsOriginal } })]);
      kube.run(["-n", "kube-system", "rollout", "restart", "deployment/coredns"]);
    }
    evidence.finishedAt = new Date().toISOString();
    if (notes.length) record("cleanup", { notes });
    const out = process.env.ZENITH_TEST_ISOLATION_EVIDENCE_OUT;
    if (out) {
      mkdirSync(path.dirname(out), { recursive: true });
      writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`);
    }
  }, 120_000);

  /* --------------------------------- admission -------------------------------- */

  describe("pod security: an adversary cannot ask for more than the restricted profile", () => {
    const base = (name: string, mutate: (p: any) => void) => restrictedPod({ name, namespace: nsA, image, script: "sleep 5", mutate });
    const cases: [string, (p: any) => void][] = [
      // The API itself rejects privileged with allowPrivilegeEscalation=false, so unset it: PodSecurity must be the refuser.
      ["privileged container", (p) => { p.spec.containers[0].securityContext.privileged = true; delete p.spec.containers[0].securityContext.allowPrivilegeEscalation; }],
      ["hostPath volume", (p) => {
        p.spec.volumes = [{ name: "h", hostPath: { path: "/" } }];
        p.spec.containers[0].volumeMounts = [{ name: "h", mountPath: "/host" }];
      }],
      ["host network", (p) => (p.spec.hostNetwork = true)],
      ["host PID", (p) => (p.spec.hostPID = true)],
      ["host IPC", (p) => (p.spec.hostIPC = true)],
      ["root user", (p) => {
        p.spec.securityContext.runAsNonRoot = false;
        p.spec.securityContext.runAsUser = 0;
      }],
      ["added NET_ADMIN", (p) => (p.spec.containers[0].securityContext.capabilities.add = ["NET_ADMIN"])],
      ["added SYS_ADMIN", (p) => (p.spec.containers[0].securityContext.capabilities.add = ["SYS_ADMIN"])],
      ["privilege escalation allowed", (p) => (p.spec.containers[0].securityContext.allowPrivilegeEscalation = true)],
      ["no seccomp profile", (p) => delete p.spec.securityContext.seccompProfile],
      ["unconfined seccomp", (p) => (p.spec.securityContext.seccompProfile = { type: "Unconfined" })],
      ["host port", (p) => (p.spec.containers[0].ports = [{ containerPort: 8080, hostPort: 8080 }])],
    ];

    it("refuses each adversarial pod at admission and creates nothing", () => {
      const results: Record<string, string> = {};
      for (const [label, mutate] of cases) {
        const name = `bad-${label.replace(/[^a-z]+/gi, "-").toLowerCase()}`;
        const r = kube.create(base(name, mutate));
        refusedBy(r, /violates PodSecurity "restricted/, label);
        results[label] = "refused";
      }
      expect(kube.json<any>(["-n", nsA, "get", "pods"])?.items ?? [], "no adversarial pod may exist").toHaveLength(0);
      record("pod_security", results);
    });

    it("the control: the same pod without the violation is admitted", () => {
      const r = kube.create(base("good-control", () => undefined));
      expect(r.code, r.stderr).toBe(0);
      deletePod(kube, nsA, "good-control");
    });

    it("a system-priority pod is refused by the priority quota, and the isolation gate agrees on a rendered workload", () => {
      const r = kube.create(base("bad-priority", (p) => (p.spec.priorityClassName = "system-node-critical")));
      refusedBy(r, /exceeded quota|forbidden/i, "system priority class");
      const gate = validateTenantObjects(
        [{ apiVersion: "apps/v1", kind: "Deployment", metadata: { name: "x", namespace: nsA }, spec: { template: { spec: { priorityClassName: "system-node-critical", containers: [] } } } }],
        { tenant: tenantA, substrate }
      ).map((v) => v.rule);
      expect(gate).toContain("priority_class");
      record("pod_security", { systemPriority: "refused by quota and by the gate" });
    });

    it("a pod that names a RuntimeClass the platform does not serve never runs", () => {
      const r = kube.create(base("bad-runtime", (p) => (p.spec.runtimeClassName = `no-such-runtime-${run}`)));
      if (r.code === 0) {
        const phase = kube.json<any>(["-n", nsA, "get", "pod", "bad-runtime"])?.status?.phase;
        expect(phase).not.toBe("Running");
        deletePod(kube, nsA, "bad-runtime");
      } else expect(r.stderr).toMatch(/RuntimeClass|runtime class/i);
    });
  });

  /* ----------------------------------- quota ---------------------------------- */

  describe("quota and limits bound what an adversary can create", () => {
    const sleeper = (name: string, resources: Record<string, unknown>) => restrictedPod({ name, namespace: nsA, image, script: "sleep 3600", resources, restartPolicy: "Always" });

    it("refuses a container above the plan's per-container ceiling", () => {
      refusedBy(kube.create(sleeper("big-cpu", { limits: { cpu: "2" }, requests: { cpu: "100m" } })), /maximum cpu usage per Container/i, "cpu above ceiling");
      refusedBy(kube.create(sleeper("big-mem", { limits: { memory: "8Gi" }, requests: { memory: "64Mi" } })), /maximum memory usage per Container/i, "memory above ceiling");
      refusedBy(kube.create(sleeper("big-disk", { limits: { "ephemeral-storage": "50Gi" }, requests: { "ephemeral-storage": "64Mi" } })), /maximum ephemeral-storage usage per Container/i, "disk above ceiling");
      record("quota", { containerCeiling: "refused (cpu, memory, ephemeral-storage)" });
    });

    it("refuses the pod that would exceed the namespace CPU quota", () => {
      const spec = { requests: { cpu: "500m", memory: "64Mi" }, limits: { cpu: "500m", memory: "64Mi" } };
      const made: string[] = [];
      try {
        for (const n of ["q1", "q2"]) {
          const r = kube.create(sleeper(n, spec));
          expect(r.code, r.stderr).toBe(0);
          made.push(n);
        }
        refusedBy(kube.create(sleeper("q3", spec)), /exceeded quota: zenith-quota/i, "third pod past a 1 CPU quota");
      } finally {
        for (const n of [...made, "q3"]) deletePod(kube, nsA, n);
      }
      record("quota", { cpuQuota: "third 500m pod refused on a 1 CPU namespace" });
    });

    it("refuses secrets past the object-count quota", () => {
      const items = Array.from({ length: 25 }, (_, i) => ({ apiVersion: "v1", kind: "Secret", metadata: { name: `s${i}`, namespace: nsA }, stringData: { k: "v" } }));
      const r = kube.apply(items);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toMatch(/exceeded quota/i);
      const count = (kube.json<any>(["-n", nsA, "get", "secrets"])?.items ?? []).length;
      kube.run(["-n", nsA, "delete", "secrets", "--all", "--wait=false"]);
      expect(count).toBeLessThanOrEqual(20);
      record("quota", { secrets: `${count} of 25 created, quota 20` });
    });

    it("refuses LoadBalancer and NodePort services and a PVC on a plan with no storage", () => {
      const svc = (name: string, type: string) => ({ apiVersion: "v1", kind: "Service", metadata: { name, namespace: nsA }, spec: { type, selector: { app: "x" }, ports: [{ port: 80 }] } });
      refusedBy(kube.create(svc("lb", "LoadBalancer")), /exceeded quota|forbidden/i, "LoadBalancer service");
      refusedBy(kube.create(svc("np", "NodePort")), /exceeded quota|forbidden/i, "NodePort service");
      refusedBy(kube.create({ apiVersion: "v1", kind: "PersistentVolumeClaim", metadata: { name: "pvc", namespace: nsA }, spec: { accessModes: ["ReadWriteOnce"], resources: { requests: { storage: "1Gi" } } } }), /exceeded quota|forbidden/i, "PVC on the free plan");
      record("quota", { exposure: "LoadBalancer, NodePort and PVC refused on the free plan" });
    });
  });

  /* ---------------------------------- network --------------------------------- */

  describe("network: policy is enforced by real traffic, with controls", () => {
    it("starts a server in each tenant, the intra-namespace allow in B, and measures nothing yet", async () => {
      const serve = (name: string, namespace: string) =>
        startPod(kube, { name, namespace, image, labels: { app: name }, restartPolicy: "Always", script: "mkdir -p /tmp/www && echo marker > /tmp/www/index.html && exec httpd -f -p 8080 -h /tmp/www" });
      victimIp = (await serve("victim", nsB)).ip;
      victimAIp = (await serve("svc-a", nsA)).ip;
      // the shape the Kubernetes provider renders for a firewall: ingress on the server, egress on the client, nothing else
      applyOk([
        { apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy", metadata: { name: "allow-client-to-victim", namespace: nsB }, spec: { podSelector: { matchLabels: { app: "victim" } }, policyTypes: ["Ingress"], ingress: [{ from: [{ podSelector: { matchLabels: { role: "client" } } }], ports: [{ protocol: "TCP", port: 8080 }] }] } },
        { apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy", metadata: { name: "allow-client-egress", namespace: nsB }, spec: { podSelector: { matchLabels: { role: "client" } }, policyTypes: ["Egress"], egress: [{ to: [{ podSelector: { matchLabels: { app: "victim" } } }], ports: [{ protocol: "TCP", port: 8080 }] }] } },
        { apiVersion: "v1", kind: "Service", metadata: { name: "victim", namespace: nsB }, spec: { selector: { app: "victim" }, ports: [{ port: 8080 }] } },
        { apiVersion: "v1", kind: "Service", metadata: { name: "svc-a", namespace: nsA }, spec: { selector: { app: "svc-a" }, ports: [{ port: 8080 }] } },
      ]);
      expect(victimIp).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    }, LONG);

    it("controls: the gateway namespace reaches both tenants, and B's labelled client reaches B's server", async () => {
      expect(await attempt(gwNs, `http://${victimIp}:8080/`)).toBe("REACHED");
      expect(await attempt(gwNs, `http://${victimAIp}:8080/`)).toBe("REACHED");
      expect(await attempt(nsB, `http://${victimIp}:8080/`, { role: "client" })).toBe("REACHED");
      record("network", { controls: "gateway to A and B reached; B client to B server reached" });
    }, LONG);

    it("A cannot reach B by pod IP, and B cannot reach A", async () => {
      expect(await attempt(nsA, `http://${victimIp}:8080/`)).toBe("BLOCKED");
      expect(await attempt(nsB, `http://${victimAIp}:8080/`, { role: "client" })).toBe("BLOCKED");
      record("network", { crossTenantByIp: "blocked both ways" });
    }, LONG);

    it("A cannot reach B by service name: DNS resolves, the packet is dropped", async () => {
      const out = await probe(nsA, `if nslookup victim.${nsB}.svc.cluster.local >/dev/null 2>&1; then echo RESOLVED; else echo NORESOLVE; fi; ${reach(`http://victim.${nsB}.svc.cluster.local:8080/`)}`);
      expect(out.split(/\s+/)).toContain("BLOCKED");
      record("network", { crossTenantByName: `A resolves=${out.includes("RESOLVED")} and is blocked` });
    }, LONG);

    it("an unlabelled pod in the SAME namespace cannot reach its neighbour (default deny applies inside a namespace)", async () => {
      expect(await attempt(nsB, `http://${victimIp}:8080/`)).toBe("BLOCKED");
    }, LONG);

    it("A cannot reach the kubelet, the API server or the metadata address; the public control IS reachable (block is specific)", async () => {
      const nodeIp = (kube.json<any>(["get", "nodes"])?.items ?? []).flatMap((n: any) => n.status.addresses).find((a: any) => a.type === "InternalIP")?.address as string;
      expect(nodeIp).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
      const apiIp = kube.must(["get", "service", "kubernetes", "-n", "default", "-o", "jsonpath={.spec.clusterIP}"]).trim();
      expect(await attempt(nsA, `http://${nodeIp}:10250/`)).toBe("BLOCKED");
      expect(await attempt(nsA, `http://${apiIp}:443/`)).toBe("BLOCKED");
      expect(await attempt(nsA, `http://${META_IP}:443/`), "the metadata listener must not be reachable from a tenant").toBe("BLOCKED");
      if (!fqdnMode) {
        expect(await attempt(nsA, `http://${PUBLIC_A}:443/`), "control: a real public listener on 443 must be reachable, or the metadata check proves nothing").toBe("REACHED");
      } else {
        expect(await attempt(nsA, `http://${PUBLIC_A}:443/`), "hostname mode: a bare public address is not allowlisted").toBe("BLOCKED");
        expect(await attempt(nsA, `http://${PUBLIC_B}:443/`)).toBe("BLOCKED");
      }
      record("network", { metadata: "blocked", kubelet: "blocked", apiServer: "blocked", publicControl: fqdnMode ? "blocked (hostname mode)" : "443 reachable" });
    }, LONG);

    describe("hostname egress (Cilium)", () => {
      it("an allowlisted name is reachable, an unlisted one is not, and a name resolving to metadata is blocked by the deny", async (ctx) => {
        if (!fqdnMode) ctx.skip();
        if (!mutateCoreDns) {
          record("hostname_egress", { status: "skipped", reason: "ZENITH_TEST_ISOLATION_MUTATE_COREDNS=1 is needed to publish test names (kind only)" });
          ctx.skip();
        }
        const cm = kube.json<any>(["-n", "kube-system", "get", "configmap", "coredns"]);
        corednsOriginal = String(cm.data.Corefile);
        const hosts = `    hosts {
      ${PUBLIC_A} allowed.isolation.test sub.wild.isolation.test
      ${PUBLIC_B} denied.isolation.test
      ${META_IP} rebind.isolation.test
      fallthrough
    }
`;
        const patched = corednsOriginal.replace(/^(\s*)forward\s/m, (m) => `${hosts}${m}`);
        expect(patched).not.toBe(corednsOriginal);
        kube.must(["-n", "kube-system", "patch", "configmap", "coredns", "--type", "merge", "-p", JSON.stringify({ data: { Corefile: patched } })]);
        kube.must(["-n", "kube-system", "rollout", "restart", "deployment/coredns"]);
        kube.must(["-n", "kube-system", "rollout", "status", "deployment/coredns", "--timeout=180s"], { timeoutMs: 200_000 });
        await eventually("the test names to resolve", async () => ((await probe(nsA, "nslookup allowed.isolation.test >/dev/null 2>&1 && echo OK || echo NO")) === "OK" ? true : undefined), { timeoutMs: 120_000, intervalMs: 3000 });
        const allowed = await attempt(nsA, "http://allowed.isolation.test:443/");
        const wild = await attempt(nsA, "http://sub.wild.isolation.test:443/");
        const denied = await attempt(nsA, "http://denied.isolation.test:443/");
        const rebind = await attempt(nsA, "http://rebind.isolation.test:443/");
        record("hostname_egress", { allowed, wildcard: wild, notAllowlisted: denied, resolvesToMetadata: rebind });
        expect(allowed, "an allowlisted name").toBe("REACHED");
        expect(wild, "a name under an allowlisted wildcard").toBe("REACHED");
        expect(denied, "a resolvable name that is not allowlisted").toBe("BLOCKED");
        expect(rebind, "a name that resolves into the metadata range must hit the deny").toBe("BLOCKED");
        // B's allowlist is its own: it never learned the wildcard
        expect(await attempt(nsB, "http://sub.wild.isolation.test:443/", { role: "client" }), "B's allowlist is separate from A's").toBe("BLOCKED");
      }, LONG);
    });
  });

  /* ---------------------------- secrets, storage, operators -------------------- */

  describe("secrets, storage and operator separation", () => {
    it("static analysis of the rendered operator access finds no cross-tenant grant", () => {
      const a = renderIsolationBundle(tenantA, substrate);
      const b = renderIsolationBundle(tenantB, substrate);
      const { findings } = analyzeOperatorSeparation([
        { tenant: tenantA, objects: a.operatorAccess },
        { tenant: tenantB, objects: b.operatorAccess },
      ]);
      expect(findings).toEqual([]);
    });

    it("a tenant workload ServiceAccount token reads nothing, in B or in its own namespace", () => {
      kube.must(["-n", nsB, "create", "secret", "generic", "b-secret", "--from-literal=k=victim-data"]);
      const token = kube.must(["-n", nsA, "create", "token", "zenith-tenant", "--duration=10m"]).trim();
      const cfg = tokenKubeconfig(kube, token);
      try {
        for (const args of [
          ["-n", nsB, "get", "secret", "b-secret"],
          ["-n", nsA, "get", "secrets"],
          ["get", "namespaces"],
          ["-n", nsB, "get", "pods"],
        ]) {
          const r = kube.run(args, { kubeconfig: cfg.path });
          refusedBy(r, /forbidden/i, `workload token: kubectl ${args.join(" ")}`);
        }
      } finally {
        cfg.dispose();
      }
      record("secrets", { workloadToken: "forbidden everywhere" });
    });

    it("a tenant pod has no Kubernetes credential mounted", async () => {
      const out = await probe(nsA, "if [ -e /var/run/secrets/kubernetes.io/serviceaccount/token ]; then echo TOKEN; else echo NOTOKEN; fi", { sa: "zenith-tenant" });
      expect(out).toBe("NOTOKEN");
    }, LONG);

    it("A's operator identity: can-i matrix (control: it can work in A; nothing in B, the cluster or escalation)", () => {
      const as = opSa(nsA);
      // control: the identity is real and can do its job in its own namespace
      expect(kube.canI(as, "create", "deployments.apps", nsA), "operator A must be able to deploy in A").toBe(true);
      expect(kube.canI(as, "get", "secrets", nsA), "operator A must be able to read A's secrets").toBe(true);
      expect(kube.canI(as, "patch", `namespaces/${nsA}`), "operator A may patch its own namespace by name").toBe(true);
      expect(kube.canI(as, "get", "pods", nsA, "log"), "the subresource check is real: operator A reads pod logs in A").toBe(true);
      const no: [string, string, string?, string?][] = [
        ["get", "secrets", nsB],
        ["list", "secrets", nsB],
        ["create", "deployments.apps", nsB],
        ["delete", "pods", nsB],
        ["get", "persistentvolumeclaims", nsB],
        ["create", "httproutes.gateway.networking.k8s.io", nsB],
        ["get", "secrets", "kube-system"],
        ["get", "secrets", operatorSubjectOf(nsA).namespace],
        ["list", "namespaces"],
        ["get", "nodes"],
        ["create", "persistentvolumes"],
        ["create", "clusterrolebindings.rbac.authorization.k8s.io"],
        ["create", "rolebindings.rbac.authorization.k8s.io", nsA],
        ["create", "roles.rbac.authorization.k8s.io", nsA],
        ["escalate", "roles.rbac.authorization.k8s.io", nsA],
        ["bind", "clusterroles.rbac.authorization.k8s.io"],
        ["impersonate", "serviceaccounts"],
        // subresources need --subresource: "kubectl auth can-i create pods/exec" asks about a pod NAMED exec
        ["create", "serviceaccounts", nsA, "token"],
        ["create", "pods", nsA, "exec"],
        ["create", "pods", nsA, "attach"],
        ["create", "pods", nsA, "portforward"],
        ["patch", `namespaces/${nsB}`],
        ["delete", `namespaces/${nsA}`],
      ];
      const failures = no.filter(([verb, resource, ns, sub]) => kube.canI(as, verb, resource, ns, sub));
      expect(failures.map((f) => f.filter(Boolean).join(" ")), "operator A holds authority it must not").toEqual([]);
      // and B's operator is the mirror image
      expect(kube.canI(opSa(nsB), "get", "secrets", nsA)).toBe(false);
      expect(kube.canI(opSa(nsB), "get", "secrets", nsB)).toBe(true);
      record("operator_separation", { canIMatrix: `${no.length} refusals and the control grants hold` });
    });

    it("A's operator, with its own real token, works in A and is refused in B", () => {
      const subject = operatorSubjectOf(nsA);
      const token = kube.must(["-n", subject.namespace, "create", "token", subject.name, "--duration=10m"]).trim();
      const cfg = tokenKubeconfig(kube, token);
      try {
        const ok = kube.run(["-n", nsA, "create", "secret", "generic", "op-made", "--from-literal=k=v"], { kubeconfig: cfg.path });
        expect(ok.code, ok.stderr).toBe(0);
        const label = kube.run(["label", "namespace", nsA, "zenith.dev/operator-touched=true", "--overwrite"], { kubeconfig: cfg.path });
        expect(label.code, `the operator may patch its own namespace: ${label.stderr}`).toBe(0);
        for (const args of [
          ["-n", nsB, "get", "secret", "b-secret"],
          ["-n", nsB, "get", "secrets"],
          ["-n", nsB, "delete", "pod", "victim"],
          ["-n", nsB, "get", "pvc"],
          ["label", "namespace", nsB, "zenith.dev/tenant=false", "--overwrite"],
          ["get", "namespaces"],
          ["-n", "kube-system", "get", "secrets"],
          ["-n", nsA, "create", "rolebinding", "grab", "--clusterrole=cluster-admin", `--serviceaccount=${subject.namespace}:${subject.name}`],
          ["-n", nsA, "exec", "svc-a", "--", "sh"],
        ]) {
          refusedBy(kube.run(args, { kubeconfig: cfg.path }), /forbidden/i, `operator A: kubectl ${args.join(" ")}`);
        }
      } finally {
        cfg.dispose();
      }
      // B's data is intact
      expect(kube.must(["-n", nsB, "get", "secret", "b-secret", "-o", "jsonpath={.metadata.name}"])).toBe("b-secret");
      record("operator_separation", { realToken: "works in A (create secret, patch own namespace); refused for B, cluster scope, kube-system, escalation and exec" });
    });

    it("a pod in A that names B's claim never gets B's volume", async () => {
      const made = kube.apply([{ apiVersion: "v1", kind: "PersistentVolumeClaim", metadata: { name: "data", namespace: nsB }, spec: { accessModes: ["ReadWriteOnce"], resources: { requests: { storage: "1Gi" } } } }]);
      expect(made.code, made.stderr).toBe(0);
      const r = kube.create(restrictedPod({ name: "steal", namespace: nsA, image, script: "sleep 600", restartPolicy: "Always", volumes: [{ name: "d", persistentVolumeClaim: { claimName: "data" } }], volumeMounts: [{ name: "d", mountPath: "/stolen" }] }));
      if (r.code !== 0) {
        record("storage", { crossTenantClaim: `refused at admission: ${r.stderr.trim().slice(0, 120)}` });
        return;
      }
      await sleep(20_000);
      const p = kube.json<any>(["-n", nsA, "get", "pod", "steal"]);
      expect(p?.status?.phase, "the pod must not run with a volume from another namespace").toBe("Pending");
      expect(kube.json<any>(["-n", nsA, "get", "pvc"])?.items ?? []).toHaveLength(0);
      deletePod(kube, nsA, "steal");
      record("storage", { crossTenantClaim: "pod stays Pending; A has no claim and B's claim is untouched" });
    }, LONG);
  });

  /* --------------------------------- sandbox runtime -------------------------- */

  describe("sandbox runtime", () => {
    it("a pod under the mandated RuntimeClass runs, and reports a different kernel surface from the node", async (ctx) => {
      if (!runtimeClass) {
        record("runtime", { status: "skipped", reason: "ZENITH_TEST_ISOLATION_RUNTIME_CLASS not set; the cluster has no sandbox runtime (kind does not)" });
        ctx.skip();
      }
      const r = await runPod(kube, { name: `rt-${run}`, namespace: nsA, image, runtimeClassName: runtimeClass, script: "uname -sr; dmesg 2>/dev/null | head -3 || true" });
      expect(r.phase, r.log).toBe("Succeeded");
      record("runtime", { runtimeClass, report: r.log.split("\n").slice(0, 4).join(" | ") });
    }, LONG);
  });

  /* ---------------------------- noisy neighbour (MAN-05) ---------------------- */

  describe("noisy neighbour: exhaustion by A is bounded and B's latency stays within the bound", () => {
    const hog = (name: string, script: string, resources: Record<string, unknown>) => restrictedPod({ name, namespace: nsA, image, script, resources, restartPolicy: name === "burn" || name === "pids" ? "Always" : "Never" });
    const res = (cpu: string, mem: string, extra: Record<string, string> = {}) => ({ requests: { cpu, memory: mem }, limits: { cpu, memory: mem, ...extra } });
    let baseline: LatencyStats;
    let loaded: LatencyStats;

    const measure = async (label: string, count: number): Promise<LatencyStats> => {
      const r = await runPod(kube, { name: `lat-${label}-${run}`, namespace: gwNs, image, script: latencyScript(`http://${victimIp}:8080/`, count, 40) }, 240_000);
      expect(r.phase, r.log).toBe("Succeeded");
      return parseLatency(r.log);
    };
    const usage = (): number | undefined => {
      const r = kube.run(["-n", nsA, "exec", "burn", "--", "sh", "-c", "cat /sys/fs/cgroup/cpu.stat 2>/dev/null | head -1 || cat /sys/fs/cgroup/cpuacct/cpuacct.usage"]);
      const v2 = /usage_usec (\d+)/.exec(r.stdout);
      if (v2) return Number(v2[1]);
      const v1 = /^(\d+)\s*$/.exec(r.stdout.trim());
      return v1 ? Number(v1[1]) / 1000 : undefined;
    };

    it("makes room on the free plan for the hogs", async () => {
      deletePod(kube, nsA, "svc-a");
      await sleep(3000);
    }, LONG);

    it("measures B's baseline latency through the gateway path", async () => {
      baseline = await measure("base", 200);
      record("noisy_neighbour", { baseline });
      expect(baseline.failures, "the baseline must be clean before any load").toBe(0);
      expect(baseline.n).toBeGreaterThan(100);
    }, LONG);

    it("A runs CPU, memory, disk and PID exhaustion at once; B's p95 stays within the bound and nothing of B's restarts", async () => {
      // only shell builtins after the fork bomb: at the limit nothing can fork, so counting is done with a glob and echo.
      // busybox sh exits on a failed fork, so the bomb runs in a subshell whose EXIT trap reports before it dies.
      const spawnPids = `(trap 'n=0; for d in /proc/[0-9]*; do n=$((n + 1)); done; echo "PIDS procs=$n attempts=$i"' EXIT; i=0; while [ $i -lt 3000 ]; do sleep 3600 & i=$((i + 1)); done) 2>/dev/null; exec sleep 3600`;
      const hogs = [
        hog("burn", "i=0; while [ $i -lt 4 ]; do (while :; do :; done) & i=$((i + 1)); done; wait", res("400m", "64Mi")),
        hog("memhog", `awk 'BEGIN { while (1) { a[n++] = sprintf("%1048576s", "x") } }'`, res("150m", "256Mi")),
        hog("diskhog", "dd if=/dev/zero of=/tmp/fill bs=1M count=400 2>/dev/null; echo FILLED; sleep 600", { requests: { cpu: "150m", memory: "64Mi", "ephemeral-storage": "32Mi" }, limits: { cpu: "150m", memory: "64Mi", "ephemeral-storage": "64Mi" } }),
        hog("pids", spawnPids, res("200m", "128Mi")),
      ];
      for (const h of hogs) {
        const r = kube.create(h);
        expect(r.code, `${(h as any).metadata.name}: ${r.stderr}`).toBe(0);
      }
      await eventually("the CPU hog to run", () => kube.json<any>(["-n", nsA, "get", "pod", "burn"])?.status?.phase === "Running" || undefined, { timeoutMs: 120_000 });
      await sleep(15_000);

      const u0 = usage();
      const t0 = Date.now();
      loaded = await measure("load", 250);
      const u1 = usage();
      const seconds = (Date.now() - t0) / 1000;
      const cpuCores = u0 !== undefined && u1 !== undefined ? (u1 - u0) / 1e6 / seconds : undefined;
      record("noisy_neighbour", { loaded, bound: latencyBound(baseline, factor, absMs), factor, absMs, burnerCpuCores: cpuCores, cpuLimitCores: 0.4, provisional: "latency bound is a provisional target, not a commercial commitment" });

      // each hog is bounded by its own mechanism
      expect(cpuCores, "CPU accounting must be available; absence is not a passed CPU isolation check").toBeDefined();
      expect(cpuCores!, "the CPU hog is held to its limit (CFS quota)").toBeLessThanOrEqual(0.4 * 1.3);
      const mem = await eventually("the memory hog to be killed", () => {
        const s = kube.json<any>(["-n", nsA, "get", "pod", "memhog"])?.status?.containerStatuses?.[0]?.state?.terminated;
        return s ? (s as { reason: string; exitCode: number }) : undefined;
      }, { timeoutMs: 180_000, intervalMs: 3000 });
      expect(mem.reason, "memory hog must be OOM killed").toBe("OOMKilled");
      const pidsLog = await eventually("the PID hog's report", () => {
        const l = kube.run(["-n", nsA, "logs", "pids"]).stdout;
        return /PIDS procs=/.test(l) ? l : undefined;
      }, { timeoutMs: 120_000, intervalMs: 3000 });
      const pm = /PIDS procs=(\d+) attempts=(\d+)/.exec(pidsLog);
      expect(pm, pidsLog).not.toBeNull();
      const pidCeiling = Number(process.env.ZENITH_TEST_ISOLATION_PIDS_MAX ?? "1024");
      expect(Number(pm![1]), "3000 fork attempts must be held by the kubelet's per-pod PID limit (set podPidsLimit); without it one tenant can exhaust the node's PIDs").toBeLessThanOrEqual(pidCeiling);
      record("noisy_neighbour", { pids: { processesReached: Number(pm![1]), forkAttempts: Number(pm![2]), ceiling: pidCeiling }, memory: mem.reason });

      // B: no failures, within the bound, never restarted, still Ready, nodes healthy
      expect(loaded.failures, "B must not drop a request while A is exhausting resources").toBe(0);
      expect(loaded.p95, `B p95 ${loaded.p95} ms vs baseline ${baseline.p95} ms and bound ${latencyBound(baseline, factor, absMs)} ms`).toBeLessThanOrEqual(latencyBound(baseline, factor, absMs));
      const v = kube.json<any>(["-n", nsB, "get", "pod", "victim"]);
      expect(v.status.containerStatuses[0].restartCount).toBe(0);
      expect(v.status.conditions.find((c: any) => c.type === "Ready")?.status).toBe("True");
      const notReady = (kube.json<any>(["get", "nodes"])?.items ?? []).filter((n: any) => n.status.conditions.find((c: any) => c.type === "Ready")?.status !== "True");
      expect(notReady.map((n: any) => n.metadata.name)).toEqual([]);

      // disk: the kubelet evicts the pod that wrote past its ephemeral-storage limit
      const disk = await eventually("the disk hog to be evicted", () => {
        const p = kube.json<any>(["-n", nsA, "get", "pod", "diskhog"]);
        return p?.status?.phase === "Failed" ? { reason: String(p.status.reason), message: String(p.status.message ?? "").slice(0, 160) } : undefined;
      }, { timeoutMs: 360_000, intervalMs: 5000 });
      record("noisy_neighbour", { disk });
      expect(disk.reason, `disk hog: ${disk.message}`).toBe("Evicted");
      expect(disk.message).toMatch(/ephemeral/i);
    }, LONG);

    it("the unbounded control: the same load with no quota or limits (recorded, not asserted; shows namespaces alone are not isolation)", async (ctx) => {
      if (process.env.ZENITH_TEST_ISOLATION_CONTROL !== "1") {
        record("noisy_neighbour", { control: "not run (set ZENITH_TEST_ISOLATION_CONTROL=1)" });
        ctx.skip();
      }
      const ns = `zenith-iso-ctl-${run}`;
      applyOk([{ apiVersion: "v1", kind: "Namespace", metadata: { name: ns, labels: { [RUN_LABEL]: run } } }]);
      const cores = Number(kube.must(["get", "nodes", "-o", "jsonpath={.items[0].status.capacity.cpu}"]).trim()) || 2;
      for (let i = 0; i < cores * 2; i++) {
        const r = kube.create(restrictedPod({ name: `loose-${i}`, namespace: ns, image, script: "while :; do :; done", restartPolicy: "Always" }));
        expect(r.code, r.stderr).toBe(0);
      }
      await sleep(15_000);
      const control = await measure("ctl", 250);
      record("noisy_neighbour", { control });
    }, LONG);
  });
});

if (!enabled) {
  describe("PROD-MAN-04/05 acceptance (gated)", () => {
    it.skip("skipped: set ZENITH_TEST_TENANT_ISOLATION=1 with KUBECONFIG, ZENITH_TEST_ISOLATION_PROFILE=kind-calico|kind-cilium|kind-existing and a digest-pinned ZENITH_TEST_K8S_IMAGE; run scripts/isolation/tenant-isolation-acceptance.sh", () => undefined);
  });
}
