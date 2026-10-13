import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The controller is coded against ports. Its core must not reach a database,
 * the product server, a provider, the filesystem, the network or the process
 * environment; only `platform/` (the store adapter) may touch the control store,
 * and only `ports.ts` reads the one env var. A cycle among its own modules would
 * make the barrel order-dependent.
 */
const ROOT = path.join(process.cwd(), "src", "lib", "reconcile");
const core = fs.readdirSync(ROOT).filter((f) => f.endsWith(".ts"));
const platform = fs.readdirSync(path.join(ROOT, "platform")).filter((f) => f.endsWith(".ts"));
const read = (file: string, dir = ROOT): string => fs.readFileSync(path.join(dir, file), "utf8");
const importsOf = (text: string): string[] => [...text.matchAll(/(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/g)].map((m) => m[1]);

const CORE_ALLOWED = [
  /^\.\//,
  /^@\/lib\/capabilities\/catalog$/,
  /^@\/lib\/controlplane\/(types|digest)$/,
  /^@\/lib\/credentials\/types$/,
  /^@\/lib\/drivers\/types$/,
  /^@\/lib\/policy\/types$/,
  /^@\/lib\/resources(\/(types|drift))?$/,
  /^@\/lib\/ownership\/drift$/,
  /^@\/lib\/workflows\/types$/,
  /^@\/lib\/repair\/lifecycle$/,
];
const PLATFORM_ALLOWED = [
  /^\.\.?\//,
  /^node:crypto$/,
  /^@\/lib\/controlplane\/(types|digest)$/,
  /^@\/lib\/controlplane\/db\/(repos\/[a-z-]+|sql)$/,
  /^@\/lib\/controlplane\/leases$/,
  /^@\/lib\/policy\/types$/,
  /^@\/lib\/capabilities\/catalog$/,
  /^@\/lib\/resources(\/types)?$/,
  /^@\/lib\/incidents\/stability$/,
  // The platform adapter emits approved managed-runtime observations to the SLO recorder.
  /^@\/lib\/slo\/recorder$/,
];

describe("reconcile module boundaries", () => {
  it("has the modules the barrel promises", () => {
    for (const f of ["core.ts", "observe.ts", "diff.ts", "repair.ts", "scheduler.ts", "pass.ts", "ports.ts", "memory.ts", "activity.ts", "types.ts", "index.ts"]) expect(core).toContain(f);
    for (const f of ["store.ts", "state.ts", "guard.ts", "index.ts"]) expect(platform).toContain(f);
  });

  it("the core imports only the contracts it is coded against", () => {
    for (const f of core)
      for (const spec of importsOf(read(f))) expect(CORE_ALLOWED.some((re) => re.test(spec)), `${f} imports ${spec}`).toBe(true);
    for (const spec of ["@/lib/ownership", "@/lib/ownership/registry", "@/lib/ownership/conflicts", "@/lib/ownership/drift-extra", "@/lib/repair/lifecycle-extra", "@/lib/repair/platform", "node:fs", "@/lib/controlplane/db/open"])
      expect(CORE_ALLOWED.some((re) => re.test(spec)), `core refuses ${spec}`).toBe(false);
  });

  it("the store adapter imports only repositories, the lease service and contracts", () => {
    for (const f of platform)
      for (const spec of importsOf(read(f, path.join(ROOT, "platform")))) expect(PLATFORM_ALLOWED.some((re) => re.test(spec)), `platform/${f} imports ${spec}`).toBe(true);
    for (const spec of ["@/lib/incidents", "@/lib/incidents/controller", "@/lib/incidents/stability-extra", "@/lib/controlplane/digest-extra", "node:fs", "@/lib/db/store", "@/lib/slo", "@/lib/slo/store", "@/lib/slo/recorder-extra"])
      expect(PLATFORM_ALLOWED.some((re) => re.test(spec)), `adapter refuses ${spec}`).toBe(false);
  });

  it("nothing in the controller touches the filesystem, the network, child processes or the product store", () => {
    const banned = [/["']node:(fs|child_process|net|http|https)/, /from\s+["']fs["']/, /\bfetch\(/, /child_process/, /Math\.random/, /@\/lib\/db\//, /@\/lib\/server\//, /@\/app\//];
    for (const f of core) for (const re of banned) expect(re.test(read(f)), `${f} matches ${re}`).toBe(false);
    for (const f of platform) for (const re of banned) expect(re.test(read(f, path.join(ROOT, "platform"))), `platform/${f} matches ${re}`).toBe(false);
  });

  it("only ports.ts reads the process environment", () => {
    for (const f of core) expect(/process\.env/.test(read(f)), f).toBe(f === "ports.ts");
    for (const f of platform) expect(/process\.env/.test(read(f, path.join(ROOT, "platform"))), `platform/${f}`).toBe(false);
  });

  it("has no import cycles among its own modules", () => {
    const graph = new Map(core.map((f) => [f, importsOf(read(f)).filter((s) => s.startsWith("./")).map((s) => `${s.slice(2)}.ts`)]));
    const state = new Map<string, number>();
    const visit = (f: string, trail: string[]): string[] | undefined => {
      if (state.get(f) === 2) return undefined;
      if (state.get(f) === 1) return [...trail, f];
      state.set(f, 1);
      for (const d of graph.get(f) ?? []) {
        expect(graph.has(d), `${f} imports missing ${d}`).toBe(true);
        const cycle = visit(d, [...trail, f]);
        if (cycle) return cycle;
      }
      state.set(f, 2);
      return undefined;
    };
    for (const f of graph.keys()) expect(visit(f, []), `cycle from ${f}`).toBeUndefined();
  });

  it("the tick route imports only the cron gate, the error helpers, the logger and the barrel", () => {
    const route = fs.readFileSync(path.join(process.cwd(), "src", "app", "api", "internal", "tick", "reconcile", "route.ts"), "utf8");
    // OBS-04 uses the canonical maintenance adapter and its pure result contract.
    // Exact imports remain bounded; other platform execution helpers are refused.
    const allowed = new Set(["next/server", "@/lib/server/cron", "@/lib/server/errors", "@/lib/server/request", "@/lib/log", "@/lib/reconcile", "@/lib/platform/critical-jobs", "@/lib/reconcile/pass-types"]);
    for (const spec of importsOf(route)) expect(allowed.has(spec), `route imports ${spec}`).toBe(true);
    expect(route.match(/import\s*\{([^}]+)\}\s*from\s*["']@\/lib\/platform\/critical-jobs["']/)?.[1].trim()).toBe("runFallbackJob");
    expect(route.match(/import\s+type\s*\{([^}]+)\}\s*from\s*["']@\/lib\/reconcile\/pass-types["']/)?.[1].trim()).toBe("ReconcilePassResult");
    for (const spec of ["@/lib/platform/critical-jobs-extra", "@/lib/platform/credentials", "@/lib/controlplane/db/open", "@/lib/reconcile/pass-types-extra"])
      expect(allowed.has(spec), `route refuses ${spec}`).toBe(false);
  });
});
