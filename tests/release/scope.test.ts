/**
 * PROD-REL-04: the scope permission manifest. Contract level: pure rules over the shipped manifest; nothing here reaches
 * a cloud. The shipped manifest is owner-approved; refusal and approve-flow paths start from an unapproved copy.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runPermissionsCli } from "../../scripts/release/permissions-cli";
import { FORBIDDEN_ACTIONS, Scope, ScopeError, ScopeLedger, authorizeModelSpend, committedSpend, contentDigest, loadManifestFile, parseManifest, requireScope, runLedger, scopeSkipReason, type ScopeProvider, type ScopeRequest } from "../../scripts/release/scope";
import { NOW, RUN, approvedManifest, approvedScope, shippedManifestPath, shippedRaw, unapprovedShippedFile, unapprovedShippedRaw } from "./_support";

const code = (fn: () => unknown): string | undefined => {
  try { fn(); } catch (e) { return e instanceof ScopeError ? e.code : "other"; }
  return undefined;
};
const create = (over: Partial<ScopeRequest> = {}): ScopeRequest => ({ harness: "mixed-traffic-live", provider: "gcp", action: "create_disposable", estimatedUsd: 5, runId: RUN, resourceName: `zenith-${RUN}-web`, ttlMinutes: 60, ...over });

describe("the shipped manifest", () => {
  it("parses, names every live harness and either carries the owner's approval of exactly this content or refuses it as stale", () => {
    const manifest = loadManifestFile(shippedManifestPath());
    expect(manifest.approval.status).toBe("approved");
    expect(manifest.approval.approvedBy).toMatch(/\S/);
    expect(Date.parse(manifest.approval.expiresAt!)).toBeGreaterThan(Date.parse(manifest.approval.approvedAt!));
    // The same check every harness runs, pinned to the approval instant so the test never depends on the wall clock.
    // Between a manifest edit and the owner's re-approval the shipped approval is stale and must refuse.
    const atApproval = new Scope(manifest, () => new Date(manifest.approval.approvedAt!));
    if (manifest.approval.approvedDigest === contentDigest(manifest)) {
      expect(() => atApproval.assertApproved()).not.toThrow();
    } else {
      expect(code(() => atApproval.assertApproved())).toBe("approval_stale");
    }
    for (const id of ["aws-live", "aws-cleanup", "aws-iam-live", "azure-live", "non-aws-dns-live", "billing-live", "mixed-evidence-live", "mixed-traffic-live", "mixed-recovery-live", "mixed-connectivity-live", "release-acceptance"]) {
      expect(manifest.harnesses[id], id).toBeDefined();
    }
    for (const action of FORBIDDEN_ACTIONS) expect(manifest.forbiddenActions).toContain(action);
  });

  it("refuses every live harness until a person approves it", () => {
    const env = { ZENITH_LIVE_SCOPE_FILE: unapprovedShippedFile() };
    const scope = new Scope(loadManifestFile(env.ZENITH_LIVE_SCOPE_FILE), () => NOW);
    expect(code(() => scope.assertApproved())).toBe("not_approved");
    expect(code(() => scope.authorize({ harness: "mixed-traffic-live", provider: "control_plane", action: "read" }))).toBe("not_approved");
    expect(scopeSkipReason("mixed-traffic-live", "control_plane", env, () => NOW)).toContain("not been approved");
    expect(code(() => requireScope("aws-live", "aws", env, () => NOW))).toBe("not_approved");
  });

  it("every harness grant fits inside the per-run budget and grants no forbidden capability", () => {
    const manifest = loadManifestFile(shippedManifestPath());
    for (const [id, grant] of Object.entries(manifest.harnesses)) {
      expect(grant.maxRunUsd, id).toBeLessThanOrEqual(manifest.budgets.perRunUsd);
      expect(grant.actions.every((a) => !(FORBIDDEN_ACTIONS as readonly string[]).includes(a)), id).toBe(true);
    }
  });
});

describe("approval", () => {
  it("is exactly the digest of the content a person approved", () => {
    const scope = approvedScope();
    expect(() => scope.assertApproved()).not.toThrow();
    expect(() => scope.authorize({ harness: "mixed-traffic-live", provider: "control_plane", action: "read" })).not.toThrow();
  });

  it("goes stale when a budget, grant or forbidden action changes after approval", () => {
    const base = approvedManifest();
    const widened = parseManifest({ ...base, budgets: { ...base.budgets, perRunUsd: 30, totalUsd: base.budgets.totalUsd + 1 } });
    expect(code(() => new Scope(widened, () => NOW).assertApproved())).toBe("approval_stale");
    const extra = parseManifest({ ...base, harnesses: { ...base.harnesses, sneaky: { description: "x", providers: ["aws"], actions: ["read"], maxRunUsd: 0 } } });
    expect(code(() => new Scope(extra, () => NOW).assertApproved())).toBe("approval_stale");
  });

  it("expires", () => {
    const later = new Date(NOW.getTime() + 2 * 86_400_000);
    expect(code(() => approvedScope(undefined, later).assertApproved())).toBe("approval_expired");
  });

  it("refuses a half-filled approval", () => {
    const base = approvedManifest();
    expect(code(() => new Scope(parseManifest({ ...base, approval: { ...base.approval, approvedBy: null } }), () => NOW).assertApproved())).toBe("not_approved");
  });

  it("cannot drop a forbidden action from the manifest", () => {
    const raw = shippedRaw();
    raw.forbiddenActions = (raw.forbiddenActions as string[]).filter((a) => a !== "purchase");
    expect(code(() => parseManifest(raw))).toBe("manifest_invalid");
  });

  it("rejects a harness that allows more than the per-run budget and unknown keys", () => {
    const raw = shippedRaw();
    (raw.harnesses as Record<string, { maxRunUsd: number }>)["aws-live"]!.maxRunUsd = 999;
    expect(code(() => parseManifest(raw))).toBe("manifest_invalid");
    expect(code(() => parseManifest({ ...shippedRaw(), extra: true }))).toBe("manifest_invalid");
  });
});

describe("authorize", () => {
  it.each(FORBIDDEN_ACTIONS)("never allows %s, approved or not", (action) => {
    expect(code(() => approvedScope().authorize({ harness: "mixed-traffic-live", provider: "control_plane", action }))).toBe("action_forbidden");
    expect(code(() => new Scope(loadManifestFile(shippedManifestPath()), () => NOW).authorize({ harness: "x", provider: "aws", action }))).toBe("action_forbidden");
  });

  it("refuses a harness or provider or action it was not granted", () => {
    const scope = approvedScope();
    expect(code(() => scope.authorize({ harness: "unlisted-harness", provider: "aws", action: "read" }))).toBe("harness_unknown");
    expect(code(() => scope.authorize({ harness: "billing-live", provider: "kubernetes", action: "read" }))).toBe("provider_not_granted");
    expect(code(() => scope.authorize(create({ harness: "billing-live", provider: "aws" })))).toBe("action_not_granted");
    expect(code(() => scope.authorize({ harness: "mixed-connectivity-live", provider: "aws", action: "inject_fault", runId: RUN }))).toBe("action_not_granted");
  });

  it("a creating step needs a run id, a disposable name, a lifetime and an estimate", () => {
    const scope = approvedScope();
    expect(() => scope.authorize(create())).not.toThrow();
    expect(code(() => scope.authorize(create({ runId: "my-run" })))).toBe("run_id_invalid");
    expect(code(() => scope.authorize(create({ runId: undefined })))).toBe("run_id_invalid");
    expect(code(() => scope.authorize(create({ resourceName: "prod-database" })))).toBe("not_disposable");
    expect(code(() => scope.authorize(create({ resourceName: undefined })))).toBe("not_disposable");
    expect(code(() => scope.authorize(create({ ttlMinutes: undefined })))).toBe("ttl_exceeded");
    expect(code(() => scope.authorize(create({ ttlMinutes: 241 })))).toBe("ttl_exceeded");
    expect(code(() => scope.authorize(create({ estimatedUsd: undefined })))).toBe("budget_unknown");
    expect(code(() => scope.authorize(create({ estimatedUsd: Number.NaN })))).toBe("budget_unknown");
    expect(code(() => scope.authorize(create({ estimatedUsd: -1 })))).toBe("budget_unknown");
  });

  it("enforces the per-provider, per-run and per-harness budgets cumulatively", () => {
    const scope = approvedScope();
    const ledger = new ScopeLedger();
    expect(code(() => scope.authorize(create({ provider: "aws", estimatedUsd: 11 }), ledger))).toBe("budget_exceeded");
    expect(ledger.total()).toBe(0);
    scope.authorize(create({ provider: "gcp", estimatedUsd: 10, resourceName: `zenith-${RUN}-gcp` }), ledger);
    scope.authorize(create({ provider: "azure", estimatedUsd: 15, resourceName: `zenith-${RUN}-azure` }), ledger);
    expect(ledger.total()).toBe(25);
    expect(code(() => scope.authorize(create({ provider: "aws", estimatedUsd: 6, resourceName: `zenith-${RUN}-aws` }), ledger))).toBe("budget_exceeded");
    expect(code(() => scope.authorize(create({ provider: "gcp", estimatedUsd: 0.01, resourceName: `zenith-${RUN}-gcp2` }), ledger))).toBe("budget_exceeded");
    scope.authorize(create({ provider: "aws", estimatedUsd: 5, resourceName: `zenith-${RUN}-aws` }), ledger);
    expect(ledger.total()).toBe(30);
    expect(code(() => scope.authorize(create({ harness: "mixed-recovery-live", provider: "gcp", action: "create_disposable" })))).toBe("action_not_granted");
  });

  it("a zero-budget provider cannot create anything", () => {
    expect(code(() => approvedScope().authorize(create({ provider: "control_plane", estimatedUsd: 0.01 })))).toBe("budget_exceeded");
    expect(code(() => approvedScope().authorize(create({ harness: "azure-live", provider: "azure", estimatedUsd: 5.5 })))).toBe("budget_exceeded");
  });

  it("changing or tearing down needs this run's own tag", () => {
    const scope = approvedScope();
    const base: ScopeRequest = { harness: "mixed-traffic-live", provider: "gcp", action: "mutate_run_tagged", runId: RUN };
    expect(() => scope.authorize({ ...base, tags: { "zenith:live-run": RUN } })).not.toThrow();
    expect(code(() => scope.authorize(base))).toBe("not_disposable");
    expect(code(() => scope.authorize({ ...base, tags: { "zenith:live-run": "zlive-202610071200-zzzz" } }))).toBe("not_disposable");
    expect(code(() => scope.authorize({ ...base, action: "teardown_run_tagged", tags: {} }))).toBe("not_disposable");
    expect(code(() => scope.authorize({ ...base, runId: "other", tags: { "zenith:live-run": "other" } }))).toBe("run_id_invalid");
  });

  it("assertGrant checks approval and grant without needing a run", () => {
    const scope = approvedScope();
    expect(() => scope.assertGrant("aws-cleanup", "aws", "teardown_run_tagged")).not.toThrow();
    expect(code(() => scope.assertGrant("aws-cleanup", "gcp" as ScopeProvider, "read"))).toBe("provider_not_granted");
    expect(code(() => scope.assertGrant("aws-cleanup", "aws", "create_disposable"))).toBe("action_not_granted");
    expect(code(() => new Scope(loadManifestFile(unapprovedShippedFile()), () => NOW).assertGrant("aws-cleanup", "aws", "read"))).toBe("not_approved");
  });
});

describe("loading", () => {
  it("honours the named manifest FILE and refuses a missing or malformed one", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "zscope-"));
    const good = path.join(dir, "ok.json");
    writeFileSync(good, JSON.stringify(approvedManifest()));
    expect(scopeSkipReason("mixed-traffic-live", "control_plane", { ZENITH_LIVE_SCOPE_FILE: good }, () => NOW)).toBe("");
    expect(scopeSkipReason("mixed-traffic-live", "gcp", { ZENITH_LIVE_SCOPE_FILE: path.join(dir, "absent.json") }, () => NOW)).toContain("manifest_unreadable");
    const bad = path.join(dir, "bad.json");
    writeFileSync(bad, "{not json");
    expect(scopeSkipReason("mixed-traffic-live", "control_plane", { ZENITH_LIVE_SCOPE_FILE: bad }, () => NOW)).toContain("manifest_invalid");
    expect(scopeSkipReason("not-a-harness", "control_plane", { ZENITH_LIVE_SCOPE_FILE: good }, () => NOW)).toContain("harness_unknown");
  });
});

describe("permissions-cli", () => {
  function sandbox(): { file: string; env: Record<string, string>; out: string[]; err: string[]; io: { out: (s: string) => void; err: (s: string) => void } } {
    const dir = mkdtempSync(path.join(os.tmpdir(), "zperm-"));
    const file = path.join(dir, "permissions.json");
    writeFileSync(file, JSON.stringify(unapprovedShippedRaw()));
    const out: string[] = []; const err: string[] = [];
    return { file, env: { ZENITH_LIVE_SCOPE_FILE: file }, out, err, io: { out: (s) => { out.push(s); }, err: (s) => { err.push(s); } } };
  }

  it("show prints the digest and the unapproved state; check exits non-zero while unapproved", async () => {
    const s = sandbox();
    expect(await runPermissionsCli(["show"], s.env, s.io)).toBe(0);
    expect(s.out.join("")).toContain(contentDigest(loadManifestFile(s.file)));
    expect(await runPermissionsCli(["check"], s.env, s.io)).toBe(1);
    expect(s.err.join("")).toContain("not_approved");
  });

  it("approve refuses outside an interactive terminal and writes nothing", async () => {
    const s = sandbox();
    const before = readFileSync(s.file, "utf8");
    expect(await runPermissionsCli(["approve", "--by", "A Person"], s.env, s.io, false)).toBe(2);
    expect(readFileSync(s.file, "utf8")).toBe(before);
  });

  it("approve needs the typed digest; a wrong one changes nothing, the right one makes check pass", async () => {
    const s = sandbox();
    const before = readFileSync(s.file, "utf8");
    expect(await runPermissionsCli(["approve", "--by", "A Person"], s.env, s.io, true, async () => "000000000000")).toBe(1);
    expect(readFileSync(s.file, "utf8")).toBe(before);
    const wanted = contentDigest(loadManifestFile(s.file)).slice(0, 12);
    expect(await runPermissionsCli(["approve", "--by", "A Person", "--days", "7"], s.env, s.io, true, async () => wanted)).toBe(0);
    expect(await runPermissionsCli(["check"], s.env, s.io)).toBe(0);
    expect(loadManifestFile(s.file).approval).toMatchObject({ status: "approved", approvedBy: "A Person" });
  });

  it("rejects missing --by and an out-of-range --days", async () => {
    const s = sandbox();
    expect(await runPermissionsCli(["approve"], s.env, s.io, true)).toBe(2);
    expect(await runPermissionsCli(["approve", "--by", "A", "--days", "400"], s.env, s.io, true)).toBe(2);
    expect(await runPermissionsCli(["bogus"], s.env, s.io)).toBe(2);
  });
});

describe("owner-confirmed sandboxes and shared allowances (2026-10-23 authorization)", () => {
  it("ships only owner-confirmed sandbox identities, so an unconfirmed cloud stays refused even once approved", () => {
    const shipped = parseManifest(shippedRaw());
    // Owner-confirmed 2026-10-24: AWS sandbox account 361646636162 in ap-south-1. Owner-confirmed 2026-10-25: Azure for Students subscription in eastasia.
    // Every other identity stays unconfirmed.
    expect(shipped.sandboxes.aws).toEqual({ accountId: "361646636162", regions: ["ap-south-1"] });
    expect(shipped.sandboxes.azure).toEqual({ subscriptionId: "cacfdf22-d95d-48b8-b245-a6ed8c985a84", tenantId: "03cb5f0c-1f82-4993-9621-36330f6309ec", regions: ["eastasia"] });
    for (const provider of ["gcp", "oci", "supabase"] as const) {
      expect(Object.entries(shipped.sandboxes[provider]).filter(([key]) => !key.startsWith("region")).every(([, value]) => value === null)).toBe(true);
    }
    const unconfirmed = new Scope(parseManifest({ ...parseManifest(shippedRaw()), approval: { status: "approved", approvedBy: "Test Person", approvedAt: NOW.toISOString(), expiresAt: new Date(NOW.getTime() + 86_400_000).toISOString(), approvedDigest: contentDigest(parseManifest(shippedRaw())) } }), () => NOW);
    expect(code(() => unconfirmed.assertGrant("mixed-traffic-live", "gcp", "read"))).toBe("sandbox_unconfirmed");
    expect(code(() => unconfirmed.authorize({ harness: "release-acceptance", provider: "control_plane", action: "read" }))).toBeUndefined();
  });

  it("records the bounded allowances: $100 infrastructure, $30 per run, $20 model calls, stop at 80%", () => {
    const shipped = parseManifest(shippedRaw());
    expect(shipped.budgets).toMatchObject({ totalUsd: 100, perRunUsd: 30, maxRunTtlMinutes: 240 });
    expect(shipped.allowances).toMatchObject({ stopAtFraction: 0.8, anthropicUsd: 20 });
  });

  it("refuses new chargeable work once earlier runs plus this one would pass 80% of the allowance", () => {
    const scope = approvedScope();
    expect(code(() => scope.authorize(create({ estimatedUsd: 5 }), new ScopeLedger(70)))).toBeUndefined();
    expect(code(() => scope.authorize(create({ estimatedUsd: 5 }), new ScopeLedger(76)))).toBe("budget_exceeded");
  });

  it("counts estimates until reconciled, active forecasts always, and refuses an unreadable shared ledger", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "zenith-ledger-"));
    const file = path.join(dir, "ledger.json");
    writeFileSync(file, JSON.stringify({ schema: 1, entries: [
      { runId: "zlive-1", harness: "aws-live", kind: "infrastructure", recordedAt: NOW.toISOString(), estimatedUsd: 4, actualUsd: null, activeForecastUsd: 1, status: "torn_down" },
      { runId: "zlive-2", harness: "aws-live", kind: "infrastructure", recordedAt: NOW.toISOString(), estimatedUsd: 9, actualUsd: 2, activeForecastUsd: 0, status: "reconciled" },
      { runId: "eval-1", harness: "mach06", kind: "anthropic", recordedAt: NOW.toISOString(), estimatedUsd: 3, actualUsd: null, activeForecastUsd: 0, status: "running" },
    ] }));
    expect(committedSpend(file, "infrastructure")).toBe(7);
    expect(committedSpend(file, "anthropic")).toBe(3);
    const scope = approvedScope((raw) => { (raw.allowances as Record<string, unknown>).sharedLedger = "ledger.json"; });
    expect(runLedger(scope, dir).priorUsd).toBe(7);
    expect(code(() => authorizeModelSpend(scope, 12, dir))).toBeUndefined();
    expect(code(() => authorizeModelSpend(scope, 14, dir))).toBe("budget_exceeded");
    writeFileSync(file, "{");
    expect(code(() => committedSpend(file, "infrastructure"))).toBe("budget_unknown");
  });
});
