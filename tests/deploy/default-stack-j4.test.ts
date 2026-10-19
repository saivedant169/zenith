import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const j4Mocks = vi.hoisted(() => ({
  requireEngineGate: vi.fn(),
  compose: vi.fn(),
  readState: vi.fn(),
  temporalConnect: vi.fn(),
  postgres: vi.fn(),
  spawn: vi.fn(),
  readinessOverride: undefined as undefined | ((state: unknown, options?: unknown) => Promise<unknown>),
}));

vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: j4Mocks.spawn };
});

vi.mock("../../scripts/acceptance/default-stack/runtime.mjs", async importOriginal => {
  const actual = await importOriginal<typeof import("../../scripts/acceptance/default-stack/runtime.mjs")>();
  return { ...actual, requireEngineGate: j4Mocks.requireEngineGate, compose: j4Mocks.compose, readState: j4Mocks.readState };
});

vi.mock("../../scripts/acceptance/default-stack/readiness.mjs", async importOriginal => {
  const actual = await importOriginal<typeof import("../../scripts/acceptance/default-stack/readiness.mjs")>();
  return {
    ...actual,
    readiness: (state: unknown, options?: unknown) => j4Mocks.readinessOverride
      ? j4Mocks.readinessOverride(state, options)
      : actual.readiness(state as never, options as never),
  };
});

vi.mock("@temporalio/client", async importOriginal => {
  const actual = await importOriginal<typeof import("@temporalio/client")>();
  return {
    ...actual,
    Connection: { connect: j4Mocks.temporalConnect },
    Client: class {
      schedule = { list: async function* () {} };
    },
  };
});

vi.mock("postgres", () => ({ default: j4Mocks.postgres }));

beforeEach(() => {
  j4Mocks.requireEngineGate.mockReset();
  j4Mocks.requireEngineGate.mockImplementation(() => undefined);
  j4Mocks.compose.mockReset();
  j4Mocks.compose.mockResolvedValue("");
  j4Mocks.readState.mockReset();
  j4Mocks.temporalConnect.mockReset();
  j4Mocks.postgres.mockReset();
  j4Mocks.spawn.mockReset();
  j4Mocks.readinessOverride = undefined;
});

import { prepare, sourceBinding } from "../../scripts/deploy/installation.mjs";
import { J4_POLLER_SETTLE_MS, deferredJ4Composition, hasNumericScheduleOwnerKeyword, initializeJ4Namespace, j4HostEnvironment, j4ResumePlan, pollersSettled, prepareJ4Ownership, recordJ4Completion, resumeJ4, temporalKeywordSearchAttributeValue, validHostWorkerClosure } from "../../scripts/acceptance/default-stack/j4.mjs";
import { parseJ4UpOptions } from "../../scripts/acceptance/default-stack/up.mjs";
import { readiness } from "../../scripts/acceptance/default-stack/readiness.mjs";
import { cleanup as cleanupDefaultStack } from "../../scripts/acceptance/default-stack/runtime.mjs";
import { ports } from "../../scripts/acceptance/default-stack/config.mjs";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const envNames = ["api.env", "worker.env", "migration.env", "compose.env", "installation.json", "keyring.json"];
const namespace = "j4-test-resume";
const passTemporalDeadline = (_deadline: Date | number, operation: () => Promise<unknown>) => operation();

function makeFixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "zenith-j4-prestart-"));
  chmodSync(directory, 0o700);
  try {
    const installDirectory = path.join(directory, "installation");
    const installId = randomBytes(12).toString("hex");
    const productUrl = "postgresql://postgres.pooler-dev:LocalJ4Secret9@supabase-pooler:6543/postgres?sslmode=verify-full";
    const config = prepare({
      mode: "disposable",
      apiPort: 36400,
      images: {
        api: `registry.local/zenith/api@sha256:${"1".repeat(64)}`,
        worker: `registry.local/zenith/worker@sha256:${"2".repeat(64)}`,
        migration: `registry.local/zenith/migration@sha256:${"3".repeat(64)}`,
      },
      environment: {
        SUPABASE_URL: "https://supabase.localhost:54321",
        NEXT_PUBLIC_SUPABASE_URL: "https://supabase.localhost:54321",
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "publishable-local-j4-fixture-key-123456",
        NEXT_PUBLIC_SITE_URL: "http://127.0.0.1:36400",
        SUPABASE_SERVICE_ROLE_KEY: "service-role-local-j4-fixture-key-123456789",
        SUPABASE_DB_URL: productUrl,
      },
    }, installDirectory);
    const state = {
      schemaVersion: 1,
      directory,
      installationId: installId,
      projectId: `zenith-local-${installId}`,
      applicationInstallationId: config.installationId,
      applicationProjectName: config.projectName,
      source: sourceBinding(),
      profile: "lean",
      mailpitUrl: "http://127.0.0.1:8025",
      compositionSha256: "",
      canonicalCompositionSha256: "",
      j4Mode: undefined as "deferred" | "resuming" | "canonical" | undefined,
      j4Namespace: undefined as string | undefined,
      j4TemporalPort: undefined as number | undefined,
    };
    const canonicalEnvironment = Object.fromEntries(envNames.map(name => [name, readFileSync(path.join(installDirectory, name))]));
    const document = {
      services: {
        api: {
          labels: { "io.zenith.installation": installId },
          env_file: [{ path: path.join(installDirectory, "api.env"), format: "raw" }],
          volumes: ["api-data:/data"],
        },
        "api-peer": {},
        "execution-worker": {},
        "execution-worker-peer": {},
        temporal: { ports: ["7233:7233"] },
      },
      volumes: { "api-data": { labels: { "io.zenith.installation": installId } } },
    };
    const canonicalComposition = Buffer.from(JSON.stringify(document));
    const deferred = deferredJ4Composition(document, path.join(directory, "j4/api.env"), namespace);
    const deferredComposition = Buffer.from(JSON.stringify(deferred));
    const prepared = prepareJ4Ownership(state, config, canonicalComposition, { namespace, temporalPort: ports.j4Temporal }, deferredComposition);
    const compositionFile = path.join(installDirectory, "stack.compose.json");
    writeFileSync(compositionFile, deferredComposition, { mode: 0o600 });
    state.compositionSha256 = hash(deferredComposition);
    state.canonicalCompositionSha256 = prepared.manifest.canonicalCompositionSha256;
    return { directory, installDirectory, config, state, canonicalEnvironment, document, deferred, deferredComposition, manifest: prepared.manifest };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function installResumeDatabaseMock(epoch: string) {
  j4Mocks.postgres.mockImplementation(() => {
    const query = (strings: TemplateStringsArray) => {
      const statement = strings.join(" ");
      if (statement.includes("cleanup_writer_epoch")) return Promise.resolve([{ singleton: true, installed_at: epoch, admitted: true }]);
      if (statement.includes("scheduled_job_runs")) return Promise.resolve([{ count: 1 }]);
      if (statement.includes("provider_connections")) return Promise.resolve([{ count: 0 }]);
      throw new Error("unexpected database query in resume fixture");
    };
    Object.assign(query, { array: (values: unknown[]) => values, end: vi.fn().mockResolvedValue(undefined) });
    return query;
  });
}

function installEmptyTemporalMock() {
  const connection = {
    workflowService: {
      listWorkflowExecutions: vi.fn().mockResolvedValue({ executions: [] }),
      describeTaskQueue: vi.fn().mockResolvedValue({ pollers: [] }),
    },
    close: vi.fn().mockResolvedValue(undefined),
  };
  j4Mocks.temporalConnect.mockResolvedValue(connection);
  return connection;
}

function installDockerInventoryMock(state: ReturnType<typeof makeFixture>["state"], resourcesRemain: boolean) {
  let inventoryQueries = 0;
  let inventoryAfterCredentialRemoval = false;
  const container = {
    Id: "owned-container-1",
    Config: { Labels: { "io.zenith.installation": state.installationId } },
    State: { Running: true, ExitCode: 0, OOMKilled: false },
  };
  j4Mocks.spawn.mockImplementation((_command: string, args: string[]) => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    const child = Object.assign(new EventEmitter(), { stdout, stderr, stdin, kill: vi.fn(() => true) });
    let output = "";
    if (args[1] === "ls") {
      inventoryQueries++;
      if (!existsSync(path.join(state.directory, "j4/api.env"))) inventoryAfterCredentialRemoval = true;
      if (resourcesRemain && args[0] === "container") output = "owned-container-1\n";
    } else if (args[0] === "container" && args[1] === "inspect") {
      output = JSON.stringify([container]);
    } else if (args[0] === "stop" || args[0] === "rm") {
      output = "";
    } else {
      throw new Error(`Unexpected mocked docker call: ${args.slice(0, 3).join(" ")}`);
    }
    queueMicrotask(() => {
      if (output) stdout.write(output);
      stdout.end();
      stderr.end();
      child.emit("close", 0);
    });
    return child;
  });
  return {
    inventoryQueryCount: () => inventoryQueries,
    inventoryAfterCredentialRemoval: () => inventoryAfterCredentialRemoval,
  };
}

function seedCleanupReceipts(directory: string) {
  writeFileSync(path.join(directory, "j4-prestart.receipt.json"), JSON.stringify({ kind: "j4_prestart", passed: 8 }), { mode: 0o600 });
  writeFileSync(path.join(directory, "j4-completion.receipt.json"), JSON.stringify({ kind: "j4_completion", passed: 4 }), { mode: 0o600 });
}

describe("J4 deferred default-stack admission", () => {
  it("waits out an exited worker's stale Temporal poller but refuses one that keeps polling", async () => {
    vi.useFakeTimers();
    try {
      const stale = { pollers: [{ identity: "j4-maintenance-exited" }] };
      const ageing = vi.fn().mockResolvedValueOnce(stale).mockResolvedValueOnce(stale).mockResolvedValue({ pollers: [] });
      const settled = pollersSettled(ageing, J4_POLLER_SETTLE_MS);
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(settled).resolves.toBe(true);
      expect(ageing).toHaveBeenCalledTimes(3);

      const live = vi.fn().mockResolvedValue(stale);
      const refused = pollersSettled(live, J4_POLLER_SETTLE_MS);
      await vi.advanceTimersByTimeAsync(J4_POLLER_SETTLE_MS + 5_000);
      await expect(refused).resolves.toBe(false);

      const strict = vi.fn().mockResolvedValue(stale);
      await expect(pollersSettled(strict, 0)).resolves.toBe(false);
      expect(strict).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepts only the raw numeric Temporal KEYWORD enum", () => {
    expect(temporalKeywordSearchAttributeValue).toBe(2);
    expect(hasNumericScheduleOwnerKeyword({ ZenithScheduleOwner: 2 })).toBe(true);
    for (const value of ["KEYWORD", 0, 1, 3, null, undefined]) {
      expect(hasNumericScheduleOwnerKeyword({ ZenithScheduleOwner: value })).toBe(false);
    }
  });

  it("runs the operational gate and ownership validation before Temporal mutation", async () => {
    const fixture = makeFixture();
    try {
      j4Mocks.requireEngineGate.mockImplementation(() => { throw new Error("engine gate refused"); });
      await expect(initializeJ4Namespace(fixture.state)).rejects.toThrow("engine gate refused");
      expect(j4Mocks.temporalConnect).not.toHaveBeenCalled();

      j4Mocks.requireEngineGate.mockImplementation(() => undefined);
      const ownershipFile = path.join(fixture.directory, "j4/ownership.json");
      const manifest = JSON.parse(readFileSync(ownershipFile, "utf8"));
      writeFileSync(ownershipFile, JSON.stringify({ ...manifest, projectId: "foreign-owner" }), { mode: 0o600 });
      await expect(initializeJ4Namespace(fixture.state)).rejects.toThrow("default-stack:j4-ownership-binding");
      expect(j4Mocks.temporalConnect).not.toHaveBeenCalled();
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("registers and verifies the schedule-owner keyword using the raw numeric Temporal enum", async () => {
    const fixture = makeFixture();
    try {
      const notFound = Object.assign(new Error("namespace missing"), { code: 5 });
      const connection = {
        withDeadline: vi.fn(passTemporalDeadline),
        workflowService: {
          describeNamespace: vi.fn().mockRejectedValueOnce(notFound).mockResolvedValue({ namespaceInfo: { name: namespace } }),
          registerNamespace: vi.fn().mockResolvedValue(undefined),
        },
        operatorService: {
          listSearchAttributes: vi.fn().mockResolvedValueOnce({ customAttributes: {} }).mockResolvedValue({ customAttributes: { ZenithScheduleOwner: 2 } }),
          addSearchAttributes: vi.fn().mockResolvedValue(undefined),
        },
        close: vi.fn().mockResolvedValue(undefined),
      };
      j4Mocks.temporalConnect.mockResolvedValue(connection);
      await expect(initializeJ4Namespace(fixture.state)).resolves.toMatchObject({ namespaceCreated: true, scheduleOwnerKeywordCreated: true });
      expect(connection.operatorService.addSearchAttributes).toHaveBeenCalledWith({
        namespace,
        searchAttributes: { ZenithScheduleOwner: 2 },
      });
      expect(connection.operatorService.listSearchAttributes).toHaveBeenCalledTimes(2);
      expect(connection.withDeadline).toHaveBeenCalledTimes(2);
      expect(new Set(connection.withDeadline.mock.calls.map(([deadline]) => deadline)).size).toBe(1);
      expect(connection.close).toHaveBeenCalledOnce();
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("waits for post-registration namespace and search-attribute reads on NOT_FOUND only", async () => {
    const fixture = makeFixture();
    try {
      const notFound = Object.assign(new Error("private namespace detail"), { code: 5 });
      const connection = {
        withDeadline: vi.fn(passTemporalDeadline),
        workflowService: {
          describeNamespace: vi.fn().mockRejectedValueOnce(notFound).mockRejectedValueOnce(notFound)
            .mockResolvedValue({ namespaceInfo: { name: namespace } }),
          registerNamespace: vi.fn().mockResolvedValue(undefined),
        },
        operatorService: {
          listSearchAttributes: vi.fn().mockRejectedValueOnce(notFound).mockResolvedValueOnce({ customAttributes: {} })
            .mockResolvedValueOnce({ customAttributes: { ZenithScheduleOwner: 2 } }),
          addSearchAttributes: vi.fn().mockResolvedValue(undefined),
        },
        close: vi.fn().mockResolvedValue(undefined),
      };
      j4Mocks.temporalConnect.mockResolvedValue(connection);
      await expect(initializeJ4Namespace(fixture.state)).resolves.toMatchObject({ namespaceCreated: true, scheduleOwnerKeywordCreated: true });
      expect(connection.workflowService.describeNamespace).toHaveBeenCalledTimes(4);
      expect(connection.workflowService.registerNamespace).toHaveBeenCalledOnce();
      expect(connection.operatorService.listSearchAttributes).toHaveBeenCalledTimes(3);
      expect(connection.operatorService.addSearchAttributes).toHaveBeenCalledOnce();
      expect(connection.withDeadline).toHaveBeenCalledTimes(5);
      expect(new Set(connection.withDeadline.mock.calls.map(([deadline]) => deadline)).size).toBe(1);
      expect(connection.close).toHaveBeenCalledOnce();
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("stops readiness polling at its bounded deadline and closes without repeating registration", async () => {
    vi.useFakeTimers();
    const fixture = makeFixture();
    try {
      const notFound = Object.assign(new Error("private namespace detail"), { code: 5 });
      const connection = {
        withDeadline: vi.fn(passTemporalDeadline),
        workflowService: {
          describeNamespace: vi.fn().mockRejectedValueOnce(notFound).mockRejectedValue(notFound),
          registerNamespace: vi.fn().mockResolvedValue(undefined),
        },
        operatorService: {
          listSearchAttributes: vi.fn().mockResolvedValue({ customAttributes: {} }),
          addSearchAttributes: vi.fn().mockResolvedValue(undefined),
        },
        close: vi.fn().mockResolvedValue(undefined),
      };
      j4Mocks.temporalConnect.mockResolvedValue(connection);
      const admission = initializeJ4Namespace(fixture.state);
      const rejection = expect(admission).rejects.toThrow("default-stack:j4-namespace-readiness-timeout");
      await vi.advanceTimersByTimeAsync(30_000);
      await rejection;
      expect(connection.workflowService.registerNamespace).toHaveBeenCalledOnce();
      expect(connection.withDeadline).toHaveBeenCalled();
      expect(new Set(connection.withDeadline.mock.calls.map(([deadline]) => deadline)).size).toBe(1);
      expect(connection.operatorService.addSearchAttributes).not.toHaveBeenCalled();
      expect(connection.close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("passes the shared deadline to Temporal so a pending readiness RPC expires", async () => {
    vi.useFakeTimers();
    const fixture = makeFixture();
    try {
      const connection = {
        withDeadline: vi.fn((deadline: Date | number, operation: () => Promise<unknown>) => new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(Object.assign(new Error("deadline exceeded"), { code: 4 })), Number(deadline) - Date.now());
          Promise.resolve(operation()).then(resolve, reject).finally(() => clearTimeout(timer));
        })),
        workflowService: {
          describeNamespace: vi.fn().mockRejectedValueOnce(Object.assign(new Error("missing"), { code: 5 }))
            .mockImplementationOnce(() => new Promise(() => {})),
          registerNamespace: vi.fn().mockResolvedValue(undefined),
        },
        operatorService: { listSearchAttributes: vi.fn(), addSearchAttributes: vi.fn() },
        close: vi.fn().mockResolvedValue(undefined),
      };
      j4Mocks.temporalConnect.mockResolvedValue(connection);
      const admission = initializeJ4Namespace(fixture.state);
      const rejection = expect(admission).rejects.toThrow("default-stack:j4-namespace-readiness-timeout");
      await vi.advanceTimersByTimeAsync(30_000);
      await rejection;
      expect(connection.withDeadline).toHaveBeenCalledOnce();
      expect(typeof connection.withDeadline.mock.calls[0][0]).toBe("number");
      expect(connection.workflowService.describeNamespace).toHaveBeenCalledTimes(2);
      expect(connection.workflowService.registerNamespace).toHaveBeenCalledOnce();
      expect(connection.close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("fails closed on non-NOT_FOUND RPC errors without exposing their messages", async () => {
    const fixture = makeFixture();
    try {
      const internal = Object.assign(new Error("secret server detail"), { code: 13 });
      const connection = {
        withDeadline: vi.fn(passTemporalDeadline),
        workflowService: {
          describeNamespace: vi.fn().mockRejectedValueOnce(Object.assign(new Error("missing"), { code: 5 }))
            .mockRejectedValue(internal),
          registerNamespace: vi.fn().mockResolvedValue(undefined),
        },
        operatorService: { listSearchAttributes: vi.fn(), addSearchAttributes: vi.fn() },
        close: vi.fn().mockResolvedValue(undefined),
      };
      j4Mocks.temporalConnect.mockResolvedValue(connection);
      await expect(initializeJ4Namespace(fixture.state)).rejects.toMatchObject({ message: "default-stack:j4-namespace-describe-after", code: 13 });
      expect(connection.workflowService.describeNamespace).toHaveBeenCalledTimes(2);
      expect(connection.workflowService.registerNamespace).toHaveBeenCalledOnce();
      expect(connection.close).toHaveBeenCalledOnce();
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("refuses an existing namespace, a mismatched namespace response, and a preexisting attribute", async () => {
    const existingFixture = makeFixture();
    try {
      const existing = { withDeadline: vi.fn(passTemporalDeadline), workflowService: { describeNamespace: vi.fn().mockResolvedValue({ namespaceInfo: { name: namespace } }), registerNamespace: vi.fn() },
        operatorService: { listSearchAttributes: vi.fn(), addSearchAttributes: vi.fn() }, close: vi.fn().mockResolvedValue(undefined) };
      j4Mocks.temporalConnect.mockResolvedValue(existing);
      await expect(initializeJ4Namespace(existingFixture.state)).rejects.toThrow("default-stack:j4-namespace-already-exists");
      expect(existing.workflowService.registerNamespace).not.toHaveBeenCalled();
      expect(existing.close).toHaveBeenCalledOnce();
    } finally { rmSync(existingFixture.directory, { recursive: true, force: true }); }

    const mismatchFixture = makeFixture();
    try {
      const mismatch = { withDeadline: vi.fn(passTemporalDeadline), workflowService: {
        describeNamespace: vi.fn().mockRejectedValueOnce(Object.assign(new Error("missing"), { code: 5 })).mockResolvedValue({ namespaceInfo: { name: "other" } }),
        registerNamespace: vi.fn().mockResolvedValue(undefined),
      }, operatorService: { listSearchAttributes: vi.fn(), addSearchAttributes: vi.fn() }, close: vi.fn().mockResolvedValue(undefined) };
      j4Mocks.temporalConnect.mockResolvedValue(mismatch);
      await expect(initializeJ4Namespace(mismatchFixture.state)).rejects.toThrow("default-stack:j4-namespace-registration");
      expect(mismatch.workflowService.describeNamespace).toHaveBeenCalledTimes(2);
      expect(mismatch.operatorService.listSearchAttributes).not.toHaveBeenCalled();
      expect(mismatch.workflowService.registerNamespace).toHaveBeenCalledOnce();
      expect(mismatch.close).toHaveBeenCalledOnce();
    } finally { rmSync(mismatchFixture.directory, { recursive: true, force: true }); }

    const attributeFixture = makeFixture();
    try {
      const attribute = { withDeadline: vi.fn(passTemporalDeadline), workflowService: {
        describeNamespace: vi.fn().mockRejectedValueOnce(Object.assign(new Error("missing"), { code: 5 })).mockResolvedValue({ namespaceInfo: { name: namespace } }),
        registerNamespace: vi.fn().mockResolvedValue(undefined),
      }, operatorService: {
        listSearchAttributes: vi.fn().mockResolvedValue({ customAttributes: { ZenithScheduleOwner: 2 } }), addSearchAttributes: vi.fn(),
      }, close: vi.fn().mockResolvedValue(undefined) };
      j4Mocks.temporalConnect.mockResolvedValue(attribute);
      await expect(initializeJ4Namespace(attributeFixture.state)).rejects.toThrow("default-stack:j4-search-attribute-already-exists");
      expect(attribute.workflowService.registerNamespace).toHaveBeenCalledOnce();
      expect(attribute.operatorService.listSearchAttributes).toHaveBeenCalledOnce();
      expect(attribute.operatorService.addSearchAttributes).not.toHaveBeenCalled();
      expect(attribute.close).toHaveBeenCalledOnce();
    } finally { rmSync(attributeFixture.directory, { recursive: true, force: true }); }
  });

  it("requires the explicit lean namespace and loopback Temporal CLI contract", () => {
    expect(parseJ4UpOptions(["--profile", "lean", "--directory", "/tmp/j4-stack", "--j4-defer-workers", "--j4-namespace", namespace, "--j4-temporal-port", "17233"]))
      .toEqual({ profile: "lean", directory: "/tmp/j4-stack", imageLock: undefined, j4: { namespace, temporalPort: 17233 } });
    expect(parseJ4UpOptions(["--profile", "default", "--directory", "/tmp/j1-stack"]).j4).toBeUndefined();
    for (const args of [
      ["--j4-defer-workers", "--j4-namespace", namespace, "--j4-temporal-port", "17233"],
      ["--profile", "default", "--j4-defer-workers", "--j4-namespace", namespace, "--j4-temporal-port", "17233"],
      ["--profile", "lean", "--j4-defer-workers", "--j4-namespace", "ordinary", "--j4-temporal-port", "17233"],
      ["--profile", "lean", "--j4-defer-workers", "--j4-namespace", namespace, "--j4-temporal-port", "17234"],
      ["--profile", "lean", "--j4-namespace", namespace, "--j4-temporal-port", "17233"],
    ]) expect(() => parseJ4UpOptions([...args])).toThrow();
  });

  it("removes every execution worker and binds only the owned loopback Temporal port", () => {
    const fixture = makeFixture();
    try {
      expect(fixture.deferred.services).not.toHaveProperty("execution-worker");
      expect(fixture.deferred.services).not.toHaveProperty("execution-worker-peer");
      expect(fixture.deferred.services).not.toHaveProperty("api-peer");
      expect(fixture.deferred.services.api.env_file).toEqual([{ path: path.join(fixture.directory, "j4/api.env"), format: "raw" }]);
      expect(fixture.deferred.services.api.volumes).toEqual([
        "j4-api-data:/data",
        `${path.join(fixture.directory, "j4")}/../tls/ca.crt:/run/zenith-ca.crt:ro`,
      ]);
      expect(fixture.deferred.volumes).toHaveProperty("j4-api-data");
      expect(fixture.deferred.services.temporal.ports).toEqual(["127.0.0.1:17233:7233"]);
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("keeps prepared J1 files byte-exact while deriving the private J4 API and host worker joins", () => {
    const fixture = makeFixture();
    try {
      for (const name of envNames) expect(readFileSync(path.join(fixture.installDirectory, name))).toEqual(fixture.canonicalEnvironment[name]);
      const host = j4HostEnvironment(fixture.state);
      expect(host).toMatchObject({
        ZENITH_SERVERLESS: "1",
        ZENITH_BILLING: "managed",
        ZENITH_PLATFORM_DB_MAX: "2",
        ZENITH_TEMPORAL_NAMESPACE: namespace,
        ZENITH_TEMPORAL_ADDRESS: "127.0.0.1:17233",
        ZENITH_STORE: "postgres",
        ZENITH_PLATFORM_DB: "postgres",
      });
      expect(host.SUPABASE_DB_URL).toBe(host.ZENITH_PLATFORM_DB_URL);
      expect(host.SUPABASE_DB_URL).toBe(host.ZENITH_PLATFORM_MIGRATION_URL);
      expect(host.ZENITH_J4_API_ORIGIN).toBe(fixture.config.environment.NEXT_PUBLIC_SITE_URL);
      expect(host.ZENITH_J4_CRON_SECRET_FILE).toBe(path.join(fixture.directory, "j4/cron.secret"));
      expect(host.ZENITH_DATA).toBe(path.join(fixture.directory, "j4/data"));
      expect(host.HOME).toBe(path.join(fixture.directory, "j4/home"));
      expect(host.ZENITH_WORKER_PLAN_DIR).toBe(path.join(fixture.directory, "j4/data/plans"));

      const apiEnv = Object.fromEntries(readFileSync(path.join(fixture.directory, "j4/api.env"), "utf8").trim().split("\n").map(line => {
        const index = line.indexOf("="); return [line.slice(0, index), line.slice(index + 1)];
      }));
      expect(apiEnv).toMatchObject({ ZENITH_SERVERLESS: "1", ZENITH_BILLING: "managed", ZENITH_PLATFORM_DB_MAX: "2", ZENITH_TEMPORAL_NAMESPACE: namespace });
      expect(apiEnv.SUPABASE_DB_URL).toBe(fixture.config.environment.SUPABASE_DB_URL);
      expect(apiEnv.ZENITH_PLATFORM_DB_URL).toBe(fixture.config.environment.SUPABASE_DB_URL);
      expect(apiEnv.SUPABASE_SERVICE_ROLE_KEY).toBe(fixture.config.environment.SUPABASE_SERVICE_ROLE_KEY);
      expect(apiEnv.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY).toBe(fixture.config.environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY);
      const workerEnv = Object.fromEntries(readFileSync(path.join(fixture.directory, "j4/worker.env"), "utf8").trim().split("\n").map(line => {
        const index = line.indexOf("="); return [line.slice(0, index), line.slice(index + 1)];
      }));
      expect(workerEnv.HOME).toBe(path.join(fixture.directory, "j4/home"));
      expect(workerEnv.ZENITH_WORKER_PLAN_DIR).toBe(path.join(fixture.directory, "j4/data/plans"));
      const overlayKeys = readFileSync(path.join(fixture.directory, "j4/maintenance.env"), "utf8").trim().split("\n").map(line => line.slice(0, line.indexOf("="))).sort();
      expect(overlayKeys).toEqual(["ZENITH_BILLING", "ZENITH_DATA", "ZENITH_J4_API_ORIGIN", "ZENITH_J4_CRON_SECRET_FILE", "ZENITH_PLATFORM_DB_MAX", "ZENITH_PLATFORM_DB_URL", "ZENITH_SERVERLESS", "ZENITH_TEMPORAL_ADDRESS", "ZENITH_TEMPORAL_NAMESPACE"].sort());
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("rejects J1 readiness while the owned stack is deferred", async () => {
    const fixture = makeFixture();
    try {
      await expect(readiness(fixture.state)).rejects.toThrow("default-stack:j4-deferred-not-j1-ready");
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("binds resume admission to ownership, source, compose, canonical environment and J4 receipts", () => {
    const fixture = makeFixture();
    try {
      const manifest = { ...fixture.manifest, prestartReceiptSha256: "a".repeat(64), completionReceiptSha256: "b".repeat(64) };
      expect(j4ResumePlan(fixture.state, manifest)).toMatchObject({
        canonicalCompositionSha256: hash(Buffer.from(JSON.stringify(fixture.document))),
        deferredCompositionSha256: hash(fixture.deferredComposition),
        namespace,
        temporalPort: 17233,
      });
      expect(() => j4ResumePlan(fixture.state, { ...manifest, projectId: "foreign-project" })).toThrow("default-stack:j4-ownership-binding");
      expect(() => j4ResumePlan(fixture.state, { ...manifest, source: { ...manifest.source, contentSha256: "f".repeat(64) } })).toThrow("default-stack:j4-ownership-binding");
      expect(() => j4ResumePlan(fixture.state, { ...manifest, completionReceiptSha256: undefined })).toThrow("default-stack:j4-incomplete");

      const maintenanceFile = path.join(fixture.directory, "j4/maintenance.env");
      const maintenanceBytes = readFileSync(maintenanceFile);
      writeFileSync(maintenanceFile, Buffer.concat([maintenanceBytes, Buffer.from("\n")]));
      expect(() => j4ResumePlan(fixture.state, manifest)).toThrow("default-stack:j4-private-environment-drift");
      writeFileSync(maintenanceFile, maintenanceBytes, { mode: 0o600 });

      const canonicalEnvFile = path.join(fixture.installDirectory, "api.env");
      const canonicalEnvBytes = readFileSync(canonicalEnvFile);
      writeFileSync(canonicalEnvFile, Buffer.concat([canonicalEnvBytes, Buffer.from("\n")]));
      expect(() => j4ResumePlan(fixture.state, manifest)).toThrow("default-stack:j4-canonical-environment-drift");
      writeFileSync(canonicalEnvFile, canonicalEnvBytes, { mode: 0o600 });

      writeFileSync(path.join(fixture.installDirectory, "stack.compose.json"), Buffer.from("{}"), { mode: 0o600 });
      expect(() => j4ResumePlan(fixture.state, manifest)).toThrow("default-stack:j4-composition-drift");
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("refuses absent, malformed, unbound, duplicate, or nonzero host-worker closure proof", async () => {
    const fixture = makeFixture();
    try {
      const baseEvidence = {
        naturalTimers: true,
        workerRestart: true,
        fallbackResumed: true,
        epochPreserved: true,
        runId: "9e5927e3-f12a-4888-a9d8-63e340fd365a",
      };
      const child = (pid: number, restartOrdinal: 1 | 2, identity: string, signal: "SIGTERM" | null = null) => ({
        pid,
        restartOrdinal,
        workerIdentity: `j4-maintenance-${identity}`,
        closed: true,
        exitCode: 0,
        signal,
      });
      const valid = {
        schemaVersion: 1,
        kind: "owned_child_closeouts",
        runId: baseEvidence.runId,
        namespace,
        children: [
          child(41001, 1, "37bd53ce-3c96-4a20-a771-6a4e97c11f6e"),
          child(41002, 2, "fb88d2c5-bd72-4a61-9743-e5f5d8a3bbd1"),
        ],
        graceful: true,
      };
      expect(validHostWorkerClosure(valid, namespace)).toBe(true);
      expect(validHostWorkerClosure({
        ...valid,
        children: [{ ...valid.children[0], exitCode: null, signal: "SIGTERM" }, valid.children[1]],
      }, namespace)).toBe(true);
      const invalidProofs = [
        undefined,
        { ...valid, namespace: "j4-foreign" },
        { ...valid, runId: "abf3c90f-f17f-4bb4-a529-b302ac8a46fb" },
        { ...valid, children: [valid.children[0], { ...valid.children[1], pid: valid.children[0].pid }] },
        { ...valid, children: [valid.children[0], { ...valid.children[1], closed: false }] },
        { ...valid, children: [valid.children[0], { ...valid.children[1], exitCode: null, signal: "SIGKILL" }] },
      ];
      for (const hostWorkerClosure of invalidProofs) {
        await expect(recordJ4Completion(fixture.state, { ...baseEvidence, hostWorkerClosure })).rejects.toThrow();
      }
      expect(j4Mocks.postgres).not.toHaveBeenCalled();
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("retries a failed canonical readiness without contacting the retired J4 Temporal endpoint", async () => {
    const fixture = makeFixture();
    try {
      mkdirSync(path.join(fixture.directory, "tls"), { mode: 0o700 });
      writeFileSync(path.join(fixture.directory, "tls/ca.crt"), "fixture CA for the mocked product-database connection\n", { mode: 0o600 });
      const epoch = "2026-10-10 00:00:00+00";
      const runId = "9e5927e3-f12a-4888-a9d8-63e340fd365a";
      const closure = {
        schemaVersion: 1,
        kind: "owned_child_closeouts",
        runId,
        namespace,
        children: [
          { pid: 41001, restartOrdinal: 1, workerIdentity: "j4-maintenance-37bd53ce-3c96-4a20-a771-6a4e97c11f6e", closed: true, exitCode: 0, signal: null },
          { pid: 41002, restartOrdinal: 2, workerIdentity: "j4-maintenance-fb88d2c5-bd72-4a61-9743-e5f5d8a3bbd1", closed: true, exitCode: 0, signal: null },
        ],
        graceful: true,
      };
      const prestart = {
        schemaVersion: 1, kind: "j4_prestart", source: fixture.state.source, namespace, temporalPort: 17233,
        database: { epoch, scheduledJobRuns: 0, providerConnections: 0 },
        j1Ready: false, failed: 0,
      };
      const completion = {
        schemaVersion: 1, kind: "j4_completion", source: fixture.state.source,
        runId,
        evidence: { naturalTimers: true, workerRestart: true, fallbackResumed: true, epochPreserved: true, runId, hostWorkerClosure: closure },
        hostWorkerClosure: { ...closure, source: fixture.state.source },
        database: { epoch, scheduledJobRuns: 1, providerConnections: 0 },
        temporal: { activeSchedules: 0, activeWorkflows: 0, activePollers: 0 },
        hostWorkerStopped: true, cleanupComplete: true,
      };
      const prestartBytes = Buffer.from(JSON.stringify(prestart));
      const completionBytes = Buffer.from(JSON.stringify(completion));
      writeFileSync(path.join(fixture.directory, "j4-prestart.receipt.json"), prestartBytes, { mode: 0o600 });
      writeFileSync(path.join(fixture.directory, "j4-completion.receipt.json"), completionBytes, { mode: 0o600 });
      const manifest = {
        ...fixture.manifest,
        prestartReceiptSha256: hash(prestartBytes),
        completionReceiptSha256: hash(completionBytes),
      };
      writeFileSync(path.join(fixture.directory, "j4/ownership.json"), JSON.stringify(manifest), { mode: 0o600 });

      fixture.state.j4Mode = "deferred";
      j4Mocks.readState.mockReturnValue(fixture.state);
      j4Mocks.requireEngineGate.mockImplementation(() => undefined);
      installResumeDatabaseMock(epoch);
      const initialTemporalConnection = installEmptyTemporalMock();
      const firstReadinessFailure = new Error("injected ordinary readiness failure");
      const readiness = vi.fn()
        .mockRejectedValueOnce(firstReadinessFailure)
        .mockResolvedValueOnce({ kind: "local_engine", failed: 0, skipped: 0, passed: 5 });
      j4Mocks.readinessOverride = readiness;

      await expect(resumeJ4(fixture.directory)).rejects.toBe(firstReadinessFailure);
      expect(fixture.state.j4Mode).toBe("resuming");
      expect(readiness).toHaveBeenNthCalledWith(1, fixture.state, { j4Resume: true });
      expect(initialTemporalConnection.close).toHaveBeenCalledOnce();
      const temporalCallsAfterFirstAttempt = j4Mocks.temporalConnect.mock.calls.length;
      expect(temporalCallsAfterFirstAttempt).toBe(1);
      j4Mocks.temporalConnect.mockImplementation(async () => {
        throw new Error("retired J4 Temporal endpoint must not be contacted during canonical retry");
      });

      await expect(resumeJ4(fixture.directory)).resolves.toMatchObject({ kind: "local_engine", failed: 0 });
      expect(readiness).toHaveBeenNthCalledWith(2, fixture.state, { j4Resume: true });
      expect(j4Mocks.temporalConnect).toHaveBeenCalledTimes(temporalCallsAfterFirstAttempt);
      expect(j4Mocks.compose.mock.calls.filter(([state, args]) => state === fixture.state && args[0] === "stop")).toHaveLength(1);
      expect(fixture.state.j4Mode).toBe("canonical");
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("keeps J4 credentials when the final owned-resource inventory is not empty", async () => {
    const fixture = makeFixture();
    vi.stubEnv("ZENITH_ACCEPTANCE_DEFAULT_STACK", "1");
    try {
      const docker = installDockerInventoryMock(fixture.state, true);
      await expect(cleanupDefaultStack(fixture.state)).rejects.toThrow("default-stack:owned-resources-remain");
      expect(docker.inventoryQueryCount()).toBe(24);
      expect(existsSync(path.join(fixture.directory, "j4/api.env"))).toBe(true);
      expect(existsSync(path.join(fixture.directory, "j4/worker.env"))).toBe(true);
      expect(existsSync(path.join(fixture.directory, "j4/cron.secret"))).toBe(true);
      expect(existsSync(path.join(fixture.directory, "j4/data/plans"))).toBe(true);
      expect(existsSync(path.join(fixture.directory, "j4/ownership.json"))).toBe(true);
    } finally {
      vi.unstubAllEnvs();
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("rejects symlinked J4 credentials and a foreign ownership manifest after inventory is empty", async () => {
    const fixture = makeFixture();
    vi.stubEnv("ZENITH_ACCEPTANCE_DEFAULT_STACK", "1");
    try {
      seedCleanupReceipts(fixture.directory);
      const docker = installDockerInventoryMock(fixture.state, false);
      const apiEnv = path.join(fixture.directory, "j4/api.env");
      const apiEnvBytes = readFileSync(apiEnv);
      const outsideTarget = path.join(fixture.directory, "outside-secret.txt");
      unlinkSync(apiEnv);
      writeFileSync(outsideTarget, "private api credentials\n", { mode: 0o600 });
      symlinkSync(outsideTarget, apiEnv);
      await expect(cleanupDefaultStack(fixture.state)).rejects.toThrow();
      expect(docker.inventoryQueryCount()).toBe(24);
      expect(lstatSync(apiEnv).isSymbolicLink()).toBe(true);
      expect(existsSync(path.join(fixture.directory, "j4/cron.secret"))).toBe(true);
      rmSync(apiEnv);
      writeFileSync(apiEnv, apiEnvBytes, { mode: 0o600 });

      const ownershipFile = path.join(fixture.directory, "j4/ownership.json");
      const manifest = JSON.parse(readFileSync(ownershipFile, "utf8"));
      writeFileSync(ownershipFile, JSON.stringify({ ...manifest, projectId: "zenith-local-foreign" }), { mode: 0o600 });
      await expect(cleanupDefaultStack(fixture.state)).rejects.toThrow("default-stack:j4-cleanup-binding");
      expect(existsSync(path.join(fixture.directory, "j4/api.env"))).toBe(true);
      expect(existsSync(path.join(fixture.directory, "j4/worker.env"))).toBe(true);
      expect(existsSync(path.join(fixture.directory, "j4/cron.secret"))).toBe(true);
      expect(existsSync(path.join(fixture.directory, "j4/data/plans"))).toBe(true);
    } finally {
      vi.unstubAllEnvs();
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("deletes J4 credentials only after empty inventory and retains nonsecret receipts and ownership", async () => {
    const fixture = makeFixture();
    vi.stubEnv("ZENITH_ACCEPTANCE_DEFAULT_STACK", "1");
    try {
      seedCleanupReceipts(fixture.directory);
      const docker = installDockerInventoryMock(fixture.state, false);
      const receipt = await cleanupDefaultStack(fixture.state);
      expect(receipt).toMatchObject({ kind: "local_engine", ownedResourcesRemaining: 0 });
      expect(docker.inventoryQueryCount()).toBe(24);
      expect(docker.inventoryAfterCredentialRemoval()).toBe(false);
      for (const name of ["api.env", "worker.env", "maintenance.env", "cron.secret", "canonical.stack.compose.json", "data", "home"]) {
        expect(existsSync(path.join(fixture.directory, "j4", name))).toBe(false);
      }
      expect(existsSync(path.join(fixture.directory, "j4/ownership.json"))).toBe(true);
      expect(existsSync(path.join(fixture.directory, "j4-prestart.receipt.json"))).toBe(true);
      expect(existsSync(path.join(fixture.directory, "j4-completion.receipt.json"))).toBe(true);
      expect(existsSync(path.join(fixture.directory, "cleanup.receipt.json"))).toBe(true);
    } finally {
      vi.unstubAllEnvs();
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });
});
