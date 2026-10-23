/**
 * Level-3 native shapes for Kubernetes workloads that have persistent data or a
 * schedule (PROD-LIFE-07): `k8s:StatefulSet` and `k8s:CronJob`.
 *
 * They are native types, not new portable kinds: a portable `container_service`
 * is a stateless Deployment on every provider, and widening that for one
 * provider would change what the other five mean. A manifest asks for these
 * explicitly through `native[]`; the Kubernetes renderer turns the parsed config
 * into the StatefulSet (+ headless Service) or CronJob, and the Kubernetes
 * drivers observe, verify and operate them like any other node.
 *
 * Schemas are strict: an unknown key is a typo or an attack, never something to
 * pass to the API server. Anything that could destroy data needs an explicit
 * acknowledgement in the config itself.
 */
import { z } from "zod";

const DNS_LABEL = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
const IMAGE = /^[A-Za-z0-9][A-Za-z0-9._\-/:@]{0,254}$/;
const ENV_KEY = /^[-._a-zA-Z][-._a-zA-Z0-9]*$/;
const STORAGE_CLASS = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;
const MOUNT_PATH = /^\/[A-Za-z0-9._\-/]{0,254}$/;

const Argv = z.array(z.string().min(1).max(512)).min(1).max(32);

const EnvEntry = z.union([
  z.object({ key: z.string().regex(ENV_KEY).max(253), value: z.string().max(4096) }).strict(),
  z.object({ key: z.string().regex(ENV_KEY).max(253), secretRef: z.string().min(3).max(500) }).strict(),
]);

/** Required: drivers read and operate without the graph, so the namespace must be in the node. */
const Namespace = z.string().regex(DNS_LABEL);
const Image = z.string().regex(IMAGE);
const Vcpu = z.number().min(0.001).max(256);
const MemoryMb = z.number().int().min(4).max(1_048_576);

export const VolumeClaimConfig = z
  .object({
    /** the claim template name; PVCs are `<name>-<statefulset>-<ordinal>` */
    name: z.string().regex(DNS_LABEL).max(40),
    mountPath: z
      .string()
      .regex(MOUNT_PATH)
      .refine((p) => p !== "/" && p !== "/tmp" && !p.split("/").includes(".."), { message: "mountPath must be an absolute path other than / and /tmp, without .." }),
    sizeGb: z.number().int().min(1).max(16_384),
    storageClass: z.string().regex(STORAGE_CLASS).optional(),
    accessModes: z.array(z.enum(["ReadWriteOnce", "ReadWriteOncePod", "ReadOnlyMany", "ReadWriteMany"])).min(1).max(4).optional(),
  })
  .strict();
export type VolumeClaimConfig = z.infer<typeof VolumeClaimConfig>;

export const RetentionConfig = z
  .object({
    whenDeleted: z.enum(["Retain", "Delete"]).prefault("Retain"),
    whenScaled: z.enum(["Retain", "Delete"]).prefault("Retain"),
    /** required when either policy is Delete: the claims (the data) are then removed by the cluster */
    acknowledgeDataLoss: z.boolean().optional(),
  })
  .strict()
  .refine((r) => (r.whenDeleted === "Retain" && r.whenScaled === "Retain") || r.acknowledgeDataLoss === true, {
    message: "a Delete retention policy removes the persistent volumes' data; set acknowledgeDataLoss: true to accept that",
    path: ["acknowledgeDataLoss"],
  });
export type RetentionConfig = z.infer<typeof RetentionConfig>;

export const StatefulRolloutConfig = z
  .object({
    /** ordinals >= partition receive the new revision; 0 updates everything. Higher ordinals update first. */
    partition: z.number().int().min(0).max(1000).prefault(0),
    minReadySeconds: z.number().int().min(0).max(3600).prefault(0),
    podManagementPolicy: z.enum(["OrderedReady", "Parallel"]).prefault("OrderedReady"),
    /** rollback needs the previous revision, so at least two are kept */
    revisionHistoryLimit: z.number().int().min(2).max(50).prefault(10),
  })
  .strict();
export type StatefulRolloutConfig = z.infer<typeof StatefulRolloutConfig>;

export const StatefulSetNativeConfig = z
  .object({
    namespace: Namespace,
    image: Image,
    command: Argv.optional(),
    args: z.array(z.string().max(512)).max(32).optional(),
    replicas: z.number().int().min(0).max(100).prefault(1),
    port: z.number().int().min(1).max(65_535).optional(),
    /** HTTP readiness/liveness path; requires port */
    healthPath: z.string().min(1).max(512).optional(),
    /** exec readiness probe, for workloads that do not speak HTTP */
    readinessCommand: Argv.optional(),
    env: z.array(EnvEntry).max(100).optional(),
    vcpu: Vcpu,
    memoryMb: MemoryMb,
    volumeClaims: z.array(VolumeClaimConfig).min(1).max(8),
    retention: RetentionConfig.prefault({}),
    rollout: StatefulRolloutConfig.prefault({}),
    /** a numeric non-root uid; required for images that declare no non-root USER */
    runAsUser: z.number().int().min(1).max(65_535).optional(),
    /** group that owns the mounted volumes; defaults to runAsUser */
    fsGroup: z.number().int().min(1).max(65_535).optional(),
    zones: z.number().int().min(1).max(10).optional(),
    terminationGracePeriodSeconds: z.number().int().min(0).max(3600).prefault(30),
  })
  .strict()
  .superRefine((c, ctx) => {
    const names = new Set<string>();
    const paths = new Set<string>();
    c.volumeClaims.forEach((v, i) => {
      if (names.has(v.name)) ctx.addIssue({ code: "custom", message: `duplicate volume claim "${v.name}"`, path: ["volumeClaims", i, "name"] });
      names.add(v.name);
      if (paths.has(v.mountPath)) ctx.addIssue({ code: "custom", message: `mountPath ${v.mountPath} is used twice`, path: ["volumeClaims", i, "mountPath"] });
      paths.add(v.mountPath);
    });
    if (c.healthPath !== undefined && c.port === undefined) ctx.addIssue({ code: "custom", message: "healthPath needs a port", path: ["healthPath"] });
    if (c.healthPath !== undefined && c.readinessCommand !== undefined) ctx.addIssue({ code: "custom", message: "set healthPath or readinessCommand, not both", path: ["readinessCommand"] });
  });
export type StatefulSetNativeConfig = z.infer<typeof StatefulSetNativeConfig>;

export const CronJobNativeConfig = z
  .object({
    namespace: Namespace,
    image: Image,
    command: Argv.optional(),
    args: z.array(z.string().max(512)).max(32).optional(),
    env: z.array(EnvEntry).max(100).optional(),
    vcpu: Vcpu,
    memoryMb: MemoryMb,
    schedule: z.string().min(1).max(100).optional(),
    suspend: z.boolean().optional(),
    concurrencyPolicy: z.enum(["Allow", "Forbid", "Replace"]).optional(),
    startingDeadlineSeconds: z.number().int().min(10).max(86_400).optional(),
    successfulJobsHistoryLimit: z.number().int().min(0).max(100).optional(),
    failedJobsHistoryLimit: z.number().int().min(0).max(100).optional(),
    backoffLimit: z.number().int().min(0).max(20).optional(),
    activeDeadlineSeconds: z.number().int().min(1).max(604_800).optional(),
    ttlSecondsAfterFinished: z.number().int().min(60).max(2_592_000).optional(),
    timeZone: z.string().max(64).optional(),
    runAsUser: z.number().int().min(1).max(65_535).optional(),
  })
  .strict();
export type CronJobNativeConfig = z.infer<typeof CronJobNativeConfig>;
