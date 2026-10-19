import { beforeEach, describe, expect, it, vi } from "vitest";

const pg = vi.hoisted(() => {
  const root = { unsafe: vi.fn(), begin: vi.fn(), end: vi.fn() };
  const transaction = { unsafe: vi.fn(), savepoint: vi.fn() };
  const savepoint = { unsafe: vi.fn(), savepoint: vi.fn() };
  const bigintParser = Symbol.for("postgres.BigInt");
  const factory = vi.fn((_url: string, _options: Record<string, unknown>) => root);
  return { root, transaction, savepoint, bigintParser, factory, postgres: Object.assign(factory, { BigInt: bigintParser }) };
});

vi.mock("postgres", () => ({ default: pg.postgres }));

import { createPlatformDbHandle, openPostgresDriver } from "@/lib/controlplane/db/executor";

const URL = "postgresql://operator:secret@127.0.0.1:6543/postgres?sslmode=verify-full";
type DispatchOptions = { onexecute?: () => false };

beforeEach(() => {
  vi.resetAllMocks();
  pg.factory.mockReturnValue(pg.root);
  pg.root.unsafe.mockResolvedValue([]);
  pg.root.begin.mockImplementation(async (callback) => callback(pg.transaction));
  pg.root.end.mockResolvedValue(undefined);
  pg.transaction.unsafe.mockResolvedValue([]);
  pg.transaction.savepoint.mockImplementation(async (callback) => callback(pg.savepoint));
  pg.savepoint.unsafe.mockResolvedValue([]);
});

describe("Postgres.js root autocommit dispatch contract", () => {
  it("passes the false-returning dispatch hook to root run and exec while retaining Postgres options", async () => {
    const driver = await openPostgresDriver({ url: URL, max: 2 });
    await driver.run("select $1", ["value"]);
    await driver.exec("select 1; select 2");

    const runOptions = pg.root.unsafe.mock.calls[0]?.[2] as DispatchOptions | undefined;
    const execOptions = pg.root.unsafe.mock.calls[1]?.[2] as DispatchOptions | undefined;
    expect(runOptions?.onexecute?.()).toBe(false);
    expect(execOptions?.onexecute?.()).toBe(false);
    expect(pg.factory).toHaveBeenCalledOnce();
    const [passedUrl, options] = pg.factory.mock.calls[0];
    expect(passedUrl).toBe(URL);
    expect(options).toMatchObject({ max: 2, prepare: false, idle_timeout: 20, connect_timeout: 10 });
    expect(options.types).toEqual({ bigint: pg.bigintParser });
    expect(options.onnotice).toBeTypeOf("function");
    await driver.close();
  });

  it("keeps transaction and savepoint work on their own runners without the root autocommit hook", async () => {
    const driver = await openPostgresDriver({ url: URL, max: 2 });
    pg.transaction.unsafe.mockResolvedValue([{ scope: "tx" }]);
    pg.savepoint.unsafe.mockResolvedValue([{ scope: "savepoint" }]);

    const value = await driver.transaction(async (tx) => {
      await expect(tx.run("transaction query", [])).resolves.toEqual([{ scope: "tx" }]);
      await expect(tx.savepoint!(async (nested) => nested.run("savepoint query", [])))
        .resolves.toEqual([{ scope: "savepoint" }]);
      return "committed";
    });

    expect(value).toBe("committed");
    expect(pg.root.unsafe).not.toHaveBeenCalled();
    expect(pg.transaction.unsafe).toHaveBeenCalledOnce();
    expect(pg.transaction.unsafe.mock.calls[0]?.[0]).toBe("transaction query");
    expect(pg.transaction.unsafe.mock.calls[0]?.[2]).toBeUndefined();
    expect(pg.savepoint.unsafe).toHaveBeenCalledOnce();
    expect(pg.savepoint.unsafe.mock.calls[0]?.[0]).toBe("savepoint query");
    expect(pg.savepoint.unsafe.mock.calls[0]?.[2]).toBeUndefined();
    expect(pg.root.begin).toHaveBeenCalledOnce();
    await driver.close();
  });

  it("normalizes rows and preserves sanitized adapter errors", async () => {
    const driver = await openPostgresDriver({ url: URL, max: 2 });
    const handle = createPlatformDbHandle(driver, { attempts: 1 });
    pg.root.unsafe.mockResolvedValue([{ happened_at: new Date("2026-10-19T00:00:00.000Z") }]);
    await expect(handle.query("select happened_at")).resolves.toEqual([
      { happened_at: "2026-10-19T00:00:00.000Z" },
    ]);

    const raw = Object.assign(new Error('invalid value: "private-row-value"'), {
      name: "PostgresError", code: "22000", severity: "ERROR",
    });
    pg.root.unsafe.mockRejectedValueOnce(raw);
    let caught: unknown;
    try { await handle.query("select secret"); } catch (error) { caught = error; }
    expect(caught).toMatchObject({ code: "db_error", sqlstate: "22000" });
    expect((caught as Error).message).not.toContain("private-row-value");
    expect((caught as Error & { cause?: unknown }).cause).toBeUndefined();
    await handle.close();
  });

  it("keeps handle queries on ALS transaction and savepoint runners after a nested rollback", async () => {
    const driver = await openPostgresDriver({ url: URL, max: 2 });
    const handle = createPlatformDbHandle(driver, { attempts: 1 });
    const nestedFailure = new Error("nested callback failed");
    const rollbackErrors: unknown[] = [];
    pg.transaction.unsafe.mockResolvedValue([{ route: "transaction" }]);
    pg.savepoint.unsafe.mockResolvedValue([{ route: "savepoint" }]);
    pg.transaction.savepoint.mockImplementation(async (callback) => {
      try {
        return await callback(pg.savepoint);
      } catch (error) {
        rollbackErrors.push(error);
        throw error;
      }
    });

    await handle.tx(async () => {
      await handle.query("outer before savepoint");
      try {
        await handle.tx(async () => {
          await handle.query("nested savepoint query");
          throw nestedFailure;
        });
      } catch (error) {
        expect(error).toBe(nestedFailure);
      }
      await handle.query("outer after savepoint rollback");
    });

    expect(rollbackErrors).toEqual([nestedFailure]);
    expect(pg.transaction.unsafe.mock.calls.map(([text]) => text)).toEqual([
      "outer before savepoint",
      "outer after savepoint rollback",
    ]);
    expect(pg.savepoint.unsafe.mock.calls.map(([text]) => text)).toEqual(["nested savepoint query"]);
    expect(pg.root.unsafe).not.toHaveBeenCalled();
    for (const calls of [pg.transaction.unsafe.mock.calls, pg.savepoint.unsafe.mock.calls]) {
      expect(calls.every((call) => call[2] === undefined)).toBe(true);
    }
    await handle.close();
  });
});
