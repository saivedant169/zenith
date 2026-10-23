import { digest } from "@/lib/controlplane/digest";
import type { K8sObject } from "../types";
import { configDigest, proxyUrl, validateConfig, type IsolatedBuildConfig } from "./config";

export const BUILD_NODE_LABEL = "zenith.node-restriction.kubernetes.io/build-tenant";
export const BUILD_PROFILE_LABEL = "zenith.node-restriction.kubernetes.io/build-profile";
export const BUILD_TAINT = "zenith.dev/build-tenant";
export const BUILD_ACCOUNT = "zenith-builder";
export const LIMITS = { cpu: "2", memory: "4Gi", "ephemeral-storage": "4Gi" } as const;
export interface BuildRequest {
  workspaceId: string; environmentId: string; operationId: string; serviceAddress: string; pipelineAddress: string;
  sourceSecret: string; sourceDigest: string; image: string; dockerfile: string; contextDir: string; idempotencyKey: string;
}
export const buildKey = (r: BuildRequest): string => digest(r);
export const buildName = (r: BuildRequest): string => `zbuild-${buildKey(r).slice(0, 40)}`;
export const sourceName = (environmentId: string, sha256: string): string => `zsrc-${digest(["zenith-source", environmentId, sha256]).slice(0, 40)}`;
export const annotationsFor = (r: BuildRequest, c: IsolatedBuildConfig) => ({
  "zenith.dev/environment": r.environmentId, "zenith.dev/resource": r.serviceAddress,
  "zenith.dev/workspace-id": r.workspaceId, "zenith.dev/build-key": buildKey(r),
  "zenith.dev/source-digest": r.sourceDigest, "zenith.dev/build-config": configDigest(c),
});

export function renderBaseline(raw: IsolatedBuildConfig): K8sObject[] {
  const c = validateConfig(raw), meta = (name: string) => ({ name, namespace: c.namespace });
  return [
    { apiVersion: "v1", kind: "Namespace", metadata: { name: c.namespace, labels: { "zenith.dev/isolated-build": "true", "pod-security.kubernetes.io/enforce": "baseline" } } },
    { apiVersion: "v1", kind: "ServiceAccount", metadata: meta(BUILD_ACCOUNT), automountServiceAccountToken: false },
    { apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy", metadata: meta("zenith-build-default-deny"), spec: { podSelector: {}, policyTypes: ["Ingress", "Egress"] } }, // no rules = deny all; the API server drops empty rule lists
    { apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy", metadata: meta("zenith-build-proxy-only"), spec: { podSelector: {}, policyTypes: ["Egress"], egress: [{ to: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": c.proxy.namespace } }, podSelector: { matchLabels: { app: "zenith-build-proxy" } } }], ports: [{ protocol: "TCP", port: c.proxy.port }] }] } },
    { apiVersion: "v1", kind: "ResourceQuota", metadata: meta("zenith-build-quota"), spec: { hard: { pods: "2", "requests.cpu": "1", "requests.memory": "1Gi", "limits.cpu": "4", "limits.memory": "8Gi", "requests.ephemeral-storage": "2Gi", "limits.ephemeral-storage": "8Gi", "count/jobs.batch": "4", "count/secrets": "8" } } },
  ];
}

export function renderJob(raw: IsolatedBuildConfig, r: BuildRequest, probe = false, nodeName?: string): K8sObject {
  const c = validateConfig(raw), name = `${buildName(r)}${probe ? "-probe" : ""}`, annotations = annotationsFor(r, c);
  const registry = new URL(`https://${r.image.split("/")[0]}`);
  const destination = c.proxy.destinations.find(d => d.host === registry.hostname && d.port === Number(registry.port || "443"));
  const env = [
    { name: "HTTP_PROXY", value: proxyUrl(c) }, { name: "HTTPS_PROXY", value: proxyUrl(c) }, { name: "NO_PROXY" }, // set to empty; the API server drops value: ""
    { name: "XDG_RUNTIME_DIR", value: "/run/user/1000" }, { name: "HOME", value: "/home/user" }, { name: "DOCKER_CONFIG", value: "/registry-auth" },
    { name: "ZENITH_BUILD_ID", value: "zenith-isolated:" + configDigest(c) + ":" + buildKey(r) },
    { name: "ZENITH_REGISTRY_PROBE_URL", value: (destination?.tls === false ? "http://" : "https://") + registry.host + "/v2/" },
    { name: "ZENITH_REGISTRY_PROBE_ENDPOINT", value: destination ? destination.ip + ":" + destination.port : "" },
  ];
  const args = probe ? ["probe", r.sourceDigest] : ["build", r.sourceDigest, r.contextDir, r.dockerfile, r.image, destination?.tls === false ? "http" : "https"];
  const paths: Record<string, string> = { work: "/work", run: "/run/user/1000", tmp: "/tmp", home: "/home/user" };
  return {
    apiVersion: "batch/v1", kind: "Job", metadata: { name, namespace: c.namespace, labels: { "app.kubernetes.io/managed-by": "zenith" }, annotations },
    spec: { backoffLimit: 0, completions: 1, parallelism: 1, activeDeadlineSeconds: probe ? 180 : c.timeoutSec, ttlSecondsAfterFinished: 3600,
      template: { metadata: { labels: { "zenith.dev/isolated-build": "true" }, annotations }, spec: {
        // hostNetwork/hostPID/hostIPC default false and the API server drops explicit false; assertPod refuses true.
        runtimeClassName: c.runtimeClass, hostUsers: false, shareProcessNamespace: false,
        // Affinity remains effective even for a node-bound build; never bypass the scheduler with nodeName.
        nodeSelector: { [BUILD_NODE_LABEL]: c.nodeIsolation.tenant, [BUILD_PROFILE_LABEL]: c.nodeIsolation.profileDigest.slice(0, 63), ...(nodeName ? { "kubernetes.io/hostname": nodeName } : {}) },
        tolerations: ["NoSchedule", "NoExecute"].map(effect => ({ key: BUILD_TAINT, operator: "Equal", value: c.nodeIsolation.tenant, effect })),
        automountServiceAccountToken: false, serviceAccountName: BUILD_ACCOUNT, enableServiceLinks: false, restartPolicy: "Never",
        securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000, fsGroupChangePolicy: "OnRootMismatch" },
        containers: [{ name: "build", image: c.builderImage, command: ["/usr/local/bin/zenith-builder"], args, env,
          securityContext: {
            privileged: false, readOnlyRootFilesystem: true,
            // UID helpers require setuid INSIDE the mandatory outer pod user namespace.
            allowPrivilegeEscalation: true, capabilities: { drop: ["ALL"], add: ["SETUID", "SETGID"] }, procMount: "Unmasked",
            seccompProfile: { type: "Localhost", localhostProfile: c.seccompProfile }, appArmorProfile: { type: "Localhost", localhostProfile: c.appArmorProfile },
          },
          resources: { requests: { cpu: "250m", memory: "256Mi", "ephemeral-storage": "512Mi" }, limits: LIMITS },
          terminationMessagePath: "/dev/termination-log", terminationMessagePolicy: "File",
          volumeMounts: [{ name: "source", mountPath: "/source", readOnly: true },
            ...Object.entries(paths).map(([name, mountPath]) => ({ name, mountPath })),
            ...(c.pushSecret && !probe ? [{ name: "registry-auth", mountPath: "/registry-auth", readOnly: true }] : []),
          ],
        }],
        volumes: [{ name: "source", secret: { secretName: r.sourceSecret, defaultMode: 0o444 } },
          ...Object.keys(paths).map(name => ({ name, emptyDir: { sizeLimit: name === "work" ? "2Gi" : "512Mi" } })),
          ...(c.pushSecret && !probe ? [{ name: "registry-auth", secret: { secretName: c.pushSecret, defaultMode: 0o440, items: [{ key: ".dockerconfigjson", path: "config.json" }] } }] : []),
        ],
      } },
    },
  };
}

export function renderProxy(raw: IsolatedBuildConfig): K8sObject[] {
  const c = validateConfig(raw), ns = c.proxy.namespace, labels = { app: "zenith-build-proxy" };
  const metadata = (name: string) => ({ name, namespace: ns });
  return [
    { apiVersion: "v1", kind: "Namespace", metadata: { name: ns, labels: { "pod-security.kubernetes.io/enforce": "restricted" } } },
    { apiVersion: "v1", kind: "ConfigMap", metadata: metadata("zenith-build-proxy"), immutable: true, data: { "allowlist.json": JSON.stringify(c.proxy.destinations) } },
    { apiVersion: "apps/v1", kind: "Deployment", metadata: metadata("zenith-build-proxy"), spec: { replicas: 1, selector: { matchLabels: labels }, template: { metadata: { labels }, spec: {
      automountServiceAccountToken: false, enableServiceLinks: false, securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, seccompProfile: { type: "RuntimeDefault" } },
      containers: [{ name: "proxy", image: c.proxy.image, command: ["python", "-B", "/app/proxy.py", "/config/allowlist.json", String(c.proxy.port)],
        securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } },
        resources: { requests: { cpu: "50m", memory: "32Mi" }, limits: { cpu: "250m", memory: "128Mi", "ephemeral-storage": "128Mi" } },
        volumeMounts: [{ name: "config", mountPath: "/config", readOnly: true }],
      }], volumes: [{ name: "config", configMap: { name: "zenith-build-proxy" } }],
    } } } },
    { apiVersion: "v1", kind: "Service", metadata: metadata("zenith-build-proxy"), spec: { clusterIP: c.proxy.ip, selector: labels, ports: [{ port: c.proxy.port, targetPort: c.proxy.port, protocol: "TCP" }] } },
    { apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy", metadata: metadata("zenith-build-proxy"), spec: { podSelector: {}, policyTypes: ["Ingress", "Egress"],
      ingress: [{ from: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": c.namespace } } }], ports: [{ port: c.proxy.port, protocol: "TCP" }] }],
      egress: [...c.proxy.destinations.map(d => ({ to: [{ ipBlock: { cidr: `${d.ip}/32` } }], ports: [{ port: d.port, protocol: "TCP" }] })),
        { to: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "kube-system" } }, podSelector: { matchLabels: { "k8s-app": "kube-dns" } } }], ports: [{ port: 53, protocol: "UDP" }, { port: 53, protocol: "TCP" }] },
      ],
    } },
  ];
}




