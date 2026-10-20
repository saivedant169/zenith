/**
 * `pg/tx.ts` and `pg/errors.ts` against a mocked tag function.
 *
 * No database, on purpose. The two things this file is about — *which*
 * SQLSTATEs cause a replay, and *what* a savepoint is named at each nesting
 * level — are decisions the code makes before any statement is sent, and a real
 * Postgres would only make them harder to observe. The contract suite
 * (`./contract/`) is where the same code meets a real database.
 *
 * The fake records what it was asked to do, so an assertion can be about the
 * sequence — "begin, begin, begin" is a replay; "begin, savepoint zenith_sp_1"
 * is nesting — rather than about a return value that cannot tell the two apart.
 */
import { describe, expect, it } from "vitest";
import { isolatedDataDir } from "../_fixtures";

isolatedDataDir("zenith-authority-pg-tx-");

const { transactPg, savepointName, backoffFor, currentPgTransaction, TX_MAX_ATTEMPTS, TX_BACKOFF_MS } =
  await import("@/lib/hosted/authority/pg/tx");
const { isRetryable, isUniqueViolation, exhausted, PG_RETRYABLE_CODES } = await import(
  "@/lib/hosted/authority/pg/errors"
);
const { HostedError } = await import("@/lib/hosted/contracts");

type Sql = Parameters<typeof transactPg>[0];

/** What the fake was asked to do, in order. */
type Step = { op: "begin" } | { op: "savepoint"; name: string };

/**
 * A stand-in for postgres.js: `begin` and `savepoint` run their callback and
 * record the call, and nothing is ever sent anywhere.
 *
 * `savepoint` is put on the object the callback receives, which is how the real
 * driver exposes it too — a savepoint only exists inside a transaction.
 */
function fakeSql(): { sql: Sql; steps: Step[] } {
  const steps: Step[] = [];
  const inner = {
    savepoint: async <T>(name: string, fn: (sp: unknown) => Promise<T>): Promise<T> => {
      steps.push({ op: "savepoint", name });
      return fn(inner);
    },
  };
  const sql = {
    begin: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      steps.push({ op: "begin" });
      return fn(inner);
    },
  };
  return { sql: sql as unknown as Sql, steps };
}

/** An error shaped the way postgres.js shapes one. */
function pgError(code: string): Error {
  const err = new Error(`postgres reported ${code}`);
  (err as Error & { code: string }).code = code;
  return err;
}

describe("retry classification", () => {
  it("replays the whole transaction for every retryable SQLSTATE, and only those", () => {
    // The set is small and load-bearing, so it is listed here as well as in the
    // source: a code silently added to one and not the other is the bug.
    expect([...PG_RETRYABLE_CODES]).toEqual(["40001", "40P01", "53300", "08006", "08003"]);
    for (const code of PG_RETRYABLE_CODES) expect(isRetryable(pgError(code))).toBe(true);
  });

  it("does not replay a constraint violation, a syntax error or a plain Error", () => {
    // These are the ones that matter: a unique violation replayed five times is
    // five identical failures and four wasted round trips, and a caller waiting
    // on a 409 gets it a second later than it should.
    for (const code of ["23505", "23503", "23514", "42P01", "42601", "22P02"])
      expect(isRetryable(pgError(code))).toBe(false);
    expect(isRetryable(new Error("socket hang up"))).toBe(false);
    expect(isRetryable("not an error at all")).toBe(false);
    expect(isRetryable(undefined)).toBe(false);
  });

  it("recognises 23505 as a unique violation, the way SQLite's 2067/1555 are", () => {
    expect(isUniqueViolation(pgError("23505"))).toBe(true);
    expect(isUniqueViolation(pgError("23503"))).toBe(false);
    expect(isUniqueViolation(new Error("UNIQUE constraint failed"))).toBe(false);
  });

  it("replays up to the attempt ceiling and then refuses with policy_unavailable", async () => {
    const { sql, steps } = fakeSql();
    await expect(
      transactPg(
        sql,
        async () => {
          throw pgError("40001");
        },
        { attempts: 3 }
      )
    ).rejects.toMatchObject({ code: "policy_unavailable" });
    expect(steps).toEqual([{ op: "begin" }, { op: "begin" }, { op: "begin" }]);
  });

  it("defaults to TX_MAX_ATTEMPTS, the same ceiling SQLite uses", async () => {
    const { sql, steps } = fakeSql();
    await expect(
      transactPg(sql, async () => {
        throw pgError("53300");
      })
    ).rejects.toBeInstanceOf(HostedError);
    expect(steps).toHaveLength(TX_MAX_ATTEMPTS);
    expect(TX_BACKOFF_MS).toHaveLength(TX_MAX_ATTEMPTS - 1);
  });

  it("gives up immediately on anything that is not retryable, keeping the original error", async () => {
    const { sql, steps } = fakeSql();
    const unique = pgError("23505");
    await expect(transactPg(sql, async () => Promise.reject(unique))).rejects.toBe(unique);
    expect(steps).toEqual([{ op: "begin" }]);
  });

  it("succeeds on a later attempt and returns that attempt's value", async () => {
    const { sql, steps } = fakeSql();
    let tries = 0;
    const value = await transactPg(sql, async () => {
      tries += 1;
      if (tries < 3) throw pgError("40P01");
      return "committed";
    });
    expect(value).toBe("committed");
    expect(steps).toHaveLength(3);
  });

  it("names the attempt count and the SQLSTATE in the refusal, and says nothing was half-written", () => {
    const refusal = exhausted(pgError("40001"), 5);
    expect(refusal.code).toBe("policy_unavailable");
    expect(refusal.message).toContain("5 attempts");
    expect(refusal.message).toContain("40001");
    expect(refusal.message).toContain("nothing was half-written");
  });

  it("backs off between replays, and not at all under ZENITH_FAST", () => {
    // The suite runs with ZENITH_FAST set, which is what keeps five attempts
    // from costing 375ms of real waiting.
    expect(backoffFor(1)).toBe(0);
    expect(TX_BACKOFF_MS[0]).toBeGreaterThan(0);
  });
});

describe("savepoints", () => {
  it("names level n zenith_sp_n, exactly as the SQLite authority does", () => {
    expect(savepointName(1)).toBe("zenith_sp_1");
    expect(savepointName(2)).toBe("zenith_sp_2");
    expect(savepointName(7)).toBe("zenith_sp_7");
  });

  it("opens a savepoint rather than a second transaction when nested", async () => {
    const { sql, steps } = fakeSql();
    await transactPg(sql, async () => {
      await transactPg(sql, async () => {
        await transactPg(sql, async () => "deep");
        return "inner";
      });
      return "outer";
    });
    expect(steps).toEqual([
      { op: "begin" },
      { op: "savepoint", name: "zenith_sp_1" },
      { op: "savepoint", name: "zenith_sp_2" },
    ]);
  });

  it("reuses a level for siblings and does not let the depth drift", async () => {
    // Two nested calls one after the other are both level 1: the first one's
    // savepoint is gone by the time the second opens. A depth that only ever
    // grew would name the second `zenith_sp_2` and nest it inside nothing.
    const { sql, steps } = fakeSql();
    await transactPg(sql, async () => {
      await transactPg(sql, async () => "first");
      await transactPg(sql, async () => "second");
    });
    expect(steps).toEqual([
      { op: "begin" },
      { op: "savepoint", name: "zenith_sp_1" },
      { op: "savepoint", name: "zenith_sp_1" },
    ]);
  });

  it("restores the depth after a nested frame throws", async () => {
    const { sql, steps } = fakeSql();
    await transactPg(sql, async () => {
      await expect(
        transactPg(sql, async () => {
          throw new Error("inner failed");
        })
      ).rejects.toThrow("inner failed");
      // The next sibling must still be level 1, not level 2.
      await transactPg(sql, async () => "after");
    });
    expect(steps).toEqual([
      { op: "begin" },
      { op: "savepoint", name: "zenith_sp_1" },
      { op: "savepoint", name: "zenith_sp_1" },
    ]);
  });

  it("never replays a nested frame: only the outermost owns that decision", async () => {
    const { sql, steps } = fakeSql();
    await expect(
      transactPg(sql, async () => {
        await transactPg(
          sql,
          async () => {
            throw pgError("40001");
          },
          { attempts: 5 }
        );
      })
    ).rejects.toMatchObject({ code: "policy_unavailable" });
    // Five outer attempts, each opening exactly one savepoint. A nested frame
    // that retried on its own would show five savepoints per begin.
    expect(steps.filter((s) => s.op === "begin")).toHaveLength(5);
    expect(steps.filter((s) => s.op === "savepoint")).toHaveLength(5);
  });

  it("reports no open transaction outside one, and the transaction's own tag inside", async () => {
    const { sql } = fakeSql();
    expect(currentPgTransaction()).toBeUndefined();
    await transactPg(sql, async (tx) => {
      expect(currentPgTransaction()).toBe(tx);
      await transactPg(sql, async (sp) => {
        expect(currentPgTransaction()).toBe(sp);
      });
      // Back to the outer transaction once the savepoint frame has left.
      expect(currentPgTransaction()).toBe(tx);
    });
    expect(currentPgTransaction()).toBeUndefined();
  });
});
