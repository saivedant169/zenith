/** The hosted client's begin() on a reserved connection: its statements, savepoints, rollback and commit check. */
import { describe, expect, it } from "vitest";
import { reservedBegin, type Sql, type TransactionSql } from "@/lib/hosted/authority/pg/client";

function fakeClient(commitTag = "COMMIT") {
  const sent: string[] = [];
  let released = 0;
  const client = {
    reserve: async () => Object.assign(async () => [], {
      unsafe: async (text: string) => { sent.push(text); return Object.assign([], { command: text === "commit" ? commitTag : text.split(" ")[0].toUpperCase() }); },
      release: () => { released++; },
    }),
  } as unknown as Sql;
  return { begin: reservedBegin(client), sent, released: () => released };
}

describe("reservedBegin", () => {
  it("commits, scopes a savepoint failure, awaits an array and releases the connection", async () => {
    const ok = fakeClient();
    const value = await ok.begin("isolation level read committed; drop table x", async (tx: TransactionSql) => {
      await expect(tx.savepoint("zenith_sp_1", async () => { throw new Error("inner"); })).rejects.toThrow("inner");
      await tx.savepoint(async () => undefined);
      return "done";
    });
    expect(value).toBe("done");
    // Like Postgres.js, an array returned synchronously is awaited element by element.
    expect(await fakeClient().begin(() => [Promise.resolve(1), Promise.resolve(2)])).toEqual([1, 2]);
    expect(ok.sent).toEqual(["begin isolation level read committed drop table x", "savepoint s0_zenith_sp_1", "rollback to s0_zenith_sp_1", "savepoint s1", "commit"]);
    expect(ok.released()).toBe(1);
  });

  it("rolls back on a throw and refuses a COMMIT the server answered with ROLLBACK", async () => {
    const thrown = fakeClient();
    await expect(thrown.begin(async () => { throw new Error("outer"); })).rejects.toThrow("outer");
    expect(thrown.sent).toEqual(["begin ", "rollback"]);
    const aborted = fakeClient("ROLLBACK");
    await expect(aborted.begin(async () => 1)).rejects.toThrow("rolled back by the database");
    expect([thrown.released(), aborted.released()]).toEqual([1, 1]);
  });
});
