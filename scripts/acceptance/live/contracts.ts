/** AWS fixtures are provider acceptance, never substitutes for product journeys. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Family = "s3" | "iam" | "lambda" | "ecs" | "rds" | "dns";
/** Scenario-specific plans (owner decision D3). "fixtures" is the full plan and the default. */
export const SCENARIOS = ["fixtures", "retention-s3", "rel-04", "mix-03", "deploy-01", "teardown-01", "ops-06", "ops-04", "ops-05", "ops-03"] as const;
export type Scenario = (typeof SCENARIOS)[number];
export interface Call {
  id: string;
  service: string;
  command: string;
  action: string;
  resource: string;
  input: Record<string, Json>;
  maximumCalls: number;
}
export interface Fixture {
  family: Family;
  dependsOn: Family[];
  setup: Call[];
  observe: Call[];
  teardown: Call[];
  leak: Call[];
  ownership: Call;
  /** Independent readback calls a ProductScenarioPort makes after product work. Never run automatically; absent in "fixtures". */
  product?: Call[];
}
export interface Settings {
  accountId: string;
  region: string;
  runId: string;
  durationMinutes: number;
  dbSubnetGroup: string;
  dbSecurityGroup: string;
  workloadBoundaryArn: string;
  /** Absent means "fixtures", so existing fixtures digests stay byte-identical. */
  scenario?: Scenario;
  /** Absent means the "-live" sandbox lane, so existing digests stay byte-identical. "live2" uses the -live2 connection stack. */
  lane?: "live2";
}
export interface Plan {
  schema: 1;
  settings: Settings;
  tags: Record<string, string>;
  fixtures: Fixture[];
  preflight: Call[];
  /** Product-scope calls (mix-03 only): guarded like fixture calls, absent in every other scenario so their digests stay identical. */
  productCalls?: Call[];
  estimate: { usd: number; cleanupReserveUsd: number; basis: string; provisional: true };
  requirements: { id: string; acceptance: string[]; fixtures: Family[]; join: string }[];
  sha256: string;
}
/** Additive extension of Wave 5 permissions.json; its root remains owned by REL. */
export interface AwsPermission {
  schema: 1;
  decision: "DEC-CLOUD";
  approvedBy: string;
  approvedAt: string;
  expiresAt: string;
  accountId: string;
  region: string;
  runId: string;
  planSha256: string;
  sourceCommit: string;
  maxUsd: number;
  maxMinutes: number;
  grants: { action: string; resource: string; maximumCalls: number }[];
}
export interface Transport {
  send(call: Call, input: Record<string, Json>, signal?: AbortSignal): Promise<Record<string, unknown>>;
}
export interface Check {
  id: string;
  status: "passed" | "failed" | "pending";
  scope: "aws_fixture" | "product_requirement" | "cleanup";
  reason: string;
}
export interface Journal {
  schema: 1;
  provenance: "contract" | "live_sandbox";
  plan: Plan;
  permissionSha256: string;
  commit: string;
  startedAt: string;
  attempted: Family[];
  responses: Record<string, Record<string, unknown>>;
  checks: Check[];
  closed: boolean;
  counts: Record<string, number>;
}
export interface ProductScenarioPort {
  /** Wave 5 join: execute through normal authority/approval paths using this guarded
   * transport, then independently read durable receipts and actual traffic.
   * No implementation is injected by default; absence is a pending requirement.
   * Must settle all accepted operations before returning. Never return fabricated receipts. */
  verify(requirement: Plan["requirements"][number], context: {
    /** `input` (optional) is the resolved request for a planned call whose template holds `$runtime` markers; the planned call itself is still the digest the guard checks. */
    plan: Plan; commit: string; call: (call: Call, input?: Record<string, Json>) => Promise<Record<string, unknown>>;
    /** The port starts its cleanup: later calls are exempt from the duration envelope and bounded by a 25-minute cleanup clock. */
    beginCleanup?: () => void;
  }): Promise<{ complete: boolean; reason: string; /** Cleanup leaks: each one is a failed check, never a pass. */ leaks?: string[] }>;
}
