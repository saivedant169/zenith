/**
 * The Postgres transaction helper: the same commit-before-ACK contract
 * `authority/tx.ts` states, on a connection that really does yield.
 *
 * **Same shape, same rules.**
 *
 *  - The outermost frame is `BEGIN … COMMIT` on a reserved connection, and
 *    `transactPg()` resolves only after the commit succeeded.
 *  - A nested call opens a `SAVEPOINT` and rolls back to it alone on failure,
 *    so an inner helper's failure does not discard its caller's work.
 *  - Retry is bounded (`TX_MAX_ATTEMPTS`) with the same backoff
 *    (`TX_BACKOFF_MS`), and only the outermost frame owns the decision to
 *    replay. `fn` may therefore run more than once and must be database work
 *    only — the rule the outbox exists to keep.
 *
 * **Nesting is detected the way `sqlite.ts` detects it: through
 * `AsyncLocalStorage`, never by asking the connection.** The reasoning carries
 * over exactly. A flag on the connection ("am I in a transaction?") answers for
 * the *connection*, and with `max: 1` a second flow sharing that connection
 * would read `true` and open a savepoint inside a transaction it does not own —
 * losing it the moment the owner committed. The async context answers for *this
 * flow*, which is the question that matters. A flow that is not inside our
 * transaction reserves a fresh connection, and the driver's own pool is what
 * makes it wait.
 *
 * **No mutex, unlike SQLite.** The SQLite authority serialises every
 * transaction because `DatabaseSync` is one connection and two interleaved
 * `BEGIN`s would produce a commit belonging to neither. Each transaction here
 * reserves its connection for its duration, so two overlapping
 * transactions are two transactions and Postgres arbitrates between them — with
 * `40001` or `40P01` when they genuinely conflict, which is what the retry
 * above is for.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { env } from "@/lib/env";
import { TX_BACKOFF_MS, TX_MAX_ATTEMPTS, type TransactOptions } from "../tx";
import type { Sql, TransactionSql } from "./client";
import { exhausted, isRetryable } from "./errors";

export { TX_BACKOFF_MS, TX_MAX_ATTEMPTS, type TransactOptions };

/** What an open transaction puts in the async context. */
interface TxContext {
  /** The transaction's own tag. Every statement of this transaction uses it. */
  sql: TransactionSql;
  /** How deep the savepoint stack is. 0 means "in a transaction, no savepoint". */
  depth: number;
}

/**
 * True for this async context while it is inside a `transactPg()` callback.
 * Promise continuations inherit it, so an `await` inside the callback does not
 * lose the fact that a transaction is open.
 */
const inTransaction = new AsyncLocalStorage<TxContext>();

/** The transaction this async context is inside, if any. */
export const currentPgTransaction = (): TransactionSql | undefined => inTransaction.getStore()?.sql;

/**
 * The savepoint name for one nesting level.
 *
 * Identical to the SQLite authority's (`zenith_sp_<level>`), and for the same
 * reason: names have to be unique down one nesting chain, and a name that
 * appears in a Postgres log next to a name in a SQLite trace being the same
 * name is worth more than either being prettier. Levels start at 1.
 */
export const savepointName = (level: number): string => `zenith_sp_${level}`;

/** The wait before replay `attempt`. Zero under ZENITH_FAST, as everywhere else. */
export function backoffFor(attempt: number): number {
  if (env().ZENITH_FAST) return 0;
  return TX_BACKOFF_MS[Math.min(attempt, TX_BACKOFF_MS.length) - 1] ?? 0;
}

/** A wait that never keeps the process alive. */
const sleep = (ms: number): Promise<void> =>
  ms <= 0
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
        (setTimeout(resolve, ms) as unknown as { unref?: () => void }).unref?.();
      });

/**
 * Run `fn` in one durable transaction on `client` and resolve with its value.
 *
 * Outermost frame: `sql.begin`, replayed on a retryable SQLSTATE with backoff.
 * Nested frame: `sql.savepoint`, no retry — only the outermost frame replays,
 * because a savepoint's caller may already have acted on work this frame would
 * repeat.
 */
export async function transactPg<T>(
  client: Sql,
  fn: (sql: TransactionSql) => Promise<T>,
  opts: TransactOptions = {}
): Promise<T> {
  const open = inTransaction.getStore();
  if (open) return withSavepoint(open, fn);

  const attempts = Math.max(1, Math.trunc(opts.attempts ?? TX_MAX_ATTEMPTS));
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      // Resolves after COMMIT, which is the whole contract.
      return await reservedTransaction(client, (tx) => inTransaction.run({ sql: tx, depth: 0 }, () => fn(tx)));
    } catch (err) {
      if (!isRetryable(err)) throw err;
      last = err;
      await sleep(backoffFor(attempt));
    }
  }
  throw exhausted(last, attempts);
}

/**
 * `SAVEPOINT` … `RELEASE` around `fn`, with `ROLLBACK TO` on a throw.
 *
 * All three run on the transaction's own connection; the depth counter makes
 * sibling savepoints at the same level reuse a name and nested ones do not.
 * The depth is restored in `finally` whichever way the frame left, or the next
 * sibling would nest inside a savepoint that is already gone.
 */
async function withSavepoint<T>(
  open: TxContext,
  fn: (sql: TransactionSql) => Promise<T>
): Promise<T> {
  const level = open.depth + 1;
  const name = savepointName(level);
  try {
    await open.sql.unsafe(`savepoint ${name}`);
    try {
      const value = await inTransaction.run({ sql: open.sql, depth: level }, () => fn(open.sql));
      await open.sql.unsafe(`release savepoint ${name}`);
      return value;
    } catch (err) {
      await open.sql.unsafe(`rollback to savepoint ${name}`);
      throw err;
    }
  } finally {
    open.depth = level - 1;
  }
}

/**
 * `BEGIN` … `COMMIT` on a connection reserved for the whole transaction, `ROLLBACK` on a throw.
 *
 * Supavisor's transaction mode loses replies queued behind a pipelined root statement, so the client runs with
 * `max_pipeline: 0`; Postgres.js 3.4 `sql.begin` then never reserves its connection (porsager/postgres#1211).
 * A reserved connection carries the transaction instead, and the callback's value comes back unchanged.
 */
async function reservedTransaction<T>(client: Sql, fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
  const reserved = await client.reserve();
  const tx = reserved as unknown as TransactionSql;
  try {
    await tx.unsafe("begin");
    let value: T;
    try {
      value = await fn(tx);
    } catch (err) {
      await tx.unsafe("rollback").catch(() => undefined);
      throw err;
    }
    await tx.unsafe("commit");
    return value;
  } finally {
    reserved.release();
  }
}
