/** Release checks must fail CI when they fail, including image assembly. */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";
import { CORE_CHECKS, EXTERNAL_ACCEPTANCE, GATE_LANES, LINUX_GUEST_PID1_CASES, linuxGuestManifest, manifestFor } from "../../scripts/ci/gate-manifest.mjs";

interface Step {
  name?: string;
  shell?: string;
  uses?: string;
  run?: string;
  if?: unknown;
  id?: string;
  env?: Record<string, unknown>;
  "working-directory"?: string;
  "continue-on-error"?: unknown;
  with?: Record<string, unknown>;
}

interface Service {
  image?: string;
  env?: Record<string, unknown>;
  ports?: unknown;
  options?: string;
}

interface Job {
  if?: unknown;
  "continue-on-error"?: unknown;
  "timeout-minutes"?: unknown;
  permissions?: unknown;
  environment?: unknown;
  concurrency?: unknown;
  strategy?: { "fail-fast"?: unknown; matrix?: { lane?: unknown; include?: unknown; exclude?: unknown } };
  defaults?: { run?: { "working-directory"?: string } };
  env?: Record<string, unknown>;
  services?: Record<string, Service>;
  steps: Step[];
}

interface Workflow {
  on: Record<string, unknown>;
  permissions: unknown;
  concurrency?: unknown;
  jobs: Record<string, Job>;
}

/** Read and parse one workflow. Rejects malformed YAML and duplicate keys. */
const read = (file: string): Workflow =>
  load(fs.readFileSync(path.join(process.cwd(), ".github/workflows", file), "utf8")) as Workflow;

// Parse YAML, rather than grepping comments or whitespace. This also rejects
// malformed YAML and duplicate keys before evaluating the release policy.
const workflow = read("ci.yml");
const agentControl = read("agent-control.yml");
const liveAcceptance = read("live-acceptance.yml");

/** Every workflow in the repository, by file name. */
const ALL_WORKFLOWS: Record<string, Workflow> = {
  "ci.yml": workflow,
  "agent-control.yml": agentControl,
  "tick.yml": read("tick.yml"),
  "live-acceptance.yml": liveAcceptance,
  "skipped-platforms.yml": read("skipped-platforms.yml"),
  "release.yml": read("release.yml"),
};

/** The raw text of a workflow with its comment lines removed, for scans that parsed YAML cannot answer. */
const code = (file: string): string =>
  fs
    .readFileSync(path.join(process.cwd(), ".github/workflows", file), "utf8")
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");

const stepsOf = (w: Workflow): Step[] => Object.values(w.jobs).flatMap((job) => job.steps);

/**
 * The install line, exactly, in every job that installs.
 *
 * `--ignore-scripts` is a supply-chain decision, not a preference: two packages
 * in this tree declare a `postinstall` (esbuild, unrs-resolver) and both are
 * no-ops once `optionalDependencies` are present, so nothing is bought by
 * letting arbitrary dependency code run at install time. Pinned here because a
 * flag that quietly falls off is indistinguishable from one that was never
 * there.
 */
const INSTALL = "npm ci --ignore-scripts";

/** One supported Node 22 patch, above locked jsdom's 22.22.2 minimum. See ci.yml. */
const NODE_VERSION = "22.23.3";

/**
 * The commit `actions/checkout` was pinned to when this file was last reviewed.
 * Kept for the assertion that every workflow shares ONE checkout commit; it is
 * deliberately not compared against a literal any more, because Dependabot
 * (.github/dependabot.yml) now rewrites action SHAs and a literal here would
 * turn every one of its pull requests red for a reason it cannot fix.
 */
const CHECKOUT_PREFIX = "actions/checkout@";

/** CI invokes the same owned manifest used for local execution and validation. */
const gateRun = (lane: string): string => `node scripts/ci/run-gate.mjs ${lane} --run`;
const gateValidate = (lane: string): string => `node scripts/ci/run-gate.mjs ${lane} --validate ${manifestFor(lane).report} --require-execution`;
const POLICY_VITEST = gateRun("policy");
const TOFU_VITEST = gateRun("tofu");
const WORKFLOWS_VITEST = gateRun("workflows");
const PLATFORM_VITEST = gateRun("platform-postgres");
const coreRun = (step: string): string => `node scripts/ci/run-gate.mjs core --run --step ${step}`;

const requiredCommands: Record<string, string[]> = {
  verify: [
    '"$RUNNER_TEMP/actionlint" .github/workflows/ci.yml .github/workflows/tick.yml .github/workflows/agent-control.yml .github/workflows/live-acceptance.yml .github/workflows/packaged-workers.yml .github/workflows/skipped-platforms.yml .github/workflows/release.yml .github/workflows/clean-host-default-stack.yml .github/workflows/clean-host-journey.yml .github/workflows/clean-host-kind-guest.yml',
    INSTALL,
    coreRun("typecheck"),
    coreRun("lint"),
    coreRun("unit"),
    coreRun("smoke"),
    coreRun("gimbal"),
  ],
  build: [INSTALL, "npm run build"],
  docker: ["docker build -t zenith:ci ."],
  hosted: [
    INSTALL,
    "npx vitest run tests/hosted --maxWorkers=2",
    "npx tsx scripts/hosted-acceptance.ts",
    "npx tsx scripts/hosted-browser.ts",
  ],
  postgres: [
    INSTALL,
    "bash scripts/ci/apply-supabase-migrations.sh",
    gateRun("postgres"),
  ],
  agent: [INSTALL, "npm run agent:acceptance", "npm run agent:browser"],
  // The platform module gates. Steps behind a `hashFiles` guard (the Go lane's,
  // the platform migration step) are asserted in their own describe blocks.
  policy: [INSTALL, "npm run policy:check", POLICY_VITEST],
  tofu: [INSTALL, TOFU_VITEST],
  workflows: [INSTALL, WORKFLOWS_VITEST],
  "platform-postgres": [INSTALL, PLATFORM_VITEST],
  "operation-gates": [INSTALL, "bash scripts/ci/apply-platform-migrations.sh", "node scripts/ci/run-gate.mjs ${{ matrix.lane }} --run"],
  generated: [INSTALL, "npm run platform:emit-sql -- --check", "npx tsx scripts/docs/capability-matrix.ts --check", "npx vitest run tests/docs --maxWorkers=2"],
  ledger: ["node scripts/build/ledger.mjs --check"],
  "supply-chain": ["node scripts/ci/lockfile-integrity.mjs", "node scripts/ci/security-audit.mjs"],
};

describe("release gate policy", () => {
  it("runs for every pull request and branch push without path filters", () => {
    expect(workflow.on).toEqual({ workflow_dispatch: null, push: { branches: ["**"] }, pull_request: null });
  });

  it.each(Object.entries(requiredCommands))("keeps %s mandatory and preserves failure exit codes", (name, commands) => {
    const job = workflow.jobs[name];
    expect(job).toBeDefined();
    expect(job.if).toBeUndefined();
    expect(job["continue-on-error"] ?? false).toBe(false);
    for (const command of commands) {
      // Exact standalone commands reject accidental `|| true`, shell wrappers,
      // and commented-out gates. Step conditions must not bypass the command.
      const matches = job.steps.filter((step) => step.run?.trim() === command);
      expect(matches, `${name} must run ${command}`).toHaveLength(1);
      expect(matches[0].if).toBeUndefined();
      expect(matches[0]["continue-on-error"] ?? false).toBe(false);
    }
  });

  it("grants only source read access, with no job escalation or retained checkout token", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    for (const job of Object.values(workflow.jobs)) {
      expect(job.permissions).toBeUndefined();
      const checkout = job.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
      expect(checkout?.with?.["persist-credentials"]).toBe(false);
    }
  });

  it("pins every external action to a full immutable commit", () => {
    const actions = Object.values(workflow.jobs).flatMap((job) => job.steps).filter((step) => step.uses);
    expect(actions.length).toBeGreaterThan(0);
    for (const step of actions) {
      expect(step.uses).toMatch(/^actions\/(checkout|setup-node|setup-go|cache|upload-artifact)@[a-f0-9]{40}$/);
    }
  });

  it("verifies the pinned validator archive before extracting or executing it", () => {
    const steps = workflow.jobs.verify.steps;
    const installers = steps.filter((step) => step.name === "Install pinned workflow validator");
    expect(installers).toHaveLength(1);
    const installer = installers[0];
    expect(installer.if).toBeUndefined();
    expect(installer["continue-on-error"] ?? false).toBe(false);
    expect(installer.shell).toBe("bash");
    // The install sequence is a supply-chain policy: bounded official download,
    // immutable checksum, fail-fast verification, and extraction of one binary.
    expect(installer.run?.trim().split("\n")).toEqual([
      "set -euo pipefail",
      'cd "$RUNNER_TEMP"',
      "curl --fail --silent --show-error --location --retry 3 --connect-timeout 15 --max-time 120 --output actionlint.tar.gz https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_linux_amd64.tar.gz",
      "printf '%s  %s\\n' '8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8' 'actionlint.tar.gz' | sha256sum --check --strict",
      'tar -xzf actionlint.tar.gz -C "$RUNNER_TEMP" actionlint',
    ]);
    const syntaxGate = steps.findIndex((step) => step.run?.startsWith('"$RUNNER_TEMP/actionlint"'));
    expect(steps.indexOf(installer)).toBeLessThan(syntaxGate);
  });

  it("isolates CI data using a context that is valid at job scope", () => {
    expect(workflow.jobs.verify.env?.ZENITH_DATA).toBe("${{ github.workspace }}/.data-ci");
  });

  /*
   * The hosted job (W10). It exists because the hosted release gates run real
   * builds and a real browser, which `verify` has no business requiring — and
   * because a hosted gate that is allowed to fail is not a gate.
   */
  describe("the hosted acceptance job", () => {
    const hosted = (): Job => workflow.jobs.hosted;

    it("runs unconditionally, and its failure fails CI", () => {
      expect(hosted(), "the workflow must define a `hosted` job").toBeDefined();
      expect(hosted().if, "the job must not be conditional").toBeUndefined();
      expect(hosted()["continue-on-error"] ?? false).toBe(false);
      for (const step of hosted().steps)
        expect(
          step["continue-on-error"] ?? false,
          `step ${step.name ?? step.run ?? step.uses} must not continue on error`
        ).toBe(false);
    });

    it("gets its own data directory, and never the developer's", () => {
      expect(hosted().env?.ZENITH_DATA).toBe("${{ github.workspace }}/.data-ci-hosted");
      expect(hosted().env?.ZENITH_DATA).not.toBe(workflow.jobs.verify.env?.ZENITH_DATA);
    });

    it("builds for real, because a hosted gate that cannot build proves nothing", () => {
      expect(hosted().env?.ZENITH_BUILD_RUNNER).toBe("recipe-local");
      expect(hosted().env?.ZENITH_RUNTIME).toBe("local");
    });

    it("runs gate 12 with no condition, so a missing browser is a failure and not a skip", () => {
      const step = hosted().steps.find((one) => one.run === "npx tsx scripts/hosted-browser.ts");
      expect(step, "the browser step must be present").toBeDefined();
      expect(step?.if, "and must not be gated on a browser being detected").toBeUndefined();
      expect(step?.["continue-on-error"] ?? false).toBe(false);

      // The detection step is allowed to pass when there is no browser — it is
      // a report, not a gate — but it must not decide whether gate 12 runs.
      const report = hosted().steps.find((one) => one.name === "Report the installed browser");
      expect(report?.run, "the report step names the browsers it looks for").toContain(
        "google-chrome --version"
      );
      expect(report?.run).toContain("microsoft-edge --version");
      expect(
        hosted().steps.some((one) => typeof one.if === "string" && /browser/i.test(one.if)),
        "no step may be conditional on the browser report"
      ).toBe(false);
    });

    it("runs the hosted suites before the journey, and the journey before the browser", () => {
      const order = hosted().steps.map((one) => one.run ?? "");
      const at = (command: string): number => order.findIndex((run) => run.trim() === command);
      expect(at("npx vitest run tests/hosted --maxWorkers=2")).toBeGreaterThan(at(INSTALL));
      expect(at("npx tsx scripts/hosted-acceptance.ts")).toBeGreaterThan(
        at("npx vitest run tests/hosted --maxWorkers=2")
      );
      expect(at("npx tsx scripts/hosted-browser.ts")).toBeGreaterThan(
        at("npx tsx scripts/hosted-acceptance.ts")
      );
    });
  });

  /*
   * The linked-agent job.
   *
   * The approval screen is where the user's consent is actually collected, so
   * the browser gate over it gets the same treatment gate 12 gets: no
   * condition, no `continue-on-error`, and a missing browser is a failure
   * rather than a skip. `scripts/agent-browser.ts` exits 2 in that case, which
   * fails the step; nothing in this job may turn that back into a pass.
   */
  describe("the linked-agent job", () => {
    const agent = (): Job => workflow.jobs.agent;

    it("runs unconditionally, and its failure fails CI", () => {
      expect(agent(), "the workflow must define an `agent` job").toBeDefined();
      expect(agent().if).toBeUndefined();
      expect(agent()["continue-on-error"] ?? false).toBe(false);
      for (const step of agent().steps)
        expect(
          step["continue-on-error"] ?? false,
          `step ${step.name ?? step.run ?? step.uses} must not continue on error`
        ).toBe(false);
    });

    it("gets its own data directory, and never another job's", () => {
      expect(agent().env?.ZENITH_DATA).toBe("${{ github.workspace }}/.data-ci-agent");
      for (const other of ["verify", "postgres", "hosted"])
        expect(agent().env?.ZENITH_DATA).not.toBe(workflow.jobs[other].env?.ZENITH_DATA);
    });

    it("runs the journey before the browser, and gates on neither a detected browser nor a flag", () => {
      const order = agent().steps.map((one) => one.run?.trim() ?? "");
      expect(order.indexOf("npm run agent:browser")).toBeGreaterThan(
        order.indexOf("npm run agent:acceptance")
      );
      const browser = agent().steps.find((one) => one.run?.trim() === "npm run agent:browser");
      expect(browser?.if, "the browser gate must not be conditional").toBeUndefined();
      expect(
        agent().steps.some((one) => typeof one.if === "string" && /browser/i.test(one.if)),
        "no step may be conditional on the browser report"
      ).toBe(false);
    });

    it("keeps the two scripts and the npm entry points that name them", () => {
      const pkg = JSON.parse(
        fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")
      ) as { scripts: Record<string, string> };
      expect(pkg.scripts["agent:acceptance"]).toBe("tsx scripts/agent-acceptance.ts");
      expect(pkg.scripts["agent:browser"]).toBe("tsx scripts/agent-browser.ts");
      for (const file of ["scripts/agent-acceptance.ts", "scripts/agent-browser.ts"])
        expect(fs.existsSync(path.join(process.cwd(), file)), `${file} must exist`).toBe(true);
    });
  });

  /*
   * One Node version and one checkout SHA across the repository.
   *
   * The locked dependencies require Node >=22.22.2 within the supported
   * Node 22 line. Every workflow uses the same exact patch and checkout commit
   * so merge and release gates agree about what "green" was measured on.
   */
  describe("the toolchain pins", () => {
    const nodeSteps = (w: Workflow): Step[] =>
      Object.values(w.jobs)
        .flatMap((job) => job.steps)
        .filter((step) => step.uses?.startsWith("actions/setup-node@"));

    it("pins one exact Node version in every job that sets one up", () => {
      const steps = [...nodeSteps(workflow), ...nodeSteps(agentControl), ...nodeSteps(liveAcceptance)];
      // Every node-using job in ci.yml, agent-control and live-acceptance. The
      // "runs node => sets node up first" rule below is what stops a new job
      // from quietly using whatever node the runner image happens to ship.
      expect(steps.length).toBeGreaterThanOrEqual(12);
      for (const step of steps) expect(String(step.with?.["node-version"])).toBe(NODE_VERSION);
    });

    it("pins one checkout commit in every workflow that checks out", () => {
      const checkouts = Object.values(ALL_WORKFLOWS)
        .flatMap(stepsOf)
        .filter((step) => step.uses?.startsWith(CHECKOUT_PREFIX));
      expect(checkouts.length).toBeGreaterThanOrEqual(5);
      const pinned = checkouts[0].uses;
      expect(pinned).toMatch(/^actions\/checkout@[a-f0-9]{40}$/);
      for (const step of checkouts) {
        expect(step.uses).toBe(pinned);
        expect(step.with?.["persist-credentials"]).toBe(false);
      }
    });

    it("installs with --ignore-scripts everywhere, and never with a bare npm ci", () => {
      const installs = [...Object.values(workflow.jobs), ...Object.values(agentControl.jobs), ...Object.values(liveAcceptance.jobs)]
        .flatMap((job) => job.steps)
        .map((step) => step.run?.trim() ?? "")
        .filter((run) => run.startsWith("npm ci"));
      expect(installs.length).toBeGreaterThanOrEqual(5);
      for (const run of installs) expect(run).toBe(INSTALL);
    });
  });

  /*
   * The PostgreSQL job (F1).
   *
   * It exists because every live contract lane in this repository is gated on
   * `ZENITH_CONTRACT_POSTGRES` and, unset, disappears without a trace: the
   * hosted-authority suites are `describe.each` over a factory table whose
   * Postgres row is simply absent (`tests/hosted/authority/contract/_factories.ts:152`).
   * A green run that exercised no Postgres looked exactly like one that did.
   *
   * These assertions pin the parts that make the job mean something: a real
   * database, both gating variables, the migrations actually applied, and a
   * report step that fails when a lane produced zero tests.
   */
  describe("the PostgreSQL contract job", () => {
    const pg = (): Job => workflow.jobs.postgres;

    it("runs unconditionally, and its failure fails CI", () => {
      expect(pg(), "the workflow must define a `postgres` job").toBeDefined();
      expect(pg().if).toBeUndefined();
      expect(pg()["continue-on-error"] ?? false).toBe(false);
      for (const step of pg().steps)
        expect(
          step["continue-on-error"] ?? false,
          `step ${step.name ?? step.run ?? step.uses} must not continue on error`
        ).toBe(false);
    });

    it("brings a real PostgreSQL service container, pinned by digest", () => {
      const service = pg().services?.postgres;
      expect(service, "the job must declare a `postgres` service").toBeDefined();
      // A tag alone would let the database move underneath the assertions.
      expect(service?.image).toMatch(/^postgres:[\w.-]+@sha256:[a-f0-9]{64}$/);
      expect(service?.options, "the job must wait on a health check").toContain("pg_isready");
      expect(service?.ports).toEqual(["5432:5432"]);
    });

    it("sets both conditions the contract factories require, or the lane is not in the table", () => {
      // tests/hosted/authority/contract/_factories.ts:79-80 — the flag says you
      // meant it, the URL says there is something to mean it about.
      expect(pg().env?.ZENITH_CONTRACT_POSTGRES).toBe("1");
      expect(String(pg().env?.SUPABASE_DB_URL)).toMatch(/^postgresql:\/\/.+@127\.0\.0\.1:5432\//);
      // Setting this to `postgres` would make both factory rows the same
      // database and quietly delete the SQLite half of the contract.
      expect(pg().env?.ZENITH_HOSTED_STORE).toBeUndefined();
    });

    it("gets its own data directory, and never another job's", () => {
      expect(pg().env?.ZENITH_DATA).toBe("${{ github.workspace }}/.data-ci-postgres");
      expect(pg().env?.ZENITH_DATA).not.toBe(workflow.jobs.verify.env?.ZENITH_DATA);
      expect(pg().env?.ZENITH_DATA).not.toBe(workflow.jobs.hosted.env?.ZENITH_DATA);
    });

    it("applies the migrations before it runs anything against them", () => {
      const order = pg().steps.map((step) => step.run?.trim() ?? "");
      const at = (command: string): number => order.indexOf(command);
      expect(at("bash scripts/ci/apply-supabase-migrations.sh")).toBeGreaterThan(at(INSTALL));
      expect(at(gateRun("postgres"))).toBeGreaterThan(
        at("bash scripts/ci/apply-supabase-migrations.sh")
      );
    });

    it("includes every committed migration in order in the database bootstrap", () => {
      const script = fs.readFileSync(path.join(process.cwd(), "scripts/ci/apply-supabase-migrations.sh"), "utf8");
      const manifest = script.match(/^MIGRATIONS=\(\r?\n([\s\S]*?)^\)/m)?.[1];
      expect(manifest, "the apply script must declare its ordered migration manifest").toBeDefined();
      const applied = [...(manifest ?? "").matchAll(/"([^"\n]+\.sql)"/g)].map((match) => match[1]);
      const committed = fs.readdirSync(path.join(process.cwd(), "supabase/migrations"))
        .filter((file) => file.endsWith(".sql")).sort();
      expect(applied).toEqual(committed);
    });

    it("reports on the lanes even when the suites failed, and fails when one ran nothing", () => {
      const report = pg().steps.find((step) =>
        step.run?.includes("scripts/ci/postgres-lane-report.mjs")
      );
      expect(report, "the job must end in a lane report").toBeDefined();
      // `always()` so a blocked-lane table still reaches the job summary after a
      // red suite — the one condition in this workflow that is deliberate.
      expect(report?.if).toBe("always()");
      expect(report?.["continue-on-error"] ?? false).toBe(false);
      expect(report?.run?.trim()).toBe("node scripts/ci/postgres-lane-report.mjs .data-ci-lane/postgres-lane.json");
    });

    it("keeps the helper scripts it depends on", () => {
      for (const file of [
        "scripts/ci/apply-supabase-migrations.sh",
        "scripts/ci/postgres-lane-report.mjs",
      ])
        expect(fs.existsSync(path.join(process.cwd(), file)), `${file} must exist`).toBe(true);
    });
  });

  /*
   * actionlint validates every workflow, not only the one it lives in.
   * `tick.yml` drives production background work on a schedule and
   * `agent-control.yml` is a merge gate; neither was being parsed by anything.
   */
  it("validates every workflow file in the repository", () => {
    const step = workflow.jobs.verify.steps.find((one) => one.name === "Validate workflow syntax");
    expect(step).toBeDefined();
    const onDisk = fs
      .readdirSync(path.join(process.cwd(), ".github/workflows"))
      .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
      .sort();
    expect(onDisk.length).toBeGreaterThan(0);
    for (const name of onDisk)
      expect(step?.run, `actionlint must be given .github/workflows/${name}`).toContain(
        `.github/workflows/${name}`
      );
  });
});

/*
 * =============================================================================
 * The platform module gates (WS-CI)
 *
 * policy, tofu, go, workflows, platform-postgres, ledger and supply-chain in
 * ci.yml, the dispatch-only live-acceptance workflow, and Dependabot. The
 * structure asserted here is what the comment blocks in those files promise:
 * every downloaded binary verified by checksum before use, every action pinned,
 * node pinned wherever it runs, live cloud access reachable only from a
 * reviewed, dispatch-only workflow, and lanes that cannot be green while
 * having run nothing.
 * =============================================================================
 */

const OPERATION_MATRIX_LANES = ["reconciliation", "workflow-intents"];
/** Resolve only the committed matrix's lane scalar, as GitHub does per item. */
function matrixStrings(value: unknown, lane: string): unknown {
  if (typeof value === "string") return value.replaceAll("${{ matrix.lane }}", lane);
  if (Array.isArray(value)) return value.map((item) => matrixStrings(item, lane));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, matrixStrings(item, lane)]));
  return value;
}
function laneJob(w: Workflow, name: string): Job {
  if (OPERATION_MATRIX_LANES.includes(name)) {
    // Separate/direct jobs cannot silently displace the required matrix item.
    expect(w.jobs[name]).toBeUndefined();
    const job = w.jobs["operation-gates"];
    expect(job, "ci.yml must define the required operation-gates matrix").toBeDefined();
    expect(job.strategy?.matrix).toEqual({ lane: OPERATION_MATRIX_LANES });
    expect(job.strategy?.["fail-fast"]).toBe(false);
    expect(job.if).toBeUndefined();
    expect(job["continue-on-error"] ?? false).toBe(false);
    return matrixStrings(job, name) as Job;
  }
  const found = w.jobs[name];
  expect(found, `ci.yml must define a \`${name}\` job`).toBeDefined();
  return found;
}
const jobOf = (name: string): Job => laneJob(workflow, name);
const cmd = (step: Step): string => step.run?.trim() ?? "";
const indexOfCommand = (j: Job, command: string): number => j.steps.findIndex((step) => cmd(step) === command);
const indexOfName = (j: Job, name: string): number => j.steps.findIndex((step) => step.name === name);
const stepNamed = (j: Job, name: string): Step => {
  const found = j.steps.find((step) => step.name === name);
  expect(found, `step "${name}" must exist`).toBeDefined();
  return found as Step;
};
const lines = (text: string | undefined): string[] => (text ?? "").split(/\r?\n/).map((line) => line.trim());

/**
 * Every binary the workflows download, with the checksum that was reviewed.
 *
 * The values come from each project's own release, fetched 2026-09-30 and
 * cross-checked against the sha256 GitHub reports for the asset: OPA's
 * `opa_linux_amd64_static.sha256`, OpenTofu's `tofu_1.12.5_SHA256SUMS`,
 * Temporal's `checksums.txt`, actionlint's `actionlint_1.7.12_checksums.txt`.
 * Bumping a version is a deliberate edit to the workflow AND to this table;
 * Dependabot does not manage them.
 */
const DOWNLOADS = [
  { job: "recovery", url: "https://github.com/temporalio/cli/releases/download/v1.9.1/temporal_cli_1.9.1_linux_amd64.tar.gz", file: "temporal_cli.tar.gz", sha256: "09a0326a51db84d02735e53542b9ebd8c4758daf47482a9ab0abce15844e60d5" },
  {
    job: "verify",
    url: "https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_linux_amd64.tar.gz",
    file: "actionlint.tar.gz",
    sha256: "8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8",
  },
  {
    job: "policy",
    url: "https://github.com/open-policy-agent/opa/releases/download/v1.19.1/opa_linux_amd64_static",
    file: "opa-bin/opa",
    sha256: "c9f985ce0d345f5484006ade2c695ed9e3f308e4441139e46695c5c182ac0839",
  },
  {
    job: "tofu",
    url: "https://github.com/opentofu/opentofu/releases/download/v1.12.5/tofu_1.12.5_linux_amd64.tar.gz",
    file: "tofu.tar.gz",
    sha256: "a6894d45ae7a17ce83189cce8fe04b5a65f68cefceb62455b5a6a89fa53ab38f",
  },
  {
    job: "platform-postgres",
    url: "https://github.com/opentofu/opentofu/releases/download/v1.12.5/tofu_1.12.5_linux_amd64.tar.gz",
    file: "tofu.tar.gz",
    sha256: "a6894d45ae7a17ce83189cce8fe04b5a65f68cefceb62455b5a6a89fa53ab38f",
  },
  {
    job: "workflows",
    url: "https://github.com/temporalio/cli/releases/download/v1.9.1/temporal_cli_1.9.1_linux_amd64.tar.gz",
    file: "temporal_cli.tar.gz",
    sha256: "09a0326a51db84d02735e53542b9ebd8c4758daf47482a9ab0abce15844e60d5",
  },
  {
    job: "operation-gates",
    url: "https://github.com/temporalio/cli/releases/download/v1.9.1/temporal_cli_1.9.1_linux_amd64.tar.gz",
    file: "temporal_cli.tar.gz",
    sha256: "09a0326a51db84d02735e53542b9ebd8c4758daf47482a9ab0abce15844e60d5",
  },
] as const;

const VERIFY_LINE = /^printf '%s {2}%s\\n' '([0-9a-f]{64})' '([^']+)' \| sha256sum --check --strict$/;

interface Fetch {
  workflow: string;
  job: string;
  step: string;
  output: string;
  url: string;
  sha256?: string;
  verifiedFile?: string;
}

/** Every `curl` that downloads something (tick.yml only POSTs to the project's own deployment). */
function fetches(): Fetch[] {
  const found: Fetch[] = [];
  for (const [file, w] of Object.entries(ALL_WORKFLOWS)) {
    if (file === "tick.yml") continue;
    for (const [jobName, j] of Object.entries(w.jobs)) {
      for (const step of j.steps) {
        const body = lines(step.run);
        body.forEach((line, at) => {
          if (!line.startsWith("curl ")) return;
          const output = line.match(/--output (\S+)/)?.[1] ?? "";
          const url = line.match(/(https?:\/\/\S+)$/)?.[1] ?? "";
          const verify = body.slice(at + 1).map((next) => next.match(VERIFY_LINE)).find((match) => match);
          found.push({
            workflow: file,
            job: jobName,
            step: step.name ?? "(unnamed)",
            output,
            url,
            sha256: verify?.[1],
            verifiedFile: verify?.[2],
          });
        });
      }
    }
  }
  return found;
}

describe("downloaded tools are checksum-verified before anything touches them", () => {
  it("has a pinned URL, output name and sha256 for every curl in every workflow, and no others", () => {
    const seen = fetches()
      .map((one) => ({ job: one.job, url: one.url, file: one.output, sha256: one.sha256 }))
      .sort((a, b) => a.url.localeCompare(b.url) || a.job.localeCompare(b.job));
    const expected = DOWNLOADS.map((one) => ({ ...one })).sort((a, b) => a.url.localeCompare(b.url) || a.job.localeCompare(b.job));
    expect(seen).toEqual(expected);
  });

  it("downloads only over https from github.com releases, bounded, with retries and redirects explicit", () => {
    for (const one of fetches()) {
      expect(one.url, `${one.job}: ${one.step}`).toMatch(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/releases\/download\/v[\d.]+\/[\w.-]+$/);
      const line = lines(stepNamed(jobOf(one.job), one.step).run).find((candidate) => candidate.startsWith("curl "));
      for (const flag of ["--fail", "--location", "--retry 3", "--connect-timeout 15", "--max-time"])
        expect(line, `${one.job}: ${one.step} must pass ${flag}`).toContain(flag);
      expect(line).not.toMatch(/(--insecure|\s-k\s|--proto-redir|--no-verify)/);
    }
  });

  it("puts a sha256sum --check --strict for exactly the downloaded file after every curl and before any other use of it", () => {
    for (const one of fetches()) {
      const label = `${one.job}: ${one.step}`;
      expect(one.sha256, `${label} must verify its download`).toMatch(/^[0-9a-f]{64}$/);
      expect(one.verifiedFile, `${label} must verify the file it downloaded`).toBe(one.output);

      const body = lines(stepNamed(jobOf(one.job), one.step).run);
      const curl = body.findIndex((line) => line.startsWith("curl "));
      const verified = body.findIndex((line) => VERIFY_LINE.test(line));
      expect(verified, label).toBeGreaterThan(curl);
      // Nothing between the download and the check may read, execute or unpack the file.
      for (const between of body.slice(curl + 1, verified))
        expect(between, `${label}: ${between} touches ${one.output} before it is verified`).not.toContain(one.output);
      // After it, unpacking must name the one member it wants, not extract everything.
      for (const after of body.slice(verified + 1).filter((line) => line.startsWith("tar ")))
        expect(after, label).toMatch(/^tar -x\w+ \S+ -C \S+ \S+$/);
    }
  });

  it("never pipes a download into a shell, never uses wget, and never runs sha256sum without --check --strict", () => {
    for (const [file, w] of Object.entries(ALL_WORKFLOWS))
      for (const step of stepsOf(w)) {
        const text = step.run ?? "";
        expect(text, `${file}: ${step.name}`).not.toMatch(/curl[^\n|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/);
        expect(text, `${file}: ${step.name}`).not.toMatch(/\bwget\b/);
        for (const line of lines(text).filter((candidate) => candidate.includes("sha256sum")))
          expect(line, `${file}: ${step.name}`).toContain("sha256sum --check --strict");
      }
  });

  it("installs the exact OPA and OpenTofu versions the code itself refuses to run without", () => {
    // policy/build.mjs aborts on any other OPA; src/lib/tofu/binary.ts on any other tofu.
    const opa = fs.readFileSync(path.join(process.cwd(), "policy/build.mjs"), "utf8").match(/OPA_VERSION = "([^"]+)"/)?.[1];
    const tofu = fs.readFileSync(path.join(process.cwd(), "src/lib/tofu/types.ts"), "utf8").match(/TOFU_VERSION\s*=\s*"([^"]+)"/)?.[1];
    expect(opa).toBeDefined();
    expect(tofu).toBeDefined();
    expect(DOWNLOADS.find((one) => one.job === "policy")?.url).toContain(`/v${opa}/`);
    expect(DOWNLOADS.find((one) => one.job === "tofu")?.url).toContain(`/v${tofu}/`);
    expect(DOWNLOADS.find((one) => one.job === "platform-postgres")?.url).toContain(`/v${tofu}/`);
  });
});

describe("toolchain and trust rules that hold for every workflow", () => {
  it("pins every `uses:` to a full commit SHA with its version in a trailing comment", () => {
    for (const file of Object.keys(ALL_WORKFLOWS)) {
      const uses = code(file).split(/\r?\n/).filter((line) => /^\s*(-\s+)?uses:/.test(line));
      for (const line of uses)
        expect(line, `${file}: ${line.trim()}`).toMatch(/uses:\s+[\w.-]+\/[\w./-]+@[0-9a-f]{40}\s+#\s*v\d+(\.\d+){0,2}\s*$/);
    }
  });

  it("uses one commit per action across all workflows", () => {
    const byAction = new Map<string, Set<string>>();
    for (const w of Object.values(ALL_WORKFLOWS))
      for (const step of stepsOf(w).filter((one) => one.uses)) {
        const [action, sha] = String(step.uses).split("@");
        byAction.set(action, (byAction.get(action) ?? new Set()).add(sha));
      }
    expect([...byAction.keys()].sort()).toEqual([
      "actions/cache",
      "actions/checkout",
      "actions/setup-go",
      "actions/setup-node",
      "actions/upload-artifact",
      "aws-actions/configure-aws-credentials",
    ]);
    for (const [action, shas] of byAction) expect([...shas], `${action} must have one pin`).toHaveLength(1);
  });

  it("pins Node exactly in every job that runs npm, npx, node or tsx, before the first time it does", () => {
    const usesNode = /(^|[\s;&|(])(npm|npx|node|tsx)(\s|$)/;
    let jobsChecked = 0;
    for (const [file, w] of Object.entries(ALL_WORKFLOWS))
      for (const [name, j] of Object.entries(w.jobs)) {
        const first = j.steps.findIndex((step) => usesNode.test(step.run ?? ""));
        if (first < 0) continue;
        jobsChecked += 1;
        const setup = j.steps.findIndex((step) => step.uses?.startsWith("actions/setup-node@"));
        expect(setup, `${file}: ${name} runs node tools but never sets Node up`).toBeGreaterThanOrEqual(0);
        expect(setup, `${file}: ${name} sets Node up after it first uses it`).toBeLessThan(first);
        expect(String(j.steps[setup].with?.["node-version"])).toBe(NODE_VERSION);
      }
    // ci.yml: verify, postgres, hosted, agent, build, policy, tofu, workflows,
    // platform-postgres, ledger, supply-chain; agent-control; live-acceptance.
    expect(jobsChecked).toBeGreaterThanOrEqual(13);
  });

  it("has no pull_request_target trigger in any workflow", () => {
    for (const [file, w] of Object.entries(ALL_WORKFLOWS)) {
      expect(Object.keys(w.on), file).not.toContain("pull_request_target");
      expect(code(file), file).not.toContain("pull_request_target");
    }
  });

  it("gives every ci.yml job a timeout, so a hung lane cannot hold a runner for six hours", () => {
    for (const [name, j] of Object.entries(workflow.jobs)) {
      expect(typeof j["timeout-minutes"], name).toBe("number");
      expect(Number(j["timeout-minutes"]), name).toBeLessThanOrEqual(45);
    }
    // Serial full-suite runs take about 16 minutes before setup/typecheck/lint.
    expect(Number(workflow.jobs.verify["timeout-minutes"])).toBeGreaterThanOrEqual(30);
  });

  it("allows no continue-on-error for CI gates", () => {
    const tolerant = Object.entries(workflow.jobs).flatMap(([name, j]) => {
      expect(j["continue-on-error"] ?? false, `${name} must not continue on error`).toBe(false);
      return j.steps.filter((step) => step["continue-on-error"]).map((step) => `${name}: ${step.name}`);
    });
    expect(tolerant).toEqual([]);
  });

  it("keeps every cloud credential and the live sandbox out of ci.yml, agent-control.yml and tick.yml", () => {
    for (const file of ["ci.yml", "agent-control.yml", "tick.yml"])
      for (const forbidden of [
        "configure-aws-credentials",
        "id-token",
        "role-to-assume",
        "live-sandbox",
        "LIVE_SANDBOX",
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
      ])
        expect(code(file), `${file} must not mention ${forbidden}`).not.toContain(forbidden);
  });

  it("names every lane-report lane the script knows, and reads the file its own vitest step wrote", () => {
    const usage = spawnSync(process.execPath, [path.resolve("scripts/ci/lane-report.mjs"), "no-such-lane", "x.json"], { encoding: "utf8" });
    const known = usage.stderr.match(/<([\w|-]+)>/)?.[1]?.split("|") ?? [];
    expect(known.sort()).toEqual(["platform-postgres", "policy", "recovery", "tofu", "workflows"]);

    const reports = Object.entries(workflow.jobs).flatMap(([name, j]) =>
      j.steps
        .filter((step) => cmd(step).startsWith("node scripts/ci/lane-report.mjs "))
        .map((step) => ({ name, j, step, args: cmd(step).split(/\s+/).slice(2) }))
    );
    expect(reports.map((one) => one.args[0]).sort()).toEqual(["platform-postgres", "policy", "recovery", "tofu", "workflows"]);
    for (const { name, j, step, args } of reports) {
      expect(known, `${name} names an unknown lane`).toContain(args[0]);
      expect(step.if, `${name}: the lane report must run even when the suites failed`).toBe("always()");
      expect(step["continue-on-error"] ?? false).toBe(false);
      const run = gateRun(args[0]);
      expect(j.steps.map(cmd), `${name} must invoke the canonical gate`).toContain(run);
      const manifest = manifestFor(args[0]);
      expect(manifest.report).toBe(args[1]);
      expect(manifest.command).toContain(`--outputFile.json=${args[1]}`);
      expect(manifest.command).toContain("--reporter=json");
      expect(args).toHaveLength(2);
      expect(indexOfCommand(j, cmd(step))).toBeGreaterThan(indexOfCommand(j, run));
    }
  });
});

describe("canonical execution and evidence in CI", () => {
  it.each(Object.keys(GATE_LANES))("%s always validates the exact report its shared command writes", (lane) => {
    const job = jobOf(lane);
    const manifest = manifestFor(lane);
    const execute = job.steps.filter((step) => cmd(step) === gateRun(lane));
    const validate = job.steps.filter((step) => cmd(step) === gateValidate(lane));
    expect(execute).toHaveLength(1);
    expect(execute[0].if).toBeUndefined();
    expect(execute[0]["continue-on-error"] ?? false).toBe(false);
    expect(validate).toHaveLength(1);
    expect(validate[0].if).toBe("always()");
    expect(validate[0]["continue-on-error"] ?? false).toBe(false);
    expect(job.steps.indexOf(validate[0])).toBeGreaterThan(job.steps.indexOf(execute[0]));
    expect(manifest.command).toContain(`--outputFile.json=${manifest.report}`);
    expect(manifest.command).toContain("--reporter=json");
    expect(manifest.command).toContain("--maxWorkers=1");
    expect(manifest.command).toContain("--no-file-parallelism");
    expect(manifest.command).not.toContain("--passWithNoTests");
    expect(manifest.requirements.length).toBeGreaterThan(0);
    // The canonical runner applies these flags even if ambient job env is absent.
    for (const [name, value] of Object.entries(manifest.env)) if (job.env?.[name] !== undefined) expect(String(job.env[name])).toBe(value);
  });

  it("keeps every core command in the same manifest and invokes each mandatory step", () => {
    for (const check of CORE_CHECKS) expect(workflow.jobs.verify.steps.map(cmd)).toContain(coreRun(check.id));
    const typecheck = workflow.jobs.verify.steps.find(step => step.name === "Typecheck");
    expect(typecheck?.env).toEqual({ NODE_OPTIONS: "--max-old-space-size=5120" });
    expect(workflow.jobs.verify.env?.NODE_OPTIONS).toBeUndefined();
    for (const step of workflow.jobs.verify.steps.filter(step => step !== typecheck))
      expect(step.env?.NODE_OPTIONS).toBeUndefined();
    expect(CORE_CHECKS.find((check: { id: string }) => check.id === "unit")?.command).toContain("--project=node");
    expect(CORE_CHECKS.find((check: { id: string }) => check.id === "unit")?.command).toContain("--project=dom");
    expect(manifestFor("fresh").steps[0].command).toEqual(["npm", "ci", "--ignore-scripts"]);
  });

  it("requires local Temporal replay and pinned public source acquisition, retaining all external blockers", () => {
    const manifest = manifestFor("workflows");
    expect(manifest.env).toMatchObject({ ZENITH_REPLAY_LANE: "1", ZENITH_TEST_TEMPORAL: "1", ZENITH_TEST_SOURCE_GITHUB: "1", ZENITH_TEST_SOURCE_REF: "37be7340536ccb68ae4bb49294e8ab3799d1f01b" });
    for (const file of ["tests/workflows/codec-replay.test.ts", "tests/workflows/destroy-replay.test.ts", "tests/platform/source-bundle.test.ts"]) expect(manifest.requirements).toContainEqual(expect.objectContaining({ file }));
    expect(manifest.excludeFiles).toEqual(["tests/workflows/mtls-live.test.ts", "tests/platform/codebuild-launch-authority.test.ts", "tests/workflows/start-intent.test.ts", "tests/workflows/history-record.test.ts"]);
    for (const file of manifest.excludeFiles.slice(1, 3)) {
      const requiredLane = file === "tests/platform/codebuild-launch-authority.test.ts" ? "platform-postgres" : "workflow-intents";
      const required = manifestFor(requiredLane);
      expect(required.files).toContain(file);
      expect(required.excludeFiles).not.toContain(file);
      expect(required.requirements.filter((item) => item.file === file && item.test && (item.postgres || item.backend === "postgres")).length).toBeGreaterThan(0);
      expect(jobOf(requiredLane).steps.map(cmd)).toContain(gateRun(requiredLane));
      expect(jobOf(requiredLane).steps.map(cmd)).toContain(gateValidate(requiredLane));
      expect(manifest.requirements.some((item) => item.file === file)).toBe(false);
    }
    expect(manifest.externalAcceptance).toEqual(EXTERNAL_ACCEPTANCE);
    expect(manifest.externalAcceptance).toHaveLength(EXTERNAL_ACCEPTANCE.length);
    expect(new Set(manifest.externalAcceptance.map(item => item.id)).size).toBe(EXTERNAL_ACCEPTANCE.length);
    expect(manifest.externalAcceptance[0]).toMatchObject({ id: "external-temporal-mtls", releaseBlocker: expect.stringContaining("unverified") });
    for (const external of manifest.externalAcceptance) expect(external.releaseBlocker).toContain("unverified");
    expect(manifest.tools).toMatchObject({ node: NODE_VERSION, temporal: "1.9.1" });
  });

  it.each(Object.keys(GATE_LANES))("%s uploads only sanitized evidence after validation even on failure", (lane) => {
    const job = jobOf(lane);
    const uploads = job.steps.filter((step) => step.uses?.startsWith("actions/upload-artifact@"));
    expect(uploads).toHaveLength(1);
    const upload = uploads[0];
    expect(upload.uses).toBe("actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02");
    expect(upload.if).toBe("always()");
    expect(upload["continue-on-error"] ?? false).toBe(false);
    // The artifact embeds only a validated scalar receipt. The immutable local
    // sidecar must never be uploaded raw after malformed or hostile input.
    expect(upload.with?.path).toBe(`.data-ci-lane/${lane}-evidence.json`);
    expect(upload.with?.["if-no-files-found"]).toBe("error");
    expect(upload.with?.name).toBe(`canonical-${lane}-evidence-` + "${{ github.sha }}");
    expect(upload.with?.["retention-days"]).toBe(14);
    expect(job.steps.indexOf(upload)).toBeGreaterThan(indexOfCommand(job, gateValidate(lane)));
    expect(String(upload.with?.path)).not.toContain("*");
    expect(String(upload.with?.path)).not.toContain("lane.json");
  });
});

describe("the policy job", () => {
  const policy = (): Job => jobOf("policy");

  it("installs OPA, then proves the bundle reproducible, then runs the suites, in that order", () => {
    const install = indexOfName(policy(), "Install pinned OPA");
    const bundle = indexOfCommand(policy(), "npm run policy:check");
    const suites = indexOfCommand(policy(), POLICY_VITEST);
    expect(install).toBeGreaterThan(indexOfCommand(policy(), INSTALL));
    expect(bundle).toBeGreaterThan(install);
    expect(suites).toBeGreaterThan(bundle);
  });

  it("hands the verified binary to the build and the parity suite by absolute path, not PATH", () => {
    const install = stepNamed(policy(), "Install pinned OPA");
    expect(install.shell).toBe("bash");
    expect(install.run).toContain('echo "ZENITH_OPA_BIN=$RUNNER_TEMP/opa-bin/opa" >> "$GITHUB_ENV"');
    // Both consumers read ZENITH_OPA_BIN, which is what makes the above sufficient.
    for (const file of ["policy/build.mjs", "tests/policy/parity.test.ts"])
      expect(fs.readFileSync(path.join(process.cwd(), file), "utf8"), file).toContain("ZENITH_OPA_BIN");
  });
});

describe("the tofu job", () => {
  const tofu = (): Job => jobOf("tofu");

  it("turns the network suites on and never runs against a tofu it did not verify", () => {
    expect(tofu().env?.ZENITH_TEST_TOFU_NETWORK).toBe("1");
    const install = stepNamed(tofu(), "Install pinned OpenTofu");
    expect(install.run).toContain('echo "ZENITH_TOFU_BIN=$RUNNER_TEMP/tofu-bin/tofu" >> "$GITHUB_ENV"');
    expect(indexOfName(tofu(), "Install pinned OpenTofu")).toBeLessThan(indexOfCommand(tofu(), TOFU_VITEST));
  });

  it("runs all provider suites and fails when no suites exist, serially", () => {
    expect(cmd(tofu().steps[indexOfCommand(tofu(), TOFU_VITEST)])).toBe(gateRun("tofu"));
    const command = manifestFor("tofu").command.join(" ");
    expect(command).toContain("tests/tofu tests/providers/aws/drivers");
    expect(command).toContain("tests/providers/aws/identity");
    expect(command).not.toContain("--passWithNoTests");
    for (const provider of ["gcp", "azure", "oci"]) expect(command).toContain(`tests/providers/${provider}`);
    // One plugin cache shared by every test; a first install is not something to race on.
    expect(command).toContain("--no-file-parallelism");
  });

  it("caches provider plugins on the lockfiles, exact match only, restored before the tests run", () => {
    const cache = tofu().steps.find((step) => step.uses?.startsWith("actions/cache@"));
    expect(cache, "the job must cache provider plugins").toBeDefined();
    const key = String(cache?.with?.key);
    expect(key).toContain("hashFiles('src/lib/tofu/locks/*.terraform.lock.hcl')");
    expect(cache?.with?.["restore-keys"], "a prefix hit would restore the wrong provider versions").toBeUndefined();
    expect(String(cache?.with?.path)).toBe("${{ runner.temp }}/tofu-plugin-cache");
    expect(stepNamed(tofu(), "Choose the provider plugin cache directory").run).toContain(
      'echo "ZENITH_TOFU_PLUGIN_CACHE=$RUNNER_TEMP/tofu-plugin-cache" >> "$GITHUB_ENV"'
    );
    expect(tofu().steps.indexOf(cache as Step)).toBeLessThan(indexOfCommand(tofu(), TOFU_VITEST));
    // hashFiles of a glob that matches nothing is the empty string: a key that never changes.
    const locks = fs.readdirSync(path.join(process.cwd(), "src/lib/tofu/locks")).filter((name) => name.endsWith(".terraform.lock.hcl"));
    expect(locks.length).toBeGreaterThan(0);
  });
});

describe("the Go job", () => {
  const go = (): Job => jobOf("go");
  const GUARD = "hashFiles('go/go.mod') != ''";
  const NATIVE = "Required native Linux race and authentic golden comparison";
  const SETUP = "Provision strictly disposable Linux guest fixtures";
  const CLEANUP = "Remove only owned drained Linux guest fixtures";
  const SELECT = "Select only current-attempt sanitized guest evidence";
  const UPLOAD = "Preserve sanitized native guest evidence";
  const alwaysGuard = "always() && " + GUARD;
  const cleanupGuard = "always() && hashFiles('go/go.mod') != '' && (steps.systemd_fixture.outcome == 'skipped' || steps.systemd_cleanup.outcome == 'success')";
  const uploadGuard = "always() && steps.guest_evidence.outcome == 'success' && steps.guest_evidence.outputs.evidence_path != ''";

  it("works in go/ and refuses to fetch another toolchain", () => {
    expect(go().defaults?.run?.["working-directory"]).toBe("go");
    expect(go().env?.GOTOOLCHAIN).toBe("local");
    expect(go().if, "hashFiles is not available in a job-level if").toBeUndefined();
    expect(go()["continue-on-error"] ?? false).toBe(false);
  });

  it("is skipped visibly, step by step, until go/go.mod exists", () => {
    const [checkout, ...rest] = go().steps;
    expect(checkout.uses).toMatch(/^actions\/checkout@/);
    const skipNotice = rest.filter((step) => step.if === "hashFiles('go/go.mod') == ''");
    expect(skipNotice, "exactly one step says the lane did not run").toHaveLength(1);
    expect(skipNotice[0].run).toContain("did NOT run");
    expect(skipNotice[0].run).toContain("GITHUB_STEP_SUMMARY");
    // `defaults.run.working-directory: go` would point at a directory that does not exist yet.
    expect(skipNotice[0]["working-directory"]).toBe(".");
    const specialConditions = new Map([
      [CLEANUP, cleanupGuard],
      [SELECT, alwaysGuard],
      [UPLOAD, uploadGuard],
      ["Vet the explicit real systemd acceptance packages", "success() && steps.native_guest.outcome == 'success'"],
      ["Provision only the owned inert systemd unit and restart-only rule", "success() && steps.native_guest.outcome == 'success'"],
      ["Required ordered real systemd operations and signed execution", "success() && steps.systemd_fixture.outcome == 'success'"],
      ["Remove only the owned settled systemd fixture", "always() && (steps.systemd_fixture.outcome == 'success' || steps.systemd_fixture.outcome == 'failure')"],
      ["Select only the current systemd attempt after both owned cleanups", "always() && steps.systemd_fixture.outcome == 'success'"],
      ["Preserve sanitized real systemd evidence", "always() && steps.systemd_evidence.outcome == 'success' && steps.systemd_evidence.outputs.evidence_path != ''"],
    ]);
    for (const name of specialConditions.keys()) expect(rest.filter((step) => step.name === name)).toHaveLength(1);
    for (const step of rest.filter((one) => !skipNotice.includes(one))) {
      expect(step.if, `${step.name ?? step.uses} must be guarded`).toBe(specialConditions.get(step.name ?? "") ?? GUARD);
      expect(step["continue-on-error"] ?? false).toBe(false);
    }
  });

  it("sets up exactly Go 1.27.1 and checks it", () => {
    const setup = go().steps.find((step) => step.uses?.startsWith("actions/setup-go@"));
    expect(setup?.with?.["go-version"]).toBe("1.27.1");
    // go.sum does not exist for a module with no dependencies; setup-go fails on a cache key with nothing to hash.
    expect(String(setup?.with?.["cache-dependency-path"])).toContain("go/go.mod");
    expect(String(setup?.with?.["cache-dependency-path"])).toContain("go/go.sum");
    expect(stepNamed(go(), "Toolchain is exactly the pinned one").run).toContain('test "$(go env GOVERSION)" = "go1.27.1"');
  });

  it("checks gofmt, vet, the race detector and a cgo-free cross-build for both linux targets", () => {
    const gofmt = stepNamed(go(), "gofmt").run ?? "";
    expect(gofmt).toContain('unformatted="$(gofmt -l .)"');
    expect(gofmt).toContain('if [ -n "$unformatted" ]');
    expect(gofmt).toContain("exit 1");

    expect(indexOfCommand(go(), "go vet ./...")).toBeGreaterThan(0);

    const race = stepNamed(go(), NATIVE);
    expect(race.id).toBe("native_guest");
    expect(race.shell).toBe("bash");
    expect(race["working-directory"]).toBe(".");
    expect(cmd(race)).toBe([
      "set -euo pipefail",
      'attempt_id="$(node --input-type=module -e \'import { randomBytes } from "node:crypto"; console.log(randomBytes(16).toString("hex"))\')"',
      'echo "expected_attempt_id=$attempt_id" >> "$GITHUB_OUTPUT"',
      'ZENITH_GUEST_ATTEMPT_ID="$attempt_id" node scripts/ci/run-guest-file-write-gate.mjs --run',
    ].join("\n"));
    const native = linuxGuestManifest();
    expect(native.command).toEqual(["node", "scripts/ci/run-guest-file-write-gate.mjs", "--run"]);
    expect(native.steps.find((step) => step.id === "race")?.command).toEqual(["go", "test", "-json", "-race", "-count=1", "./...", "-skip", "^(TestPackageHelperNativeNoFollowAndCustody|TestPackageFrontendLockIndependentProcess|TestPackageNativeSignedFirstInstallAndNonReplay|TestPackageNativeDeclaredMountAndACLRefusals|TestSystemdSignedUpdateAndRollback)$"]);
    const packageTools = stepNamed(go(), "Require local native package fixture tools");
    expect(packageTools.if).toBe("hashFiles('go/go.mod') != ''");
    expect(cmd(packageTools)).toBe("set -euo pipefail\ncommand -v docker >/dev/null\ncommand -v python3 >/dev/null\npython3 -c 'import sys; assert sys.version_info >= (3, 10)'");
    expect(go().steps.indexOf(packageTools)).toBeLessThan(go().steps.indexOf(race));
    expect(native.packagePhase.env).toEqual({ ZENITH_TEST_PACKAGE_INSTALL_REQUIRED: "1" });
    expect(native.packagePhase.allowedSkips).toEqual([]);
    expect(native.pid1Phase.requiredCases).toEqual(LINUX_GUEST_PID1_CASES);
    expect(native.pid1Phase.requiredPackages).toEqual(["github.com/GODOSTROYER/zenith/go/internal/runner/update"]);
    expect(native.pid1Phase.noTestPackages).toEqual([]); expect(native.pid1Phase.allowedSkips).toEqual([]);
    expect(native.pid1Phase.baseImage).toMatch(/^ubuntu:24\.04@sha256:[a-f0-9]{64}$/);
    expect(native.pid1Phase.builderImage).toMatch(/^moby\/buildkit:buildx-stable-1@sha256:[a-f0-9]{64}$/);
    expect(native.requiredCases).toEqual([...native.raceCases, ...native.packagePhase.requiredCases, ...native.pid1Phase.requiredCases]);
    expect(native.raceCases).toHaveLength(154); expect(native.requiredCases).toHaveLength(159);
    expect(native.env.CGO_ENABLED, "the race detector needs cgo").toBe("1");

    const build = stepNamed(go(), "Cross-build linux/amd64 and linux/arm64 without cgo");
    expect(build.shell).toBe("bash");
    expect(cmd(build)).toBe([
      "set -euo pipefail",
      "for target in linux/amd64 linux/arm64; do",
      '  echo "--- ${target}"',
      '  CGO_ENABLED=0 GOOS="${target%/*}" GOARCH="${target#*/}" go build -trimpath ./...',
      "done",
    ].join("\n"));

    const order = ["gofmt", "go vet", SETUP, NATIVE, "Cross-build linux/amd64 and linux/arm64 without cgo"].map((name) =>
      indexOfName(go(), name)
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((at) => at > 0)).toBe(true);
  });

  it("sets up owned fixtures, always attempts drained cleanup, and selects only the observed current report", () => {
    const job = go();
    for (const name of [SETUP, NATIVE, CLEANUP, SELECT, UPLOAD]) expect(job.steps.filter((step) => step.name === name)).toHaveLength(1);
    const setup = stepNamed(job, SETUP);
    const cleanup = stepNamed(job, CLEANUP);
    for (const step of [setup, cleanup]) {
      expect(step["working-directory"]).toBe(".");
      expect(step.shell).toBe("bash");
    }
    expect(cmd(setup)).toBe([
      "set -euo pipefail",
      'fixture_run_id="$(node --input-type=module -e \'import { randomBytes } from "node:crypto"; console.log(randomBytes(16).toString("hex"))\')"',
      'echo "ZENITH_GUEST_FIXTURE_RUN_ID=$fixture_run_id" >> "$GITHUB_ENV"',
      "# The pinned hosted image makes /opt writable. Observe the actual",
      "# disposable VM, then harden only its no-follow /opt inode to0755;",
      "# unsupported roots/ACLs/mount authority still refuse before setup.",
      'sudo --preserve-env=GITHUB_ACTIONS,RUNNER_ENVIRONMENT,RUNNER_OS -- python3 scripts/ci/prepare-native-guest-host.py --github-hosted-disposable "$(id -u)" "$(id -g)" "$fixture_run_id"',
      'sudo -- bash scripts/ci/guest-file-write-fixtures.sh setup "$(id -u)" "$(id -g)" "$fixture_run_id"',
    ].join("\n"));
    expect(cleanup.if).toBe(cleanupGuard);
    expect(cmd(cleanup)).toBe([
      "set -euo pipefail",
      'test -n "${ZENITH_GUEST_FIXTURE_RUN_ID:-}"',
      'sudo -- bash scripts/ci/guest-file-write-fixtures.sh cleanup "$(id -u)" "$(id -g)" "$ZENITH_GUEST_FIXTURE_RUN_ID"',
    ].join("\n"));
    const select = stepNamed(job, SELECT);
    expect(select.id).toBe("guest_evidence");
    expect(select.if).toBe(alwaysGuard);
    expect(select["working-directory"]).toBe(".");
    expect(cmd(select)).toBe("node scripts/ci/run-guest-file-write-gate.mjs --select-current");
    expect(select.env).toEqual({
      ZENITH_EXPECTED_GUEST_ATTEMPT: "${{ steps.native_guest.outputs.expected_attempt_id }}",
      ZENITH_GUEST_EVIDENCE_ATTEMPT: "${{ steps.native_guest.outputs.attempt_id }}",
      ZENITH_GUEST_EVIDENCE_PATH: "${{ steps.native_guest.outputs.evidence_path }}",
      ZENITH_GUEST_EVIDENCE_SHA256: "${{ steps.native_guest.outputs.evidence_sha256 }}",
      ZENITH_GUEST_RUNNER_EXIT_CODE: "${{ steps.native_guest.outputs.runner_exit_code }}",
      ZENITH_GUEST_RUNNER_OUTCOME: "${{ steps.native_guest.outcome }}",
    });
    const upload = stepNamed(job, UPLOAD);
    expect(upload.if).toBe(uploadGuard);
    expect(upload.uses).toMatch(/^actions\/upload-artifact@[a-f0-9]{40}$/);
    expect(upload.with).toEqual({
      name: "canonical-linux-guest-evidence-${{ github.sha }}-${{ steps.native_guest.outputs.expected_attempt_id }}",
      path: "${{ steps.guest_evidence.outputs.evidence_path }}",
      "include-hidden-files": true,
      "if-no-files-found": "error",
      "retention-days": 14,
    });
    const order = [SETUP, NATIVE, "TypeScript validates the Go machine result goldens", "Cross-build linux/amd64 and linux/arm64 without cgo", CLEANUP, SELECT, UPLOAD].map((name) => indexOfName(job, name));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((at) => at > 0)).toBe(true);
  });
});

describe("the workflows job", () => {
  const wf = (): Job => jobOf("workflows");

  it("installs a verified Temporal CLI, asserts its version, and exports its path to the tests", () => {
    const install = stepNamed(wf(), "Install pinned Temporal CLI");
    expect(install.shell).toBe("bash");
    expect(install.run).toContain('echo "ZENITH_TEST_TEMPORAL_CLI=$RUNNER_TEMP/temporal-cli/temporal" >> "$GITHUB_ENV"');
    // The version the URL downloads is the one the step insists on.
    const pinned = DOWNLOADS.find((one) => one.job === "workflows")?.url.match(/\/v([\d.]+)\//)?.[1];
    expect(install.run).toContain(`"temporal version ${pinned} "*) ;;`);
    expect(indexOfName(wf(), "Install pinned Temporal CLI")).toBeLessThan(indexOfCommand(wf(), WORKFLOWS_VITEST));
  });

  it("runs serially and fails when the committed suites are absent", () => {
    expect(cmd(wf().steps[indexOfCommand(wf(), WORKFLOWS_VITEST)])).toBe(gateRun("workflows"));
    const command = manifestFor("workflows").command.join(" ");
    expect(command).not.toContain("--passWithNoTests");
    expect(command).toContain("--no-file-parallelism");
  });
});

describe("the mandatory operation matrix", () => {
  const operations = (): Job => jobOf("operation-gates");
  it("expands only two exact mandatory lanes without conditional, included or excluded variants", () => {
    expect(operations().strategy).toEqual({ "fail-fast": false, matrix: { lane: OPERATION_MATRIX_LANES } });
    for (const lane of OPERATION_MATRIX_LANES) {
      const job = jobOf(lane);
      expect(job.steps.map(cmd)).toContain(gateRun(lane));
      expect(job.steps.map(cmd)).toContain(gateValidate(lane));
      expect(JSON.stringify(job)).not.toContain("${{ matrix.lane }}");
      expect(job.env?.ZENITH_DATA).toBe(`\${{ github.workspace }}/.data-ci-operation-${lane}`);
    }
  });

  it.each(["missing", "skipped", "include", "exclude", "direct override"])("rejects a %s required matrix item in the structural resolver", (mode) => {
    const altered = structuredClone(workflow);
    const job = altered.jobs["operation-gates"];
    if (mode === "missing") job.strategy!.matrix!.lane = ["reconciliation"];
    if (mode === "skipped") job.if = false;
    if (mode === "include") job.strategy!.matrix!.include = [{ lane: "workflow-intents" }];
    if (mode === "exclude") job.strategy!.matrix!.exclude = [{ lane: "workflow-intents" }];
    if (mode === "direct override") altered.jobs["workflow-intents"] = structuredClone(job);
    expect(() => laneJob(altered, "workflow-intents")).toThrow();
  });

  it("gives every matrix item its own healthy disposable loopback PostgreSQL service", () => {
    expect(operations().services?.postgres?.image).toBe(workflow.jobs.postgres.services?.postgres?.image);
    expect(operations().services?.postgres?.image).toMatch(/^postgres:16\.15-alpine@sha256:[a-f0-9]{64}$/);
    expect(operations().services?.postgres?.ports).toEqual(["5432:5432"]);
    expect(operations().services?.postgres?.options).toContain("pg_isready");
    const database = operations().services?.postgres?.env?.POSTGRES_DB;
    expect(operations().env?.ZENITH_TEST_PLATFORM_PG_URL).toBe(`postgresql://postgres:zenith-ci-throwaway@127.0.0.1:5432/${database}`);
    expect(database).toBe("zenith_operations_ci");
    for (const name of ["SUPABASE_DB_URL", "ZENITH_PLATFORM_DB", "ZENITH_PLATFORM_DB_URL", "ZENITH_CONTRACT_POSTGRES", "ZENITH_TEMPORAL_ADDRESS"]) expect(operations().env?.[name]).toBeUndefined();
    expect(operations().env?.ZENITH_DATA).toBe("${{ github.workspace }}/.data-ci-operation-${{ matrix.lane }}");
    expect(operations()["timeout-minutes"]).toBe(45);
  });

  it("copies the verified Temporal installation and requires migrations and committed OPA assets before each engine gate", () => {
    const temporal = stepNamed(operations(), "Install pinned Temporal CLI");
    expect(temporal.run).toBe(stepNamed(jobOf("workflows"), "Install pinned Temporal CLI").run);
    expect(temporal.shell).toBe("bash");
    expect(temporal.if).toBeUndefined();
    const assets = stepNamed(operations(), "Check committed policy assets");
    expect(assets.if).toBeUndefined();
    expect(assets.run).toContain('"policy/dist/manifest.json"');
    expect(assets.run).toContain('"policy/dist/policy.wasm"');
    expect(assets.run).toContain('manifest.opaVersion !== "1.19.1"');
    expect(assets.run).toContain('manifest.entrypoint !== "zenith/decision/result"');
    expect(assets.run).toContain('manifest.wasmBytes !== wasm.length');
    expect(assets.run).toContain('manifest.wasmSha256 !== createHash("sha256").update(wasm).digest("hex")');
    expect(assets.run).toContain('throw new Error("Committed policy asset integrity is unavailable.")');
    for (const lane of OPERATION_MATRIX_LANES) {
      const job = jobOf(lane);
      const migrations = job.steps.filter((step) => cmd(step) === "bash scripts/ci/apply-platform-migrations.sh");
      expect(migrations).toHaveLength(1);
      expect(migrations[0].if).toBeUndefined();
      expect(migrations[0]["continue-on-error"] ?? false).toBe(false);
      expect(job.steps.some((step) => String(step.if ?? "").includes("hashFiles"))).toBe(false);
      expect(indexOfCommand(job, INSTALL)).toBeLessThan(indexOfName(job, "Install pinned Temporal CLI"));
      expect(indexOfName(job, "Install pinned Temporal CLI")).toBeLessThan(indexOfName(job, "Check committed policy assets"));
      expect(indexOfName(job, "Check committed policy assets")).toBeLessThan(indexOfCommand(job, "bash scripts/ci/apply-platform-migrations.sh"));
      expect(indexOfCommand(job, "bash scripts/ci/apply-platform-migrations.sh")).toBeLessThan(indexOfCommand(job, gateRun(lane)));
      const upload = job.steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
      expect(upload?.with?.["include-hidden-files"]).toBe(true);
    }
  });
});

describe("the platform PostgreSQL job", () => {
  const pg = (): Job => jobOf("platform-postgres");

  it("uses the same pinned Postgres image as the hosted lane", () => {
    expect(pg().services?.postgres?.image).toBe(workflow.jobs.postgres.services?.postgres?.image);
    expect(pg().services?.postgres?.image).toMatch(/^postgres:16\.15-alpine@sha256:[a-f0-9]{64}$/);
    expect(pg().services?.postgres?.options).toContain("pg_isready");
    expect(pg().services?.postgres?.ports).toEqual(["5432:5432"]);
  });

  it("points the suites at a loopback lane database and nothing else can resolve to a different one", () => {
    const url = String(pg().env?.ZENITH_TEST_PLATFORM_PG_URL);
    const database = pg().services?.postgres?.env?.POSTGRES_DB;
    expect(url).toBe(`postgresql://postgres:zenith-ci-throwaway@127.0.0.1:5432/${database}`);
    // A stray URL in the environment must not be able to win over the lane database.
    for (const name of ["SUPABASE_DB_URL", "ZENITH_PLATFORM_DB", "ZENITH_PLATFORM_DB_URL", "ZENITH_CONTRACT_POSTGRES"])
      expect(pg().env?.[name], name).toBeUndefined();
    expect(pg().env?.ZENITH_DATA).toBe("${{ github.workspace }}/.data-ci-platform");
    for (const other of ["verify", "postgres", "hosted", "agent"])
      expect(pg().env?.ZENITH_DATA).not.toBe(workflow.jobs[other].env?.ZENITH_DATA);
  });

  it("applies the platform migrations with the new script once the migrator exists, and says so when it does not", () => {
    const apply = pg().steps[indexOfCommand(pg(), "bash scripts/ci/apply-platform-migrations.sh")];
    expect(apply, "the job must run the platform migration script").toBeDefined();
    expect(apply.if).toBe("hashFiles('scripts/platform/migrate.ts') != ''");
    const notice = pg().steps.find((step) => step.if === "hashFiles('scripts/platform/migrate.ts') == ''");
    expect(notice?.run).toContain("NOT applied");
    expect(notice?.run).toContain("GITHUB_STEP_SUMMARY");
    // After the install and before any suite.
    expect(pg().steps.indexOf(apply)).toBeGreaterThan(indexOfCommand(pg(), INSTALL));
    expect(pg().steps.indexOf(apply)).toBeLessThan(indexOfCommand(pg(), PLATFORM_VITEST));
  });

  it("leaves scripts/ci/apply-supabase-migrations.sh to the workstream that owns each migration", () => {
    // The hosted lane's script is a separate one with a pinned manifest; this lane must not
    // depend on it, or on a psql replay of SQL the platform migrator is the real path for.
    expect(pg().steps.map(cmd)).not.toContain("bash scripts/ci/apply-supabase-migrations.sh");
  });

  it("runs the control store, capabilities, runners and reconciliation serially", () => {
    expect(cmd(pg().steps[indexOfCommand(pg(), PLATFORM_VITEST)])).toBe(gateRun("platform-postgres"));
    const command = manifestFor("platform-postgres").command.join(" ");
    for (const dir of ["tests/controlplane", "tests/capabilities", "tests/runners", "tests/reconcile/platform.test.ts"]) expect(command).toContain(dir);
    expect(command).not.toContain("--passWithNoTests");
    expect(command).toContain("--no-file-parallelism");
  });

  it("keeps the helper scripts every new lane depends on", () => {
    for (const file of [
      "scripts/ci/apply-platform-migrations.sh",
      "scripts/ci/lane-report.mjs",
      "scripts/ci/lockfile-integrity.mjs",
      "scripts/build/ledger.mjs",
      "policy/build.mjs",
    ])
      expect(fs.existsSync(path.join(process.cwd(), file)), `${file} must exist`).toBe(true);
  });
});

describe("the ledger and supply-chain jobs", () => {
  it("checks the ledger markdown is current, on built-ins alone", () => {
    const ledger = jobOf("ledger");
    expect(indexOfCommand(ledger, "node scripts/build/ledger.mjs --check")).toBeGreaterThan(0);
    // Nothing is installed, so nothing is cached either.
    expect(ledger.steps.map(cmd)).not.toContain(INSTALL);
  });

  it("blocks on lockfile integrity and the complete dependency audit", () => {
    const supply = jobOf("supply-chain");
    const lockfile = supply.steps[indexOfCommand(supply, "node scripts/ci/lockfile-integrity.mjs")];
    expect(lockfile["continue-on-error"] ?? false).toBe(false);
    expect(lockfile.if).toBeUndefined();

    const audit = supply.steps[indexOfCommand(supply, "node scripts/ci/security-audit.mjs")];
    expect(audit, "the job must run the complete locked audit").toBeDefined();
    expect(audit["continue-on-error"] ?? false).toBe(false);
    expect(audit.if).toBeUndefined();
    expect(supply.steps.filter((step) => step["continue-on-error"])).toEqual([]);
  });
});

/*
 * The live acceptance workflow. It is the only place in the repository that can
 * assume an AWS role, so what matters is what can reach it: a person, by hand,
 * through an environment with reviewers, never a pull request.
 */
describe("generated recovery clients", () => {
  it("executes a generated PostgreSQL16 client with runtime identity and unchanged arguments", () => {
    const step = workflow.jobs.recovery.steps.find(step => step.name === "Use matching PostgreSQL16 recovery clients");
    expect(step?.run).toBeDefined();
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-recovery-client-"));
    try {
      const bin = path.join(scratch, "bin"), capture = path.join(scratch, "arguments");
      fs.mkdirSync(bin);
      fs.writeFileSync(path.join(bin, "docker"), `#!/usr/bin/env bash
set -euo pipefail
test "$PGPASSWORD" = "$EXPECTED_PGPASSWORD"
test "$PGSSLMODE" = "require"
printf '%s\\n' "$@" > "$CAPTURE"
`, { mode: 0o700 });
      const env: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: `${bin}${path.delimiter}${process.env.PATH}`, RUNNER_TEMP: scratch,
        GITHUB_WORKSPACE: process.cwd(), GITHUB_ENV: path.join(scratch, "env"), CAPTURE: capture };
      expect(spawnSync("bash", ["-c", step!.run!], { env, encoding: "utf8" }).status).toBe(0);
      const exported = Object.fromEntries(fs.readFileSync(env.GITHUB_ENV!, "utf8").trimEnd().split("\n").map(line => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }));
      expect(Object.keys(exported).sort()).toEqual(["TMPDIR", "ZENITH_TEST_PG_DUMP_BIN", "ZENITH_TEST_PG_RESTORE_BIN"]);
      expect(path.dirname(exported.TMPDIR)).toBe(scratch);
      expect(path.basename(exported.TMPDIR)).toMatch(/^zenith-recovery\.[A-Za-z0-9]{6}$/);
      expect(fs.lstatSync(exported.TMPDIR).isDirectory()).toBe(true);
      expect(fs.statSync(exported.TMPDIR).mode & 0o777).toBe(0o700);
      expect(fs.readdirSync(exported.TMPDIR)).toEqual([]);
      // Node creates the rehearsal files under the same path exposed by the runner-temp mount.
      const clientEnv: NodeJS.ProcessEnv = { ...env, TMPDIR: exported.TMPDIR,
        PGPASSWORD: "recovery-fixture-only-password", EXPECTED_PGPASSWORD: "recovery-fixture-only-password", PGSSLMODE: "require" };
      const tempProbe = spawnSync(process.execPath, ["-e", "process.stdout.write(require('node:os').tmpdir())"], { env: clientEnv, encoding: "utf8" });
      expect(tempProbe.status).toBe(0);
      expect(tempProbe.stdout).toBe(exported.TMPDIR);
      for (const tool of ["pg_dump", "pg_restore"]) {
        const script = path.join(scratch, "pg-tools", tool);
        expect(exported[tool === "pg_dump" ? "ZENITH_TEST_PG_DUMP_BIN" : "ZENITH_TEST_PG_RESTORE_BIN"]).toBe(script);
        expect(spawnSync("bash", ["-n", script], { env, encoding: "utf8" }).status).toBe(0);
        const client = spawnSync(script, ["--version", "argument with spaces"], { env: clientEnv, encoding: "utf8" });
        expect(client.status).toBe(0);
        expect(client.stdout).toBe("");
        expect(client.stderr).toBe("");
        expect(fs.readFileSync(capture, "utf8").trimEnd().split("\n")).toEqual([
          "run", "--rm", "--user", `${process.getuid!()}:${process.getgid!()}`, "--network", "host",
          "--env", "PGPASSWORD", "--env", "PGSSLMODE",
          "-v", `${process.cwd()}:${process.cwd()}`, "-v", `${scratch}:${scratch}`,
          "postgres:16.15-alpine@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685",
          tool, "--version", "argument with spaces",
        ]);
        expect(fs.readFileSync(script, "utf8")).not.toContain(clientEnv.PGPASSWORD);
        expect(fs.readFileSync(capture, "utf8")).not.toContain(clientEnv.PGPASSWORD);
      }
    } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
  });
});

describe("the live acceptance workflow", () => {
  const live = (): Job => liveAcceptance.jobs["aws-live"];
  const GUARD = "hashFiles('scripts/acceptance/aws-live.ts') != ''";

  it("can be started only by workflow_dispatch", () => {
    expect(Object.keys(liveAcceptance.on)).toEqual(["workflow_dispatch"]);
    for (const trigger of ["push", "pull_request", "pull_request_target", "schedule", "workflow_run", "workflow_call"])
      expect(Object.keys(liveAcceptance.on)).not.toContain(trigger);
  });

  it("waits on the live-sandbox environment, where the reviewers and branch rules live", () => {
    expect(live(), "the workflow must define an `aws-live` job").toBeDefined();
    expect(live().environment).toBe("live-sandbox");
    expect(JSON.stringify(live().env)).not.toContain("runner.");
    const paths = live().steps.find(step => step.name === "Set owned live acceptance paths");
    expect(paths?.run).toContain('echo "ZENITH_LIVE_AWS_PERMISSIONS=$RUNNER_TEMP/zenith-aws-permissions.json"');
    expect(paths?.run).toContain('echo "ZENITH_LIVE_SCOPE_FILE=$RUNNER_TEMP/zenith-live-scope.json"');
    expect(paths?.run).toContain('echo "ZENITH_LIVE_AWS_OUT=$RUNNER_TEMP/zenith-aws-production"');
    expect(paths?.run).toContain('>> "$GITHUB_ENV"');
    expect(live().steps.indexOf(paths!)).toBeLessThan(live().steps.findIndex(step => step.uses?.startsWith("aws-actions/configure-aws-credentials@")));
  });

  it("requests an OIDC token for this one job and nothing broader anywhere", () => {
    expect(liveAcceptance.permissions).toEqual({ contents: "read" });
    expect(live().permissions).toEqual({ contents: "read", "id-token": "write" });
    // The only `id-token` in any workflow.
    for (const [file, w] of Object.entries(ALL_WORKFLOWS))
      if (file !== "live-acceptance.yml") {
        expect(JSON.stringify(w.permissions ?? {}), file).not.toContain("id-token");
        for (const j of Object.values(w.jobs)) expect(JSON.stringify(j.permissions ?? {}), file).not.toContain("id-token");
      }
  });

  it("never runs two live suites at once, and never cancels one half way", () => {
    expect(liveAcceptance.concurrency).toEqual({ group: "live-acceptance", "cancel-in-progress": false });
    expect(typeof live()["timeout-minutes"]).toBe("number");
    expect(Number(live()["timeout-minutes"])).toBeLessThanOrEqual(60);
  });

  it("assumes the role through the official action, pinned, from a variable, with no stored credentials", () => {
    const assume = live().steps.find((step) => step.uses?.startsWith("aws-actions/configure-aws-credentials@"));
    expect(assume, "the job must use aws-actions/configure-aws-credentials").toBeDefined();
    expect(assume?.uses).toMatch(/^aws-actions\/configure-aws-credentials@[a-f0-9]{40}$/);
    expect(assume?.with?.["role-to-assume"]).toBe("${{ vars.LIVE_SANDBOX_AWS_ROLE_ARN }}");
    expect(String(assume?.with?.["allowed-account-ids"])).toContain("vars.LIVE_SANDBOX_AWS_ACCOUNT_ID");
    for (const input of ["aws-access-key-id", "aws-secret-access-key", "aws-session-token", "web-identity-token-file"])
      expect(assume?.with?.[input], input).toBeUndefined();
    // No secret of any kind is read: the role's trust policy is the control, not a stored key.
    expect(code("live-acceptance.yml")).not.toMatch(/secrets\./);
  });

  it("installs dependencies before any AWS credential exists, then assumes the role, then runs the script", () => {
    const steps = live().steps;
    const install = indexOfCommand(live(), INSTALL);
    const assume = steps.findIndex((step) => step.uses?.startsWith("aws-actions/configure-aws-credentials@"));
    const script = indexOfCommand(live(), "npx tsx scripts/acceptance/aws-live.ts");
    expect(install).toBeGreaterThan(0);
    expect(assume).toBeGreaterThan(install);
    expect(script).toBeGreaterThan(assume);
  });

  it("fails loudly, before assuming any role, when the acceptance script does not exist", () => {
    const missing = live().steps.find((step) => step.if === "hashFiles('scripts/acceptance/aws-live.ts') == ''");
    expect(missing?.run, "a dispatch that silently did nothing would look like a pass").toContain("exit 1");
    expect(live().steps.indexOf(missing as Step)).toBeLessThan(
      live().steps.findIndex((step) => step.uses?.startsWith("aws-actions/configure-aws-credentials@"))
    );
    // Every later step is behind the same guard, so reordering cannot request credentials for a script that is not there.
    const afterCheckout = live().steps.slice(1).filter((step) => step !== missing);
    for (const step of afterCheckout) expect(step.if, `${step.name ?? step.uses}`).toBe(GUARD);
  });

  it("checks the account configuration before requesting a token", () => {
    const preflight = stepNamed(live(), "Check the sandbox account configuration");
    expect(live().steps.indexOf(preflight)).toBeLessThan(
      live().steps.findIndex((step) => step.uses?.startsWith("aws-actions/configure-aws-credentials@"))
    );
    expect(preflight.run).toContain("LIVE_SANDBOX_AWS_ROLE_ARN");
    expect(preflight.run).toContain("LIVE_SANDBOX_AWS_ACCOUNT_ID");
    expect(preflight.run).toContain('"arn:aws:iam::${LIVE_SANDBOX_AWS_ACCOUNT_ID}:role/"*');
  });

  it("keeps a checkout that retains no token", () => {
    const checkout = live().steps[0];
    expect(checkout.uses).toMatch(/^actions\/checkout@/);
    expect(checkout.with?.["persist-credentials"]).toBe(false);
  });
});

describe("Dependabot", () => {
  interface Update {
    "package-ecosystem": string;
    directory: string;
    schedule: { interval: string; day?: string };
    groups?: Record<string, { patterns?: string[]; "update-types"?: string[]; "dependency-type"?: string }>;
    cooldown?: { "default-days"?: number };
  }
  const config = load(fs.readFileSync(path.join(process.cwd(), ".github/dependabot.yml"), "utf8")) as {
    version: number;
    updates: Update[];
  };
  const byEcosystem = (name: string): Update => {
    const found = config.updates.find((update) => update["package-ecosystem"] === name);
    expect(found, `dependabot.yml must update ${name}`).toBeDefined();
    return found as Update;
  };

  it("updates npm, GitHub Actions and the Go module weekly", () => {
    expect(config.version).toBe(2);
    expect(config.updates.map((update) => [update["package-ecosystem"], update.directory]).sort()).toEqual([
      ["github-actions", "/"],
      ["gomod", "/go"],
      ["npm", "/"],
    ]);
    for (const update of config.updates) expect(update.schedule.interval).toBe("weekly");
  });

  it("groups every ecosystem so related updates arrive together", () => {
    for (const update of config.updates) expect(Object.keys(update.groups ?? {}).length, update["package-ecosystem"]).toBeGreaterThan(0);
  });

  it("keeps the packages that must move together in their own groups, ahead of the catch-alls", () => {
    const groups = byEcosystem("npm").groups ?? {};
    const order = Object.keys(groups);
    expect(groups.temporal?.patterns).toEqual(["@temporalio/*"]);
    expect(groups["aws-sdk"]?.patterns).toContain("@aws-sdk/*");
    for (const coupled of ["temporal", "aws-sdk", "nextjs", "react"])
      for (const catchAll of ["production-minor-and-patch", "development-minor-and-patch"])
        expect(order.indexOf(coupled), `${coupled} must come before ${catchAll}`).toBeLessThan(order.indexOf(catchAll));
  });

  it("never folds a major version into a grouped minor/patch update", () => {
    for (const catchAll of ["production-minor-and-patch", "development-minor-and-patch"])
      expect(byEcosystem("npm").groups?.[catchAll]?.["update-types"]).toEqual(["minor", "patch"]);
    expect(byEcosystem("github-actions").groups?.["github-actions-minor-and-patch"]?.["update-types"]).toEqual(["minor", "patch"]);
    expect(byEcosystem("gomod").groups?.["go-minor-and-patch"]?.["update-types"]).toEqual(["minor", "patch"]);
  });

  it("waits a few days before proposing a brand-new release", () => {
    for (const update of config.updates) expect(update.cooldown?.["default-days"], update["package-ecosystem"]).toBeGreaterThanOrEqual(3);
  });
});
