/**
 * The platform control store's SQL executor: one interface (`PlatformDb`,
 * `controlplane/types.ts`), two engines — real PostgreSQL through postgres.js
 * (production, self-hosted, CI) and PGlite (Postgres compiled to WASM: local
 * development and tests, no Docker).
 *
 * What this file guarantees, identically on both engines:
 *
 *  - **Positional parameters.** `$1`, `$2`, … Nothing else is supported.
 *  - **Row shapes.** `timestamptz` → ISO-8601 string; `bigint`/`int8`
 *    (fence tokens, sequences, `count(*)`) → JS `number`, and a value beyond
 *    ±2^53 throws instead of silently rounding; `jsonb` → the parsed value;
 *    `numeric` stays a string (never used for anything the platform computes on).
 *    Timestamps therefore have millisecond precision in JS: **never round-trip
 *    a timestamp through the client to compare it in SQL** — order and expire
 *    in SQL, on the database's own clock (`clock_timestamp()`).
 *  - **JSON parameters are text.** Bind JSON as `$n::text::jsonb` with a
 *    `JSON.stringify`d string (`json()` in `sql.ts`). postgres.js serialises a
 *    parameter by the type the *server* infers for it, PGlite by the JS type,
 *    so a raw object or a plain string bound straight to a `jsonb` slot is
 *    encoded differently on the two engines. To make that mistake loud instead
 *    of silent, object and array parameters are rejected here on both.
 *  - **Transactions.** `tx(fn)` is `BEGIN … COMMIT`, resolving only after the
 *    commit. A nested `tx` on the handle it passed to `fn` (or, from the same
 *    async flow, on the top-level handle) opens a `SAVEPOINT` and rolls back to
 *    it alone on failure. The outermost `tx` is replayed on `40001`
 *    (serialization failure) and `40P01` (deadlock), up to five attempts —
 *    therefore **`fn` must be database-only**: no HTTP calls, no cloud SDK, no
 *    event publishing, nothing that cannot safely run twice.
 *  - **Errors carry no parameters or row values** (`PlatformDbError`).
 *
 * PGlite is one connection: queries and transactions serialise on an internal
 * mutex, so `Promise.all` of many writers is correct but not parallel; a query
 * issued on a *different* async flow while a transaction is open waits for it.
 * Inside `fn`, use the `sql` you were given (or the top-level handle from the
 * same flow — it is routed to the open transaction for you); never open a
 * second handle to the same PGlite database.
 *
 * Postgres is used through the Supavisor transaction pooler in production:
 * `prepare: false` (no named statements survive a pooler hop), no session
 * state, no advisory locks — leases are rows (`repos/leases.ts`).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import type { PlatformDb, Sql } from "@/lib/controlplane/types";
import { ControlStoreError, PlatformDbError } from "./errors";

/** A `Sql` that can also run multi-statement scripts (migrations). */
export interface ExecSql extends Sql {
  /** Run a script of one or more statements, no parameters, no result rows. */
  exec(text: string): Promise<void>;
}

/** What `openPlatformDb` returns: the contract's `PlatformDb` plus `exec` and an identity string. */
export interface PlatformDbHandle extends PlatformDb, ExecSql {
  /** `pglite://<dir or :memory:>` or `postgres://host:port/db` — never a user or password. */
  readonly identity: string;
}

type Row = Record<string, unknown>;

/** One physical connection (or one open transaction on it). */
export interface Conn {
  run(text: string, params: unknown[]): Promise<Row[]>;
  exec(text: string): Promise<void>;
  /**
   * Run `fn` inside a savepoint on this transaction, rolling back to it alone on
   * failure. Optional: an engine without a native scope (PGlite) gets raw
   * `SAVEPOINT` SQL from the handle. postgres.js MUST use its own scope,
   * because it remembers the first failed query of a transaction and rethrows
   * it at COMMIT time even when the caller handled it after a raw
   * `ROLLBACK TO SAVEPOINT` — only `sql.savepoint()` scopes the failure.
   */
  savepoint?<T>(fn: (conn: Conn) => Promise<T>): Promise<T>;
}

/** An engine. `transaction` is a bare BEGIN…COMMIT with no retry and no savepoints. */
export interface Driver extends Conn {
  readonly kind: "postgres" | "pglite";
  readonly identity: string;
  transaction<T>(fn: (conn: Conn) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/* ------------------------------ normalisation ------------------------------ */

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);

export function normalizeValue(value: unknown): unknown {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime()))
      throw new ControlStoreError("value_out_of_range", "The database returned a timestamp JavaScript cannot represent (infinity).");
    return value.toISOString();
  }
  if (typeof value === "bigint") {
    if (value > MAX_SAFE || value < MIN_SAFE)
      throw new ControlStoreError("value_out_of_range", "The database returned an integer beyond 2^53; it cannot be represented as a JavaScript number.");
    return Number(value);
  }
  return value;
}

export function normalizeRows<T>(rows: readonly Row[]): T[] {
  const out: Row[] = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    const src = rows[i];
    const dst: Row = {};
    for (const key of Object.keys(src)) dst[key] = normalizeValue(src[key]);
    out[i] = dst;
  }
  return out as T[];
}

/** Reject parameter shapes the two engines would encode differently. */
export function normalizeParams(params: readonly unknown[] | undefined): unknown[] {
  if (!params) return [];
  return params.map((value, index) => {
    if (value === undefined || value === null) return null;
    if (value instanceof Date) return value.toISOString();
    if (typeof value === "object" && !(value instanceof Uint8Array))
      throw new ControlStoreError(
        "invalid_input",
        `Query parameter $${index + 1} is an object or array. Bind JSON as JSON.stringify(value) with $${index + 1}::text::jsonb, and lists as a text[] literal with $${index + 1}::text[].`
      );
    return value;
  });
}

/* ------------------------------- the handle -------------------------------- */

export interface TxRetryOptions {
  /** total attempts including the first (default 5) */
  attempts?: number;
  /** wait before replay `attempt` (1-based), ms */
  backoffMs?: (attempt: number) => number;
}

const defaultBackoff = (attempt: number): number => Math.min(10 * 2 ** (attempt - 1), 160) * (0.5 + Math.random() / 2);

const sleep = (ms: number): Promise<void> =>
  ms <= 0
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
        (setTimeout(resolve, ms) as unknown as { unref?: () => void }).unref?.();
      });

interface TxFrame {
  sql: ExecSql;
}

async function run(conn: Conn, text: string, params: readonly unknown[] | undefined): Promise<Row[]> {
  const bound = normalizeParams(params);
  try {
    return await conn.run(text, bound);
  } catch (err) {
    throw PlatformDbError.from(err);
  }
}

async function execScript(conn: Conn, text: string): Promise<void> {
  try {
    await conn.exec(text);
  } catch (err) {
    throw PlatformDbError.from(err);
  }
}

/**
 * Wrap a driver as a `PlatformDbHandle`. Exported for tests that inject a
 * fault-injecting driver; production code calls `openPlatformDb`.
 */
export function createPlatformDbHandle(driver: Driver, retry: TxRetryOptions = {}): PlatformDbHandle {
  const attempts = Math.max(1, Math.trunc(retry.attempts ?? 5));
  const backoff = retry.backoffMs ?? defaultBackoff;
  const flow = new AsyncLocalStorage<TxFrame>();

  /** A `Sql` bound to one connection/transaction at savepoint depth `depth`. */
  const bound = (conn: Conn, depth: number): ExecSql => {
    const self: ExecSql = {
      query: async <T>(text: string, params?: readonly unknown[]) => normalizeRows<T>(await run(conn, text, params)),
      exec: (text) => execScript(conn, text),
      tx: async <T>(fn: (sql: Sql) => Promise<T>): Promise<T> => {
        const level = depth + 1;
        if (conn.savepoint) {
          try {
            return await conn.savepoint((child) => {
              const sql = bound(child, level);
              return flow.run({ sql }, () => fn(sql));
            });
          } catch (err) {
            throw PlatformDbError.from(err);
          }
        }
        const name = `zenith_sp_${level}`;
        await execScript(conn, `savepoint ${name}`);
        const child = bound(conn, level);
        try {
          const value = await flow.run({ sql: child }, () => fn(child));
          await execScript(conn, `release savepoint ${name}`);
          return value;
        } catch (err) {
          try {
            await execScript(conn, `rollback to savepoint ${name}`);
            await execScript(conn, `release savepoint ${name}`);
          } catch {
            /* the connection is gone; the caller's error is the one that matters */
          }
          throw err;
        }
      },
    };
    return self;
  };

  const top: ExecSql = bound(driver, 0);
  const active = (): ExecSql => flow.getStore()?.sql ?? top;

  const handle: PlatformDbHandle = {
    kind: driver.kind,
    identity: driver.identity,
    query: <T>(text: string, params?: readonly unknown[]) => active().query<T>(text, params),
    exec: (text) => active().exec(text),
    async tx<T>(fn: (sql: Sql) => Promise<T>): Promise<T> {
      const open = flow.getStore();
      if (open) return open.sql.tx(fn);
      let last: unknown;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
          return await driver.transaction((conn) => {
            const sql = bound(conn, 0);
            return flow.run({ sql }, () => fn(sql));
          });
        } catch (err) {
          const converted = PlatformDbError.from(err);
          if (converted instanceof PlatformDbError && converted.retryable && attempt < attempts) {
            last = converted;
            await sleep(backoff(attempt));
            continue;
          }
          throw converted;
        }
      }
      throw last;
    },
    close: () => driver.close(),
  };
  return handle;
}

/* --------------------------------- PGlite ---------------------------------- */

export interface PgliteDriverOptions {
  /** Persistent directory; omitted = in-memory (tests). */
  dataDir?: string;
}

export async function openPgliteDriver(opts: PgliteDriverOptions = {}): Promise<Driver> {
  const { PGlite } = await import("@electric-sql/pglite");
  if (opts.dataDir) fs.mkdirSync(opts.dataDir, { recursive: true });
  const pg = opts.dataDir ? new PGlite(opts.dataDir) : new PGlite();
  await pg.waitReady;
  const conn = (q: {
    query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
    exec: (text: string) => Promise<unknown>;
  }): Conn => ({
    run: async (text, params) => (await q.query(text, params)).rows as Row[],
    exec: async (text) => {
      await q.exec(text);
    },
  });
  const base = conn(pg as never);
  return {
    kind: "pglite",
    identity: `pglite://${opts.dataDir ?? ":memory:"}`,
    ...base,
    transaction: (fn) => pg.transaction((tx) => fn(conn(tx as never))),
    close: () => pg.close(),
  };
}

/* -------------------------------- Postgres --------------------------------- */

export interface PostgresDriverOptions {
  url: string;
  /** pool size, default 5 */
  max?: number;
}

/** host:port/database of a connection URL — never the user, password or query. */
export function postgresIdentity(url: string): string {
  try {
    const parsed = new URL(url);
    const database = parsed.pathname.replace(/^\//, "") || "postgres";
    return `postgres://${parsed.host}/${database}`;
  } catch {
    return "postgres://<unparseable url>";
  }
}

/**
 * Refuse anything that is not a `postgres://` / `postgresql://` URL — without
 * echoing it. (A bare `new URL()` failure is a TypeError that carries the input,
 * and the input is a connection string with a password in it.)
 */
export function assertPostgresUrl(url: string): void {
  let protocol: string | undefined;
  try {
    protocol = new URL(url).protocol;
  } catch {
    protocol = undefined;
  }
  if (protocol !== "postgres:" && protocol !== "postgresql:")
    throw new ControlStoreError(
      "invalid_input",
      "The platform control store URL is not a valid postgres:// or postgresql:// connection string (its value is not shown because it may contain a password).",
      { variable: "ZENITH_PLATFORM_DB_URL" }
    );
}

export async function openPostgresDriver(opts: PostgresDriverOptions): Promise<Driver> {
  assertPostgresUrl(opts.url);
  const postgres = (await import("postgres")).default;
  const client = postgres(opts.url, {
    max: opts.max ?? 5,
    // Supavisor transaction mode hands the next transaction to a different
    // backend, so a named prepared statement would not exist there.
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 10,
    // The driver's own logging would print the host (and on some failures,
    // parameters) to stdout; every failure is reported through PlatformDbError.
    onnotice: () => {},
    // bigint columns as BigInt so `normalizeValue` can bound-check them.
    types: { bigint: postgres.BigInt },
  });
  type Runner = {
    unsafe: (text: string, params?: never[], options?: { onexecute: () => false }) => PromiseLike<Iterable<Row>>;
    savepoint?: (fn: (sp: Runner) => Promise<unknown>) => Promise<unknown>;
  };
  // Supavisor transaction pooling can lose replies when root queries pipeline.
  // In Postgres.js 3.4.7, the internal onexecute hook keeps a normally dispatched
  // root query's connection full until ReadyForQuery. Leave begin/savepoint's
  // own connection ownership unchanged.
  const autocommit = { onexecute: (): false => false };
  const conn = (q: Runner, options?: typeof autocommit): Conn => ({
    // No parameters → simple protocol (multi-statement allowed); otherwise extended.
    run: async (text, params) => Array.from(await q.unsafe(text, params as never[], options)),
    exec: async (text) => {
      await q.unsafe(text, undefined, options);
    },
    // Only a transaction scope has `savepoint`; the pooled client does not.
    savepoint: q.savepoint
      ? async <T>(fn: (c: Conn) => Promise<T>): Promise<T> => {
          const box = (await (q.savepoint as NonNullable<Runner["savepoint"]>)(async (sp) => ({ value: await fn(conn(sp)) }))) as { value: T };
          return box.value;
        }
      : undefined,
  });
  return {
    kind: "postgres",
    identity: postgresIdentity(opts.url),
    ...conn(client as unknown as Runner, autocommit),
    // `begin` unwraps an array return value, so the callback's value travels boxed.
    transaction: async <T>(fn: (c: Conn) => Promise<T>): Promise<T> => {
      const box = (await client.begin(async (t) => ({ value: await fn(conn(t as unknown as Runner)) }))) as unknown as { value: T };
      return box.value;
    },
    close: async () => {
      try {
        await client.end({ timeout: 5 });
      } catch {
        /* closing twice, or a client that never connected, is not a failure */
      }
    },
  };
}
