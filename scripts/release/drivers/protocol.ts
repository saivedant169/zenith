/** Closed, sanitized evidence for DRV-4. Importing this module starts no engines. */
import { z } from "zod";
import { DATA_KINDS, DataProofSchema } from "./export-data-plan";

export const OPERATED_LABEL = "local_operated_rehearsal";
export const DRIVER_CHECKS = {
  "two-tenants": ["preconditions", "independent-tenants", "browser-approved-deployments", "provider-readback", "browser-read-isolation", "browser-write-isolation", "mcp-isolation", "foreign-approval-refused", "no-cross-tenant-effects", "source-stable", "owned-cleanup"],
  export: ["preconditions", "browser-approved-deployment", "provider-readback", "revision-export", "working-copy-divergence", "export-file-readback", "credential-absence", "browser-approved-teardown", "portable-plan", "portable-apply-readback", "data-preconditions", "postgres-data-roundtrip", "mysql-data-roundtrip", "object-store-data-roundtrip", "data-tenant-scoping", "adopt-release-retains", "adopt-destroy-teardown", "source-stable", "owned-cleanup"],
} as const;
export type DriverScenario = keyof typeof DRIVER_CHECKS;
const READBACKS: Record<DriverScenario, readonly string[]> = { "two-tenants": ["tenant-a", "tenant-b"], export: ["source", "bundle", "portable-plan", "portable", "adoption"] };
export type CheckStatus = "passed" | "failed" | "skipped";
export const DRIVER_LIMITS = {
  "two-tenants": [
    "Owned local operated rehearsal only. No live cloud, production signoff or commercial acceptance.",
    "kind uses a shared disposable cluster and namespaced fixture identity. This proves application authority and object ownership isolation, not hostile-cluster or network-policy isolation.",
    "No real customer identity, account or cross-cloud workload is exercised. J4 timer behavior is covered by its separate maintenance lane.",
  ],
  export: [
    "Owned local operated rehearsal only. No live cloud, production signoff or commercial acceptance.",
    "Local operated SQL/object data roundtrips plus LocalStack infrastructure export and independent OpenTofu1.12.5 apply. No vault value or access/session portability is claimed.",
    "LIFE-11 aws descriptors select the SQL/S3 compatibility engines for owned local containers. No AWS resource provisioning or real cloud-provider observation is claimed; a second real cloud provider remains live-deferred.",
    "J1 lean; database pairs run sequentially with two MinIO fixtures, settled before the 512 MiB LocalStack leg. Resource limits are plans, not measured host fitness; no production HA claim.",
    "The exported AWS~5/random~3 provider constraints are preserved; init needs the verifier's provider cache or registry downloads. No real cloud API is used.",
    "LIFE-11 adoption uses zero-replica out-of-band StatefulSets and claims in the shared kind namespace; it proves claim, release and teardown ownership, not database contents or cloud adoption.",
  ],
} as const satisfies Record<DriverScenario, readonly string[]>;
export type TenantExportReceiptBinding = { scenarioId: DriverScenario; runId: string; sourceCommit: string; sourceDigest: string };
export type LocalReceiptBinding<S extends string> = S extends DriverScenario
  ? { scenarioId: S; runId: string; sourceCommit: string; sourceDigest: string }
  : { scenarioId: S; runId: string; sourceCommit: string; sourceDigest?: string };
const Receipt = z.object({
  schema: z.literal(1), evidenceLabel: z.literal(OPERATED_LABEL),
  scenarioId: z.enum(["two-tenants", "export"]), runId: z.string().regex(/^[a-z0-9][a-z0-9-]{3,19}$/),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/), sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  checks: z.array(z.object({ id: z.string(), status: z.enum(["passed", "failed", "skipped"]) }).strict()),
  readbacks: z.record(z.string().regex(/^[a-z][a-z0-9-]{1,60}$/), z.string().regex(/^[a-f0-9]{64}$/)),
  dataRoundtrips: z.object({ postgres: DataProofSchema.optional(), mysql: DataProofSchema.optional(), object_store: DataProofSchema.optional() }).strict().optional(),
  limits: z.array(z.string().min(1).max(300)).min(1),
}).strict();
export type OperatedReceipt = z.infer<typeof Receipt>;
export function validateOperatedReceipt(raw: unknown, expected: { scenarioId: string; runId: string; sourceCommit: string; sourceDigest: string }): OperatedReceipt {
  const receipt = Receipt.parse(raw);
  for (const key of ["scenarioId", "runId", "sourceCommit", "sourceDigest"] as const) if (receipt[key] !== expected[key]) throw new Error("Operated receipt binding mismatch");
  if (JSON.stringify(receipt.limits) !== JSON.stringify(DRIVER_LIMITS[receipt.scenarioId])) throw new Error("Operated receipt limitations mismatch");
  const required: readonly string[] = DRIVER_CHECKS[receipt.scenarioId];
  if (receipt.checks.length !== required.length || receipt.checks.some((check, index) => check.id !== required[index])) throw new Error("Operated receipt check inventory mismatch");
  const keys = Object.keys(receipt.readbacks), readbacks = READBACKS[receipt.scenarioId];
  if (keys.some(key => !readbacks.includes(key)) || (receipt.checks.every(check => check.status === "passed") && readbacks.some(key => !keys.includes(key)))) throw new Error("Independent readback inventory mismatch");
  if (receipt.scenarioId === "two-tenants" && receipt.dataRoundtrips) throw new Error("Unexpected data evidence");
  if (receipt.scenarioId === "export") {
    for (const kind of DATA_KINDS) {
      const proof = receipt.dataRoundtrips?.[kind];
      const check = receipt.checks.find(c => c.id === `${kind.replace("_", "-")}-data-roundtrip`)!;
      if (check.status === "passed" && !proof) throw new Error("Missing data roundtrip witness");
      if (proof && proof.mysqlTls !== (kind === "mysql" ? "verified_identity" : "not_applicable")) throw new Error("TLS witness mismatch");
    }
  }
  return receipt;
}
/** Register before mutation. Attempt every owned cleanup even after one fails. */
export class CleanupBlocker {
  private blocked = false;
  block(): void { this.blocked = true; }
  get isBlocked(): boolean { return this.blocked; }
}
export async function settleAfterQuiescence(quiescence: OwnedCleanup, cleanup: OwnedCleanup, blocker: CleanupBlocker): Promise<{ quiesced: boolean; clean: boolean }> {
  const quiesced = await quiescence.settle() && !blocker.isBlocked;
  if (!quiesced) blocker.block();
  const clean = await cleanup.settle();
  return { quiesced, clean: quiesced && clean };
}
export class OwnedCleanup {
  private jobs: (() => Promise<void>)[] = [];
  constructor(private readonly blocker?: CleanupBlocker) {}
  add(work: () => Promise<void>): void { this.jobs.push(work); }
  async settle(): Promise<boolean> {
    let clean = true;
    while (this.jobs.length) {
      if (this.blocker?.isBlocked) return false;
      const work = this.jobs.pop()!;
      try { await work(); } catch { clean = false; }
    }
    return clean;
  }
}
export function receiptExit(receipt: OperatedReceipt): number {
  return receipt.checks.some(check => check.status === "failed") ? 1 : receipt.checks.some(check => check.status === "skipped") ? 3 : 0;
}
