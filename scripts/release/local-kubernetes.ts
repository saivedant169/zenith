/** Generated local fixture resources. Database and emulator are ClusterIP only. */
export const NAMESPACE = "zenith-j15";
type ObjectSpec = Record<string, unknown>;
const env = (values: Record<string, string>) => Object.entries(values).map(([name, value]) => ({ name, value }));
const service = (name: string, port: number): ObjectSpec => ({
  apiVersion: "v1", kind: "Service", metadata: { name, namespace: NAMESPACE },
  spec: { type: "ClusterIP", selector: { app: name }, ports: [{ port, targetPort: port }] },
});
function deployment(name: string, image: string, command: string[], values: Record<string, string>, volumes: string[], memory: string): ObjectSpec {
  return {
    apiVersion: "apps/v1", kind: "Deployment", metadata: { name, namespace: NAMESPACE },
    spec: { replicas: 1, selector: { matchLabels: { app: name } }, template: {
      metadata: { labels: { app: name } }, spec: {
        automountServiceAccountToken: false,
        securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000 },
        containers: [{ name, image, imagePullPolicy: "Never", command, env: env(values),
          securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } },
          resources: { requests: { cpu: "50m", memory: "64Mi" }, limits: { cpu: "500m", memory } },
          volumeMounts: [...volumes.map(v => ({ name: v, mountPath: v === "pki" ? "/pki" : "/config", readOnly: true })), { name: "tmp", mountPath: "/tmp" }] }],
        volumes: [...volumes.map(v => ({ name: v, secret: { secretName: v === "pki" ? `${name}-pki` : v, defaultMode: 288 } })), { name: "tmp", emptyDir: { sizeLimit: "64Mi" } }],
      },
    } },
  };
}
export function mixedObjects(input: { runId: string; image: string; postgresImage: string; localstackIp: string; variant: "lambda" | "container" }): ObjectSpec[] {
  if (!/^[a-z0-9][a-z0-9-]{3,19}$/.test(input.runId) || !/^\d+\.\d+\.\d+\.\d+$/.test(input.localstackIp)) throw new Error("Invalid fixture identity");
  const web = deployment("web", input.image, ["node", "web/server.mjs"], {
    HOST: "0.0.0.0", PORT: "8080", WEB_PROVIDER: "kind-web", STORE: "postgres",
    DATABASE_URL_FILE: "/config/database-url", DATABASE_CA_FILE: "/pki/ca.crt",
    DATABASE_CERT_FILE: "/pki/web.crt", DATABASE_KEY_FILE: "/pki/web.key",
    ENRICHER_URL: "https://enricher.zenith-j15.svc.cluster.local:8443",
    ENRICHER_CA_FILE: "/pki/ca.crt", ENRICHER_CERT_FILE: "/pki/web.crt", ENRICHER_KEY_FILE: "/pki/web.key",
    ENRICHER_TIMEOUT_MS: "10000",
  }, ["pki", "web-config"], "192Mi");
  const enricher = deployment("enricher", input.image, ["node", input.variant === "lambda" ? "enricher/local-lambda.mjs" : "enricher/server.mjs"], {
    ZENITH_LOCAL_TARGETS: "1", LOCALSTACK_URL: "http://localstack.zenith-j15.svc.cluster.local:4566",
    HOST: "0.0.0.0", PORT: "8443", ENRICHER_PROVIDER: "kind-container",
    ENRICHER_SERVER_CA_FILE: "/pki/ca.crt", ENRICHER_SERVER_CERT_FILE: "/pki/enricher.crt", ENRICHER_SERVER_KEY_FILE: "/pki/enricher.key",
  }, ["pki"], "192Mi");
  const db: ObjectSpec = {
    apiVersion: "apps/v1", kind: "Deployment", metadata: { name: "db", namespace: NAMESPACE },
    spec: { replicas: 1, strategy: { type: "Recreate" }, selector: { matchLabels: { app: "db" } }, template: {
      metadata: { labels: { app: "db" } }, spec: {
        automountServiceAccountToken: false, securityContext: { runAsUser: 70, runAsGroup: 70, fsGroup: 70, runAsNonRoot: true },
        containers: [{ name: "db", image: input.postgresImage, imagePullPolicy: "Never",
          args: ["postgres", "-c", "ssl=on", "-c", "ssl_cert_file=/pki/db.crt", "-c", "ssl_key_file=/pki/db.key", "-c", "ssl_ca_file=/pki/ca.crt", "-c", "hba_file=/config/pg_hba.conf", "-c", "shared_buffers=32MB", "-c", "max_connections=20"],
          env: env({ POSTGRES_DB: "mixed", POSTGRES_HOST_AUTH_METHOD: "reject", POSTGRES_PASSWORD_FILE: "/config/password", PGDATA: "/var/lib/postgresql/data/pgdata" }),
          // The entrypoint restarts an init-only server (socket, no TCP) before the real one; Ready waits for TCP.
          readinessProbe: { exec: { command: ["pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-d", "mixed"] }, periodSeconds: 2, failureThreshold: 60 },
          securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } },
          resources: { requests: { cpu: "50m", memory: "96Mi" }, limits: { cpu: "500m", memory: "256Mi" } },
          volumeMounts: [{ name: "data", mountPath: "/var/lib/postgresql/data" }, { name: "pki", mountPath: "/pki", readOnly: true }, { name: "db-config", mountPath: "/config", readOnly: true }, { name: "socket", mountPath: "/var/run/postgresql" }],
        }],
        volumes: [{ name: "data", emptyDir: { sizeLimit: "256Mi" } }, { name: "socket", emptyDir: {} }, { name: "pki", secret: { secretName: "db-pki", defaultMode: 288 } }, { name: "db-config", secret: { secretName: "db-config" } }],
      },
    } },
  };
  return [
    { apiVersion: "v1", kind: "Namespace", metadata: { name: NAMESPACE, labels: { "zenith.acceptance.owner": "j15", "zenith.acceptance.run": input.runId } } },
    web, enricher, db, service("web", 8080), service("enricher", 8443), service("db", 5432),
    { apiVersion: "v1", kind: "Service", metadata: { name: "localstack", namespace: NAMESPACE }, spec: { type: "ClusterIP", ports: [{ port: 4566, targetPort: 4566 }] } },
    { apiVersion: "v1", kind: "Endpoints", metadata: { name: "localstack", namespace: NAMESPACE }, subsets: [{ addresses: [{ ip: input.localstackIp }], ports: [{ port: 4566 }] }] },
    { apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy", metadata: { name: "database-private", namespace: NAMESPACE },
      spec: { podSelector: { matchLabels: { app: "db" } }, policyTypes: ["Ingress"], ingress: [{ from: [{ podSelector: { matchLabels: { app: "web" } } }], ports: [{ protocol: "TCP", port: 5432 }] }] } },
  ];
}
