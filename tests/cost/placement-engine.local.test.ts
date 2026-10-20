/**
 * Real local HTTP/session acceptance for PROD-COST-02 placement cost dimensions and refusals.
 * No auth, SQL or solver mocks: it calls the registered placement route of an owned local J1 stack.
 *
 * Gate: ZENITH_TEST_COST_PLACEMENT_HTTP=1. Fixture inputs are the optimizer consent lane's:
 *   ZENITH_TEST_COST_OPT_IN_BASE_URL         unauthenticated loopback origin of the J1 stack
 *   ZENITH_TEST_COST_WORKSPACE_ID            workspace the human belongs to
 *   ZENITH_TEST_COST_ENVIRONMENT_ID          that workspace's environment (placement is read-only; no state changes)
 *   ZENITH_TEST_COST_FOREIGN_ENVIRONMENT_ID  an environment of a different tenant (must answer 404)
 *   ZENITH_TEST_COST_HUMAN_COOKIE_FILE       absolute path of a file holding one Cookie header value of that signed-in human
 * Authentication: POST /api/platform/v1/environments/{id}/placement takes a session cookie plus x-zenith-workspace
 * (user principal, broker capability placement.solve, no AAL step-up), or a linked `za_` agent bearer. This lane uses the
 * cookie only, like the consent lane. Fixture data the runner must have prepared in that workspace:
 *   - the environment's project working manifest holds a web service, a postgres resource (backups left on) and an object store;
 *   - at least one VERIFIED provider connection, and an OCI connection (1-zone regions) for the availability refusal.
 * Real refusal vocabulary: an infeasible request answers 200 with result.chosen absent, feasibility.feasible=false and a
 * blocker kind (budget | residency | availability | price); malformed requests answer { error: { code: "invalid_request" } }.
 */
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { BUDGET_NOTICE, ESTIMATE_NOTICE, findCapClaims } from "@/lib/cost/wording";
import { parseBudgetReason } from "@/lib/placement/reasons";

const enabled = process.env.ZENITH_TEST_COST_PLACEMENT_HTTP === "1";
const ID = /^[A-Za-z0-9_-]{1,100}$/;

const Line = z.object({ description: z.string(), sku: z.string(), quantity: z.number(), unitUsd: z.number(), monthlyUsd: z.number(), basis: z.string() }).passthrough();
const Candidate = z.object({
  id: z.string(),
  assignments: z.record(z.string(), z.object({ provider: z.string(), region: z.string() }).passthrough()),
  cost: z.object({ kind: z.literal("estimate"), monthlyUsd: z.number(), lines: z.array(Line), excluded: z.array(z.string()) }).passthrough(),
}).passthrough();
const Blocker = z.object({ kind: z.string(), bindingOnAll: z.boolean(), example: z.string().optional() }).passthrough();
const Recommendation = z.object({
  connectedProviders: z.array(z.string()),
  result: z.object({ chosen: Candidate.optional(), alternatives: z.array(Candidate), rejected: z.array(z.object({ id: z.string(), reasons: z.array(z.string()) })) }).passthrough(),
  unconnectedCandidates: z.array(Candidate),
  feasibility: z.object({
    feasible: z.boolean(),
    blockers: z.array(Blocker),
    budget: z.object({ limitUsdMonthly: z.number(), isEstimate: z.literal(true), notABillingCap: z.literal(true), notice: z.string(), shortfallUsdMonthly: z.number().optional() }).optional(),
  }).passthrough(),
  disclosure: z.object({ kind: z.string(), isBillingCap: z.boolean(), notice: z.string(), budgetNotice: z.string() }).strict(),
}).passthrough();
type Recommendation = z.infer<typeof Recommendation>;
type Candidate = z.infer<typeof Candidate>;

/** Base cost dimensions and the catalog roles whose absence is an explicit "not priced for this provider" note. */
const DIMENSIONS = {
  egress: { line: /^Internet egress$/, absent: /egress internet gb/ },
  nat: { line: /^NAT gateway /, absent: /nat (hour|gb)/ },
  ipv4: { line: /^Public IPv4 addresses$/, absent: /ipv4 hour/ },
  requests: { line: /^(Object storage (read|write) requests|Queue \/ topic requests|Load balancer capacity units|Load balancer data processed)$/, absent: /(object (get|put) million|queue requests million|lb capacity unit hour|lb processed gb)/ },
  backups: { line: /^(Database backup storage|Volume snapshots)$/, absent: /(pg backup gb month|block snapshot gb month)/ },
} as const;
/** Extended dimensions: priced only on supplied usage, and refused (never zero) when the catalog has no price. */
const EXTENDED = {
  io: { usage: "storageIoMillions", line: "Storage I/O requests", sku: "storage.io_million" },
  interAz: { usage: "interAzGb", line: "Inter-availability-zone transfer", sku: "data_transfer.inter_az_gb" },
  backupCopy: { usage: "crossRegionBackupCopyGb", line: "Cross-region backup copy", sku: "backup.cross_region_copy_gb" },
} as const;

const billed = (l: z.infer<typeof Line>) => l.quantity * l.unitUsd > 0;
const candidatesOf = (r: Recommendation): Candidate[] => [...(r.result.chosen ? [r.result.chosen] : []), ...r.result.alternatives, ...r.unconnectedCandidates];
const strings = (value: unknown): string[] => typeof value === "string" ? [value] : value && typeof value === "object" ? Object.values(value).flatMap(strings) : [];
const capFlags = (value: unknown, path = "$"): string[] => value && typeof value === "object"
  ? Object.entries(value).flatMap(([k, v]) => (/cap$/i.test(k) && !/^not/i.test(k) && v === true ? [`${path}.${k}`] : capFlags(v, `${path}.${k}`)))
  : [];

describe.skipIf(!enabled)("actual local placement engine (needs registered route, local identity provider, human cookie and a prepared J1 fixture)", () => {
  function setup() {
    const base = new URL(process.env.ZENITH_TEST_COST_OPT_IN_BASE_URL ?? "");
    if (!["localhost", "127.0.0.1", "[::1]"].includes(base.hostname) || !["http:", "https:"].includes(base.protocol) || base.username || base.password) throw new Error("Placement acceptance requires an unauthenticated loopback base URL.");
    const workspace = process.env.ZENITH_TEST_COST_WORKSPACE_ID ?? "";
    const environment = process.env.ZENITH_TEST_COST_ENVIRONMENT_ID ?? "";
    const foreign = process.env.ZENITH_TEST_COST_FOREIGN_ENVIRONMENT_ID ?? "";
    const file = process.env.ZENITH_TEST_COST_HUMAN_COOKIE_FILE ?? "";
    if (![workspace, environment, foreign].every(id => ID.test(id)) || environment === foreign || !isAbsolute(file)) throw new Error("Supply owned local workspace/environment IDs, a different tenant's environment ID and an absolute human-cookie file.");
    const cookie = readFileSync(file, "utf8").trim();
    if (!cookie || /[\r\n]/.test(cookie)) throw new Error("The human-cookie file must contain one Cookie header value.");
    const post = (id: string, body: unknown, authenticated = true) => fetch(new URL(`/api/platform/v1/environments/${id}/placement`, base), {
      method: "POST", redirect: "manual", signal: AbortSignal.timeout(30_000), body: JSON.stringify(body),
      headers: { "content-type": "application/json", "x-zenith-workspace": workspace, origin: base.origin, "sec-fetch-site": "same-origin", ...(authenticated ? { cookie } : {}) },
    });
    /** One placement answer, with the estimate wording checked on every body the product returns. */
    const place = async (constraints: unknown, extra: Record<string, unknown> = {}): Promise<Recommendation> => {
      const response = await post(environment, { constraints, ...extra });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toContain("no-store");
      const body = await response.json();
      const parsed = Recommendation.parse(body);
      // (c) estimate wording on every answer, and nothing in it claims or flags a cap.
      expect(parsed.disclosure).toEqual({ kind: "estimate", isBillingCap: false, notice: ESTIMATE_NOTICE, budgetNotice: BUDGET_NOTICE });
      for (const c of candidatesOf(parsed)) expect(c.cost.kind).toBe("estimate");
      if (parsed.feasibility.budget) expect(parsed.feasibility.budget.notice).toBe(BUDGET_NOTICE);
      expect(capFlags(body)).toEqual([]);
      expect(findCapClaims(strings(body).join("\n"))).toEqual([]);
      return parsed;
    };
    return { post, place, environment, foreign };
  }

  it("requires a human session, scopes to the tenant and refuses malformed requests with invalid_request", async () => {
    const { post, environment, foreign } = setup();
    const code = async (response: Response) => ((await response.json()) as { error?: { code?: string } }).error?.code;
    const anonymous = await post(environment, {}, false);
    expect([anonymous.status, await code(anonymous)]).toEqual([401, "unauthenticated"]);
    const other = await post(foreign, {});
    expect([other.status, await code(other)]).toEqual([404, "not_found"]);
    for (const body of [{ apply: true }, { constraints: { usage: { egressGb: -1 } } }, { constraints: { budgetUsdMonthly: 0 } }, { constraints: { usage: { unknownGb: 1 } } }]) {
      const response = await post(environment, body);
      expect([response.status, await code(response)]).toEqual([400, "invalid_request"]);
    }
  }, 60_000);

  it("prices egress, NAT, IPv4, requests and backups as separate lines (or an explicit not-priced note) for every candidate", async () => {
    const { place } = setup();
    const answer = await place({ usage: { egressGb: 500, requestsMillions: 50 } }, { includeUnconnected: true });
    expect(answer.feasibility.feasible).toBe(true);
    expect(answer.result.chosen).toBeDefined();
    let fullyBilled = 0;
    for (const c of candidatesOf(answer)) {
      let allBilled = true;
      for (const [name, d] of Object.entries(DIMENSIONS)) {
        const lines = c.cost.lines.filter(l => d.line.test(l.description));
        const billedLine = lines.some(billed);
        // A zero-rate list price is shown as its own line with a basis; an absent provider role is named in `excluded`.
        const zeroRate = lines.some(l => l.unitUsd === 0 && l.basis.length > 0);
        const notPriced = c.cost.excluded.some(x => /has no catalog SKU for/.test(x) && d.absent.test(x));
        expect(billedLine || zeroRate || notPriced, `${c.id}: ${name} is neither billed, a zero-rate line nor an explicit not-priced note`).toBe(true);
        if (!billedLine) allBilled = false;
      }
      if (allBilled) fullyBilled += 1;
    }
    // The prepared fixture (web + postgres + object store, private compute) must show every dimension as its own nonzero line somewhere.
    expect(fullyBilled).toBeGreaterThan(0);
  }, 60_000);

  it.each(Object.entries(EXTENDED))("prices %s separately when the catalog has it, otherwise refuses with a price reason (never zero)", async (_name, d) => {
    const { place } = setup();
    const answer = await place({ usage: { egressGb: 50, requestsMillions: 5, [d.usage]: 100 } });
    const sku = new RegExp(`\\.${d.sku.replace(/\./g, "\\.")}$`);
    const lineOf = (c: Candidate) => c.cost.lines.filter(l => l.description === d.line);
    if (answer.result.chosen) {
      for (const c of [answer.result.chosen, ...answer.result.alternatives]) {
        expect(lineOf(c).length, `${c.id}: supplied ${d.usage} must produce a ${d.line} line`).toBeGreaterThan(0);
        for (const l of lineOf(c)) { expect(l.sku).toMatch(sku); expect(billed(l)).toBe(true); }
      }
    } else {
      expect(answer.feasibility.feasible).toBe(false);
      expect(answer.feasibility.blockers.map(b => b.kind)).toContain("price");
      expect(answer.result.rejected.some(r => r.reasons.some(x => x.startsWith("price: No price for ") && sku.test(x.split(" ")[4] ?? "")))).toBe(true);
    }
    expect(candidatesOf(answer).flatMap(lineOf).filter(l => !billed(l))).toEqual([]);
  }, 60_000);

  it("refuses infeasible budget, residency and availability with the product's typed blockers, estimates and no cap", async () => {
    const { place } = setup();
    const baseline = await place({});
    const budget = await place({ budgetUsdMonthly: 0.01 });
    expect(budget.result.chosen).toBeUndefined();
    expect(budget.result.alternatives).toEqual([]);
    expect(budget.feasibility).toMatchObject({ feasible: false, budget: { limitUsdMonthly: 0.01, isEstimate: true, notABillingCap: true } });
    expect(budget.feasibility.budget!.shortfallUsdMonthly).toBeGreaterThan(0);
    expect(budget.feasibility.blockers).toContainEqual(expect.objectContaining({ kind: "budget", bindingOnAll: true }));
    expect(budget.result.rejected.flatMap(r => r.reasons).some(x => parseBudgetReason(x)?.budgetUsd === 0.01)).toBe(true);

    const residency = await place({ residency: ["mars"] });
    expect(residency.result.chosen).toBeUndefined();
    expect(residency.feasibility.feasible).toBe(false);
    expect(residency.feasibility.blockers).toContainEqual(expect.objectContaining({ kind: "residency", bindingOnAll: true }));

    // Availability: 100% on 1-zone OCI regions only. Needs a verified OCI connection in the fixture workspace.
    if (!baseline.connectedProviders.includes("oci")) throw new Error("The availability refusal needs a verified OCI connection (1-zone regions) in the fixture workspace.");
    const availability = await place({ availabilityTarget: 100, providerDenylist: ["aws", "gcp", "azure", "zenith"] });
    expect(availability.result.chosen).toBeUndefined();
    expect(availability.feasibility.feasible).toBe(false);
    expect(availability.feasibility.blockers).toContainEqual(expect.objectContaining({ kind: "availability", bindingOnAll: true, example: expect.stringMatching(/^availability: oci\/\S+ offers \d+ availability zone\(s\) but \d+ are required/) }));
  }, 120_000);
});
