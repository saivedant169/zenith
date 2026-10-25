/**
 * PROD-OPS-07 ProductScenarioPort (retention-s3), offline. The port's SQL runs against a real migrated PGlite platform
 * store; the host child processes are replaced by the same product functions run in-process (retentionPass, verifyArchive,
 * restoreArchive) against an in-memory archive object store; S3 readback goes through a guard-like `call` that admits only
 * planned calls. Live evidence comes only from scripts/acceptance/aws-live.ts with ZENITH_LIVE_PRODUCT=1 on the runner.
 */
import { afterEach, describe, expect, it } from "vitest";
import { openPlatformDb, type PlatformDbHandle } from "@/lib/controlplane/db";
import type { Sql } from "@/lib/controlplane/types";
import type { ArchiveTarget } from "@/lib/retention/archive";
import { archiveKey } from "@/lib/retention/key";
import { retentionPass } from "@/lib/retention/job";
import { restoreArchive, verifyArchive } from "@/lib/retention/restore";
import { allCalls, buildPlan, digest } from "../../scripts/acceptance/live/plan";
import { retentionS3Port, type ProductCommand, type RetentionS3Seams } from "../../scripts/acceptance/live/product/retention-s3";
import type { Call, Plan } from "../../scripts/acceptance/live/contracts";

const settings = { accountId: "123456789012", region: "ap-south-1", durationMinutes: 15, dbSubnetGroup: "zenith-live-sandbox", dbSecurityGroup: "sg-12345678", workloadBoundaryArn: "arn:aws:iam::123456789012:policy/ZenithLiveWorkloadBoundary" };
const env = { ZENITH_LIVE_PRODUCT: "1", ZENITH_LIVE_PRODUCT_DATABASE_URL: "postgres://unused-in-tests", ZENITH_LIVE_PRODUCT_DIR: "/unused-in-tests", AWS_ACCESS_KEY_ID: "test-access", AWS_SECRET_ACCESS_KEY: "test-secret", AWS_SESSION_TOKEN: "test-token" };
const RUN = (n: number) => `zlive-202610080000-ab${String(n).padStart(2, "0")}`;
const REQ = { id: "PROD-OPS-07", acceptance: [], fixtures: ["s3" as const], join: "" };

/** Archive object store: the operator bucket, in memory. */
class MemoryTarget implements ArchiveTarget {
  readonly label = "memory bucket";
  private readonly objects = new Map<string, Buffer>();
  async put(key: string, bytes: Buffer) { this.objects.set(key, bytes); }
  async get(key: string) { return this.objects.get(key) ?? null; }
  keys(prefix: string): string[] { return [...this.objects.keys()].filter(k => k.startsWith(prefix)).sort(); }
}

/** Test-only faults: a wrong key verifying, a hidden listing class, a broken prune. Each one must make the port fail. */
interface Options {
  wrongKeyAccepted?: boolean;
  hideClass?: string;
  /** after the apply-switch pass */
  breakPrune?: (db: Sql, workspace: string) => Promise<void>;
  /** after the second pass with the apply switch unset (the first one is the archive pass) */
  breakClosedPass?: (db: Sql, workspace: string) => Promise<void>;
}

/** Runs the product's own functions in-process where the port would spawn `npx tsx`. Records every command it is given. */
function inProcess(db: Sql, s3: MemoryTarget, workspace: string, commands: ProductCommand[], opts: Options): NonNullable<RetentionS3Seams["run"]> {
  let unsetPasses = 0;
  return async (command) => {
    commands.push(command);
    const key = archiveKey(command.env);
    if (command.script === "scripts/data-retention.ts") {
      const apply = command.env.ZENITH_RETENTION_APPLY === "1";
      await retentionPass(db, { env: command.env, target: s3, key, now: new Date() });
      if (!apply && ++unsetPasses === 2 && opts.breakClosedPass) await opts.breakClosedPass(db, workspace);
      if (apply && opts.breakPrune) await opts.breakPrune(db, workspace);
      return { code: 0, timedOut: false, stdout: JSON.stringify({ status: "ok" }) };
    }
    if (command.args[0] === "verify") {
      if (opts.wrongKeyAccepted) return { code: 0, timedOut: false, stdout: JSON.stringify({ ok: true, rows: 3, problems: [] }) };
      const r = await verifyArchive(db, command.args[1], { deps: { operator: s3 }, key });
      return { code: r.ok ? 0 : 1, timedOut: false, stdout: JSON.stringify({ ok: r.ok, rows: r.rows, problems: r.problems }) };
    }
    if (command.args[0] === "restore") {
      const suffix = command.args[command.args.indexOf("--staging") + 1];
      const r = await restoreArchive(db, { archiveId: command.args[1], mode: "staging", stagingSuffix: suffix, actor: "cli:test" }, { deps: { operator: s3 }, key });
      return { code: r.verdict === "verified" ? 0 : 1, timedOut: false, stdout: JSON.stringify(r) };
    }
    throw new Error("unexpected product command in test");
  };
}

/** Admits only planned calls, as the guard does: same id and same digest. */
function guardedCall(plan: Plan, s3: MemoryTarget, opts: Options, seen: Call[]) {
  const planned = new Map(allCalls(plan).map(c => [c.id, digest(c)]));
  return async (c: Call): Promise<Record<string, unknown>> => {
    if (planned.get(c.id) !== digest(c)) throw new Error("unplanned AWS call refused");
    seen.push(c);
    const prefix = String(c.input.Prefix);
    const keys = opts.hideClass && prefix.includes(opts.hideClass) ? [] : s3.keys(prefix);
    return { Contents: keys.map(Key => ({ Key })), IsTruncated: false };
  };
}

let db: PlatformDbHandle | undefined;
afterEach(async () => { await db?.close(); db = undefined; });

async function run(runId: string, opts: Options = {}, environment: Record<string, string | undefined> = env) {
  db = await openPlatformDb({ kind: "pglite" });
  const plan = buildPlan({ ...settings, runId, scenario: "retention-s3" });
  const s3 = new MemoryTarget(), commands: ProductCommand[] = [], seen: Call[] = [];
  const seams: RetentionS3Seams = { sql: db, run: inProcess(db, s3, runId, commands, opts) };
  const port = retentionS3Port(environment, seams);
  const result = await port.verify(REQ, { plan, commit: "a".repeat(40), call: guardedCall(plan, s3, opts, seen) });
  return { result, plan, commands, seen, sql: db, s3 };
}

describe("PROD-OPS-07 ProductScenarioPort refusals (no product work)", () => {
  it("refuses other requirements by name, before any product work", async () => {
    const plan = buildPlan({ ...settings, runId: RUN(1), scenario: "retention-s3" });
    const port = retentionS3Port(env, { sql: undefined, run: async () => { throw new Error("must not run"); } });
    expect(await port.verify({ ...REQ, id: "PROD-MIX-03" }, { plan, commit: "a".repeat(40), call: async () => { throw new Error("must not call"); } }))
      .toEqual({ complete: false, reason: "PROD-MIX-03: not implemented by this port" });
  });
  it("refuses without ZENITH_LIVE_PRODUCT=1, the database URL or the product checkout, and never throws", async () => {
    const plan = buildPlan({ ...settings, runId: RUN(2), scenario: "retention-s3" });
    const noop = { run: async () => { throw new Error("must not run"); }, sql: undefined };
    for (const broken of [{ ZENITH_LIVE_PRODUCT: undefined }, { ZENITH_LIVE_PRODUCT: "0" }, { ZENITH_LIVE_PRODUCT_DATABASE_URL: undefined }, { ZENITH_LIVE_PRODUCT_DIR: "" }]) {
      const r = await retentionS3Port({ ...env, ...broken }, noop as RetentionS3Seams).verify(REQ, { plan, commit: "a".repeat(40), call: async () => { throw new Error("must not call"); } });
      expect(r.complete).toBe(false);
      expect(r.reason).toMatch(/ZENITH_LIVE_PRODUCT|ZENITH_LIVE_PRODUCT_DATABASE_URL|ZENITH_LIVE_PRODUCT_DIR/);
    }
  });
  it("refuses a plan that is not retention-s3, and a session without process credentials", async () => {
    const fixtures = buildPlan({ ...settings, runId: RUN(3) });
    const r1 = await retentionS3Port(env, { run: async () => { throw new Error("must not run"); } }).verify(REQ, { plan: fixtures, commit: "a".repeat(40), call: async () => { throw new Error("must not call"); } });
    expect(r1).toEqual({ complete: false, reason: "PROD-OPS-07 not proven at preconditions: the plan is not the retention-s3 scenario" });
    const plan = buildPlan({ ...settings, runId: RUN(3), scenario: "retention-s3" });
    const r2 = await retentionS3Port({ ...env, AWS_SESSION_TOKEN: undefined }, { run: async () => { throw new Error("must not run"); } }).verify(REQ, { plan, commit: "a".repeat(40), call: async () => { throw new Error("must not call"); } });
    expect(r2.complete).toBe(false); expect(r2.reason).toMatch(/process environment/);
  });
});

describe("PROD-OPS-07 ProductScenarioPort against a real migrated platform store (PGlite)", () => {
  it("passes on the happy path with every claim read back, and never leaks the per-run archive key", async () => {
    const { result, commands, seen, sql, s3, plan } = await run(RUN(4));
    expect(result.complete).toBe(true);
    expect(result.reason).toContain("PROD-OPS-07 proven by independent readback");
    expect(result.reason).toContain("No in-product proposal or approval was used");
    // Passes in order: archive without the apply switch, then with it; verify and restore ran through product commands.
    expect(commands.filter(c => c.script === "scripts/data-retention.ts").map(c => c.env.ZENITH_RETENTION_APPLY)).toEqual([undefined, undefined, "1"]);
    // The child environment carries only the product's settings and session credentials, never harness switches.
    expect(commands.every(c => Object.keys(c.env).every(k => !k.startsWith("ZENITH_LIVE_")))).toBe(true);
    // The S3 readback used exactly the planned listing calls, each under its class prefix.
    expect(seen.map(c => c.id).sort()).toEqual(["s3-retention-readback-machine", "s3-retention-readback-runner"]);
    expect(s3.keys(`retention/${plan.settings.runId}/`).length).toBe(2);
    const archive = await sql.query<{ n: number }>("select count(*)::int as n from platform.retention_archives where workspace_id = $1", [plan.settings.runId]);
    expect(archive[0].n).toBe(2);
    const key = commands[0].env.ZENITH_BACKUP_KEY;
    expect(JSON.stringify(result)).not.toContain(key);
  }, 120_000);

  it("fails when the S3 listing lacks a class", async () => {
    const r = await run(RUN(5), { hideClass: "machine_request_logs" });
    expect(r.result.complete).toBe(false);
    expect(r.result.reason).toMatch(/machine archive object is not listed/);
  }, 120_000);

  it("fails when a wrong archive key verifies", async () => {
    const r = await run(RUN(6), { wrongKeyAccepted: true });
    expect(r.result.complete).toBe(false);
    expect(r.result.reason).toMatch(/wrong key was not refused/);
  }, 120_000);

  it("fails when the apply-gated prune deletes a legal-hold row", async () => {
    const r = await run(RUN(7), {
      breakPrune: async (db, workspace) => { await db.query("delete from platform.runner_job_logs where workspace_id = $1 and line = 'live acceptance line 3'", [workspace]); },
    });
    expect(r.result.complete).toBe(false);
    expect(r.result.reason).toMatch(/prune did not remove exactly/);
  }, 120_000);

  it("fails when a pass with the apply switch unset removes a row", async () => {
    const r = await run(RUN(8), {
      breakClosedPass: async (db, workspace) => { await db.query("delete from platform.machine_request_logs where workspace_id = $1 and line = 'live acceptance line 0' and request_id like '%recent%'", [workspace]); },
    });
    expect(r.result.complete).toBe(false);
    expect(r.result.reason).toMatch(/removed with the apply switch unset/);
  }, 120_000);
});

describe("retention-s3 plan readback and digests (offline)", () => {
  const retention = () => buildPlan({ ...settings, runId: RUN(9), scenario: "retention-s3" });

  it("plans one bounded ListObjectsV2 per log class under the run's retention prefix, through the guard", () => {
    const p = retention(), readback = p.fixtures[0].product ?? [];
    expect(readback.map(c => c.id)).toEqual(["s3-retention-readback-runner", "s3-retention-readback-machine"]);
    for (const c of readback) {
      expect(c).toMatchObject({ service: "s3", command: "ListObjectsV2", action: "s3:ListBucket", resource: `arn:aws:s3:::zenith-${p.settings.runId}-${settings.accountId}`, maximumCalls: 2 });
    }
    expect(readback.map(c => c.input.Prefix)).toEqual([`retention/${p.settings.runId}/runner_job_logs/`, `retention/${p.settings.runId}/machine_request_logs/`]);
    expect(allCalls(p).some(c => c.id === "s3-retention-readback-runner")).toBe(true);
  });
  it("keeps the fixtures digest and fixture shape unchanged, with no readback calls in fixtures", () => {
    // Same settings, in the same key order (the digest hashes insertion order), as tests/acceptance/aws-production.test.ts.
    const fixtures = buildPlan({ accountId: settings.accountId, region: settings.region, runId: "zlive-202610080000-abcd", durationMinutes: settings.durationMinutes, dbSubnetGroup: settings.dbSubnetGroup, dbSecurityGroup: settings.dbSecurityGroup, workloadBoundaryArn: settings.workloadBoundaryArn, scenario: "fixtures" });
    expect(fixtures.sha256).toBe("d363bfdbc5ffca34c9daa680ada7b7e6b139b9b067d6129ab7be99eb817301f3");
    expect(fixtures.fixtures.every(f => f.product === undefined)).toBe(true);
    expect(allCalls(fixtures).some(c => c.id.includes("readback"))).toBe(false);
  });
  it("changes only the retention-s3 digest", () => {
    expect(retention().sha256).not.toBe("d363bfdbc5ffca34c9daa680ada7b7e6b139b9b067d6129ab7be99eb817301f3");
  });
});
