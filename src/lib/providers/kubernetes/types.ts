/**
 * Shared vocabulary of the Kubernetes provider drivers (ADR-0015).
 *
 * Ownership is explicit and never inferred. Every object Zenith renders
 * carries:
 *   labels       app.kubernetes.io/managed-by = zenith
 *                app.kubernetes.io/part-of    = <environment, label-safe>
 *   annotations  zenith.dev/resource    = <node address>         (exact)
 *                zenith.dev/environment = <environment id>       (exact)
 *                zenith.dev/spec-digest = <node specDigest>
 * The LABEL is how objects are listed (selectors); the ANNOTATION is what
 * ownership decisions compare, because label values cannot hold every
 * environment id or address.
 *
 * Two field managers, both Zenith's:
 *   `zenith`      declarative apply (render → server-side apply). Only this
 *                 manager ever applies a node's full desired object.
 *   `zenith-ops`  day-two operations (restart annotation, rollback marker
 *                 excepted). Server-side apply with ONE manager replaces that
 *                 manager's whole applied set, so a partial apply under
 *                 `zenith` (just the restart annotation) would DELETE every
 *                 other field `zenith` owns. Operations therefore use a sibling
 *                 manager that owns only the fields it sets. See `ops.ts`.
 *
 * Honest limit: nothing here has been run against a real API server in this
 * repository's default test run. The real-cluster file
 * (`tests/providers/kubernetes/kind.test.ts`) is gated behind ZENITH_TEST_KIND.
 */
import type { ArtifactSpec } from "@/lib/resources/specs";
import type { ResourceNode } from "@/lib/resources/types";

export const FIELD_MANAGER = "zenith";
export const OPS_FIELD_MANAGER = "zenith-ops";

export const LABEL = {
  managedBy: "app.kubernetes.io/managed-by",
  partOf: "app.kubernetes.io/part-of",
  name: "app.kubernetes.io/name",
  component: "app.kubernetes.io/component",
  tier: "zenith.dev/tier",
} as const;

export const ANNOTATION = {
  resource: "zenith.dev/resource",
  environment: "zenith.dev/environment",
  specDigest: "zenith.dev/spec-digest",
  /** the vault reference a Secret's data is resolved from at apply time; never a value */
  secretRef: "zenith.dev/secret-ref",
  honestyNote: "zenith.dev/honesty-note",
  lastOperation: "zenith.dev/last-operation",
  /** the operation id of the last rollback applied, for idempotent retries */
  lastRollback: "zenith.dev/last-rollback",
  fenceToken: "zenith.dev/fence-token",
  dnsZone: "zenith.dev/dns-zone",
  /** set by the Deployment controller; the rollback history key */
  revision: "deployment.kubernetes.io/revision",
  /** the field `kubectl rollout restart` patches */
  restartedAt: "kubectl.kubernetes.io/restartedAt",
} as const;

export const MANAGED_BY_VALUE = "zenith";
export const TIER_DEV_ONLY = "dev-only";
/** Secret data key every Zenith-rendered Secret uses */
export const SECRET_DATA_KEY = "value";

/* -------------------------------- objects --------------------------------- */

export interface K8sMetadata {
  name: string;
  namespace?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  [extra: string]: unknown;
}

/** A Kubernetes object as plain JSON (what is rendered, applied and read back). */
export interface K8sObject {
  apiVersion: string;
  kind: string;
  metadata: K8sMetadata;
  spec?: Record<string, unknown>;
  [extra: string]: unknown;
}

export interface ObjectRef {
  apiVersion: string;
  kind: string;
  /** absent for cluster-scoped kinds (Namespace) */
  namespace?: string;
  name: string;
}

/**
 * The kinds Zenith renders, applies, prunes and reads. Anything else is refused
 * at the apply boundary: least privilege means Zenith only writes shapes it
 * produced itself.
 */
export const KIND_INFO = {
  Namespace: { apiVersion: "v1", namespaced: false },
  ServiceAccount: { apiVersion: "v1", namespaced: true },
  Role: { apiVersion: "rbac.authorization.k8s.io/v1", namespaced: true },
  RoleBinding: { apiVersion: "rbac.authorization.k8s.io/v1", namespaced: true },
  ResourceQuota: { apiVersion: "v1", namespaced: true },
  LimitRange: { apiVersion: "v1", namespaced: true },
  Secret: { apiVersion: "v1", namespaced: true },
  PersistentVolumeClaim: { apiVersion: "v1", namespaced: true },
  Service: { apiVersion: "v1", namespaced: true },
  NetworkPolicy: { apiVersion: "networking.k8s.io/v1", namespaced: true },
  StatefulSet: { apiVersion: "apps/v1", namespaced: true },
  Deployment: { apiVersion: "apps/v1", namespaced: true },
  CronJob: { apiVersion: "batch/v1", namespaced: true },
  HorizontalPodAutoscaler: { apiVersion: "autoscaling/v2", namespaced: true },
  Certificate: { apiVersion: "cert-manager.io/v1", namespaced: true },
  Ingress: { apiVersion: "networking.k8s.io/v1", namespaced: true },
  HTTPRoute: { apiVersion: "gateway.networking.k8s.io/v1", namespaced: true },
  DNSEndpoint: { apiVersion: "externaldns.k8s.io/v1alpha1", namespaced: true },
} as const;
export type SupportedKind = keyof typeof KIND_INFO;

/**
 * Apply order: a namespace before what lives in it, identities and secrets
 * before the workloads that mount them, backends before the ingress that
 * routes to them. Prune runs in reverse.
 */
export const APPLY_ORDER: readonly SupportedKind[] = [
  "Namespace",
  "ServiceAccount",
  "Role",
  "RoleBinding",
  "ResourceQuota",
  "LimitRange",
  "Secret",
  "PersistentVolumeClaim",
  "NetworkPolicy",
  "Service",
  "StatefulSet",
  "Deployment",
  "CronJob",
  "HorizontalPodAutoscaler",
  "Certificate",
  "Ingress",
  "HTTPRoute",
  "DNSEndpoint",
];

/**
 * Kinds that are never deleted by automatic prune; an orphan is REPORTED.
 *   PersistentVolumeClaim / StatefulSet: they hold data rollback cannot restore.
 *   Namespace: deleting it cascades to every object inside, including objects
 *     Zenith does not own.
 */
export const NEVER_AUTO_PRUNE: readonly SupportedKind[] = ["PersistentVolumeClaim", "StatefulSet", "Namespace"];

export const refKey = (r: Pick<ObjectRef, "kind" | "namespace" | "name">): string => `${r.kind}|${r.namespace ?? ""}|${r.name}`;

export const refOf = (o: { apiVersion?: string; kind?: string; metadata?: { name?: string; namespace?: string } }): ObjectRef => ({
  apiVersion: o.apiVersion ?? "v1",
  kind: o.kind ?? "",
  ...(o.metadata?.namespace ? { namespace: o.metadata.namespace } : {}),
  name: o.metadata?.name ?? "",
});

export const isSupportedKind = (k: string): k is SupportedKind => Object.prototype.hasOwnProperty.call(KIND_INFO, k);

/* --------------------------------- errors --------------------------------- */

export type K8sErrorCode =
  | "invalid_object"
  | "render_error"
  | "ownership_conflict"
  | "field_conflict"
  | "namespace_forbidden"
  | "secret_unresolved"
  | "not_found"
  | "forbidden"
  | "unauthorized"
  | "invalid"
  | "api_error"
  | "unreachable"
  | "aborted"
  | "timeout"
  | "session_invalid"
  | "session_expired"
  | "unsupported"
  | "rollback_unavailable"
  | "bad_input";

/** A failure with a stable code and a message that is safe to show (no secret values, no tokens). */
export class K8sError extends Error {
  readonly code: K8sErrorCode;
  readonly status?: number;
  constructor(code: K8sErrorCode, message: string, status?: number) {
    super(message);
    this.name = "K8sError";
    this.code = code;
    this.status = status;
  }
}

/* ------------------------------ apply results ----------------------------- */

export type ApplyStatus = "created" | "configured" | "unchanged" | "conflict" | "ownership_conflict" | "error" | "skipped";

export interface FieldConflict {
  /** `.spec.replicas` */
  field: string;
  /** the other field manager, when the API named it */
  manager?: string;
}

export interface ApplyItemResult {
  ref: ObjectRef;
  status: ApplyStatus;
  /** never contains secret values */
  message?: string;
  errorCode?: K8sErrorCode;
  conflicts?: FieldConflict[];
  uid?: string;
  resourceVersion?: string;
  generation?: number;
}

export interface ApplyReport {
  /** true when every item is created / configured / unchanged */
  ok: boolean;
  dryRun: boolean;
  /** true when preflight refused the whole batch (ownership conflict); nothing was applied */
  refused: boolean;
  results: ApplyItemResult[];
}

/* --------------------------- render configuration -------------------------- */

/**
 * Everything the renderer may depend on besides the node itself. All of it is
 * deterministic input: the same node + context renders byte-identical objects.
 */
export interface K8sRenderContext {
  environmentId: string;
  /** graph access, for neighbours (network namespace, firewall targets, LB backends, identity) */
  node?(address: string): ResourceNode | undefined;
  nodes?(): readonly ResourceNode[];
  /** override the namespace this node renders into (otherwise spec.namespace, the network node's, or the environment default) */
  namespace?: string;
  /** the connection allowlist: operator-provisioned namespaces, where deny policies select only this environment's pods */
  provisionedNamespaces?: readonly string[];
  /** turn an artifact into an image reference; `built`/`blueprint` artifacts have none until a build exists */
  resolveImage?(node: ResourceNode, artifact: ArtifactSpec): string | undefined;
  /** hostname or IP a DNS record should point at (the load balancer's observed address) */
  resolveDnsTarget?(targetAddress: string): string | undefined;
  /** cert-manager ClusterIssuer names (cluster prerequisites Zenith does not install) */
  clusterIssuers?: { dns01?: string; http01?: string };
  /** namespace of the ingress controller, so default-deny does not cut it off from the pods it fronts */
  ingressControllerNamespace?: string;
  /** render a HorizontalPodAutoscaler (and then leave Deployment.spec.replicas to it) when replicas > 1 */
  autoscale?: boolean;
  /** default true; an emptyDir is mounted at /tmp when true */
  readOnlyRootFilesystem?: boolean;
  /** force a numeric uid; otherwise the image's own non-root USER is required by runAsNonRoot */
  runAsUser?: number;
  /** default false */
  automountServiceAccountToken?: boolean;
  /** Explicit cluster and authentication mechanism; never inferred from a cloud resource's name. */
  workloadIdentity?: { cluster: string; mechanism: "eks-irsa" | "eks-pod-identity" | "gke" | "aks" };
  /** Resolved, non-secret published cloud attributes: AWS `arn`, GCP `email`, Azure `client_id`. Unresolved values render no annotation. */
  resolveAttribute?(address: string, attribute: string): unknown;
  /**
   * Where the cluster's DNS pods live, for the egress allow a default-deny egress namespace needs.
   * Defaults to kube-system pods labeled k8s-app=kube-dns (CoreDNS and kube-dns on EKS, GKE, AKS, OKE and kind).
   */
  dns?: { namespace?: string; podLabels?: Record<string, string> };
}

export interface RenderResult {
  objects: K8sObject[];
  /** plain-language explanations of anything approximated, unsupported or left to the cluster */
  notes: string[];
}
