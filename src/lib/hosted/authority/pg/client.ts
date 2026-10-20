/**
 * The one `postgres` client this process talks to Supabase through.
 *
 * Every option here is a consequence of *where* this runs: Vercel serverless
 * functions in `bom1`, against a free-tier Supabase project in `ap-south-1`,
 * reached through the Supavisor **transaction-mode** pooler on port 6543.
 *
 *  - **`prepare: false` is not a tuning knob, it is a correctness
 *    requirement.** Transaction-mode pooling hands a different backend
 *    connection to the next transaction, so a named prepared statement created
 *    on one backend is simply absent on the next — the classic
 *    `prepared statement "s1" does not exist`. Turning named prepares off makes
 *    every statement self-contained. Parameters are still sent out of band, so
 *    nothing about injection changes.
 *  - **`max: 1`.** A serverless invocation serves one request and then freezes;
 *    a pool of ten would hold ten pooler slots that this instance is not using
 *    while a hundred other instances wait for theirs. The free tier's pooler
 *    budget is small enough that one connection per instance is the difference
 *    between "slow" and "no connections available".
 *  - **A short `idle_timeout`.** A frozen instance cannot close anything, so
 *    the connection has to give itself up. Shorter than the pooler's own idle
 *    cutoff, so this side notices first and reconnects rather than discovering
 *    a half-open socket on the next query.
 *  - **A finite `connect_timeout`.** Mumbai to Mumbai is single-digit
 *    milliseconds when it works; ten seconds of waiting means it is not going
 *    to work, and a request that fails saying so is worth more than one that
 *    hangs until the platform kills it.
 *
 * **The URL is never logged, never in an error, never in a message.** It
 * carries the database password. `env.ts` already redacts `SUPABASE_DB_URL`;
 * nothing here undoes that.
 */
import postgres from "postgres";
import { HostedError } from "@/lib/hosted/contracts";
import { env } from "@/lib/env";
import { isOpenedPlatformPostgresTarget } from "@/lib/controlplane/db/open";
import type { Sql as NativeSql } from "@/lib/controlplane/types";

/** The tag function, as everything in this directory passes it around. */
export type Sql = postgres.Sql<Record<string, never>>;

/** The same tag, bound to an open transaction. What `tx()` hands its repositories. */
export type TransactionSql = postgres.TransactionSql<Record<string, never>>;

/** How long an unused connection is kept before it is closed, in seconds. */
export const PG_IDLE_TIMEOUT_S = 20;

/** How long a connection attempt may take before it is a failure, in seconds. */
export const PG_CONNECT_TIMEOUT_S = 10;

type PgGlobal = typeof globalThis & { __zenithHostedPg?: Sql };

/**
 * The connection string, or a refusal naming the variable to set.
 *
 * Read at call time rather than at import: the file store is the default, and
 * an install with no Postgres configuration at all must keep booting.
 */
export function hostedDatabaseUrl(): string {
  const url = env().SUPABASE_DB_URL;
  if (!url)
    throw new HostedError(
      "internal",
      "The hosted control authority is configured for Postgres (ZENITH_HOSTED_STORE=postgres) but SUPABASE_DB_URL is not set, so there is nothing to connect to.",
      {
        fix: "Set SUPABASE_DB_URL to the Supavisor transaction-mode pooler URI (port 6543) from the Supabase dashboard, or set ZENITH_HOSTED_STORE=sqlite to use the embedded control authority.",
      }
    );
  return url;
}

interface OpeningTarget { host:string; port:number; database:string; username:string }
interface OriginalObject { value:object; prototype:object|null; descriptors:Map<PropertyKey,PropertyDescriptor> }
interface ClientOrigin { target?:OpeningTarget; original:OriginalObject; options:OriginalObject; nested:OriginalObject[]; parsers:Map<string,PropertyDescriptor|undefined>; serializers:Map<string,PropertyDescriptor|undefined>; closed:boolean; defaultCreated:boolean }
const clientOrigins=new WeakMap<object,ClientOrigin>();
function openingTarget(raw:string):OpeningTarget|undefined {
  try {
    const url=new URL(raw),options=[...url.searchParams];
    if(!["postgres:","postgresql:"].includes(url.protocol)||!url.hostname||!url.port||!url.username||!url.pathname.slice(1)||url.hash
      ||options.length>1||options.some(([key,value])=>key!=="sslmode"||!["require","verify-full"].includes(value)))return undefined;
    const port=Number(url.port);if(!Number.isInteger(port)||port<1||port>65535||url.hostname.includes(","))return undefined;
    return {host:url.hostname,port,database:decodeURIComponent(url.pathname.slice(1)),username:decodeURIComponent(url.username)};
  }catch{return undefined;}
}
function original(value:object):OriginalObject {
  return {value,prototype:Object.getPrototypeOf(value),descriptors:new Map(Reflect.ownKeys(value).map(key=>[key,Object.getOwnPropertyDescriptor(value,key)!]))};
}
function unchanged(saved:OriginalObject):boolean {
  return Object.getPrototypeOf(saved.value)===saved.prototype&&Reflect.ownKeys(saved.value).length===saved.descriptors.size
    &&[...saved.descriptors].every(([key,before])=>sameDescriptor(Object.getOwnPropertyDescriptor(saved.value,key),before));
}
function sameDescriptor(current:PropertyDescriptor|undefined,before:PropertyDescriptor|undefined):boolean {
  if(!current||!before)return current===before;
  return current.enumerable===before.enumerable&&current.configurable===before.configurable
    &&("value" in before?"value" in current&&current.value===before.value&&current.writable===before.writable
      :!("value" in current)&&current.get===before.get&&current.set===before.set);
}
function ownObject(value:object,key:string):object|undefined {
  const field=Object.getOwnPropertyDescriptor(value,key);
  return field&&"value" in field&&field.value&&typeof field.value==="object"?field.value:undefined;
}
function known(value:unknown):ClientOrigin|undefined {
  if((typeof value!=="object"&&typeof value!=="function")||!value)return undefined;
  const saved=clientOrigins.get(value);if(!saved||saved.closed||!saved.target||!unchanged(saved.original)||!unchanged(saved.options)||!saved.nested.every(unchanged))return undefined;
  const parser=ownObject(saved.options.value,"parsers"),serializer=ownObject(saved.options.value,"serializers");
  if(!parser||!serializer||![...saved.parsers].every(([key,before])=>sameDescriptor(Object.getOwnPropertyDescriptor(parser,key),before))
    ||![...saved.serializers].every(([key,before])=>sameDescriptor(Object.getOwnPropertyDescriptor(serializer,key),before)))return undefined;
  const host=ownObject(saved.options.value,"host"),port=ownObject(saved.options.value,"port");
  // These exact arrays are included in the private nested descriptor snapshots.
  // Read their data descriptors only after that check, never an indexed getter.
  if(!host||!port||!Array.isArray(host)||!Array.isArray(port))return undefined;
  const hostLength=Object.getOwnPropertyDescriptor(host,"length"),portLength=Object.getOwnPropertyDescriptor(port,"length");
  const hostValue=Object.getOwnPropertyDescriptor(host,"0"),portValue=Object.getOwnPropertyDescriptor(port,"0");
  if(!hostLength||!("value" in hostLength)||hostLength.value!==1||!hostValue||!("value" in hostValue)||hostValue.value!==saved.target.host
    ||!portLength||!("value" in portLength)||portLength.value!==1||!portValue||!("value" in portValue)||portValue.value!==saved.target.port)return undefined;
  return saved;
}
/** Fixed boolean lookup. An exported tooling constructor cannot register default authority. */
export function isDefaultPgAuthorityClient(value:unknown):boolean {
  try {
    const saved=known(value),current=Object.getOwnPropertyDescriptor(globalThis,"__zenithHostedPg");
    return !!saved?.defaultCreated&&!!current&&"value" in current&&current.value===value
      &&JSON.stringify(openingTarget(hostedDatabaseUrl()))===JSON.stringify(saved.target);
  }catch{return false;}
}
/** The owner is an actual privately opened native handle, not an environment URL assertion. */
export function isDefaultPgAuthorityClientFor(value:unknown,owner:NativeSql):boolean {
  try {
    const target=known(value)?.target;
    return !!target&&isDefaultPgAuthorityClient(value)
      &&isOpenedPlatformPostgresTarget(owner,target.host,target.port,target.database,target.username);
  }catch{return false;}
}

/**
 * The process-wide client, created on first use.
 *
 * Held on `globalThis` for the same reason the SQLite connection is: Next.js
 * re-evaluates modules on hot reload, and a module-scoped variable would leak a
 * second pool on every edit.
 */
export function pgAuthorityClient(): Sql {
  const g = globalThis as PgGlobal;
  if (g.__zenithHostedPg) return g.__zenithHostedPg;
  return (g.__zenithHostedPg = createClient(hostedDatabaseUrl(),true));
}

/** Build a client for one connection string. Exported for tests and tooling. */
export function createPgAuthorityClient(url: string): Sql { return createClient(url,false); }
function createClient(url:string,defaultCreated:boolean):Sql {
  const client=postgres(url, {
    max: 1,
    idle_timeout: PG_IDLE_TIMEOUT_S,
    connect_timeout: PG_CONNECT_TIMEOUT_S,
    // See the header: transaction-mode pooling forbids named prepares.
    prepare: false,
    // Supavisor transaction mode never forwards a root statement pipelined behind a busy one, and with max: 1 every
    // later query then waits forever (porsager/postgres#970). Transactions use a reserved connection (pg/tx.ts).
    // The 3.4 type declarations omit max_pipeline; the driver reads it like max.
    ...({ max_pipeline: 0 } as object),
    // No `search_path` startup parameter: Supavisor is free to refuse a
    // non-default one in transaction mode, and every statement in this
    // directory names its schema anyway (`hosted.hosted_jobs`, never
    // `hosted_jobs`). Nothing here ever touches `public`, which belongs to the
    // system of record (0001_system_of_record.sql).
    //
    // The driver's own logging would put the connection string's host — and,
    // on some failures, its parameters — into stdout. Everything worth saying
    // is said by the HostedError this module raises.
    onnotice: () => {},
  }) as Sql;
  const options=ownObject(client,"options"),target=openingTarget(url);
  if(options) {
    const end=client.end;let closed=false;
    const wrapped:Sql["end"]=(...args)=>{closed=true;const saved=clientOrigins.get(client);if(saved)saved.closed=true;return end(...args);};
    Object.defineProperty(client,"end",{...Object.getOwnPropertyDescriptor(client,"end"),value:wrapped});
    const nested=["connection","transform","host","port"].map(key=>ownObject(options,key)).filter((value):value is object=>!!value);
    const transform=ownObject(options,"transform");
    if(transform)for(const key of ["column","value","row"]){const value=ownObject(transform,key);if(value)nested.push(value);}
    const parsers=ownObject(options,"parsers"),serializers=ownObject(options,"serializers");
    const database=Object.getOwnPropertyDescriptor(options,"database"),username=Object.getOwnPropertyDescriptor(options,"user"),connection=ownObject(options,"connection");
    // The locked driver merges startup connection fields over user/database.
    // Only the native factory's target-neutral application name is supported.
    const startupSafe=!!connection&&Reflect.ownKeys(connection).every(key=>key==="application_name");
    const proved=target&&database&&"value" in database&&database.value===target.database&&username&&"value" in username&&username.value===target.username&&startupSafe?target:undefined;
    if(parsers&&serializers)clientOrigins.set(client,{target:proved,original:original(client),options:original(options),nested:nested.map(original),
      parsers:new Map(["16","25","1043","114","3802","23"].map(key=>[key,Object.getOwnPropertyDescriptor(parsers,key)])),
      serializers:new Map(["16","25","1043","114","3802","23"].map(key=>[key,Object.getOwnPropertyDescriptor(serializers,key)])),closed,defaultCreated});
  }
  return client;
}

/** Close the process-wide client and forget it. Tests and scripts; a server exits. */
export async function closePgAuthorityClient(): Promise<void> {
  const g = globalThis as PgGlobal;
  const existing = g.__zenithHostedPg;
  delete g.__zenithHostedPg;
  if (!existing) return;
  try {
    await existing.end({ timeout: 5 });
  } catch {
    /* closing twice, or closing a client that never connected, is not a failure */
  }
}

/**
 * The identity of the database, for `Authority.path` — host, port and database
 * name, and **never** the user or the password.
 *
 * Diagnostics print this. A connection string that could not be parsed answers
 * with a fixed placeholder rather than a substring of itself, because the one
 * thing worse than an unhelpful identity is half a credential in a log line.
 */
export function pgIdentity(url: string): string {
  try {
    const parsed = new URL(url);
    const database = parsed.pathname.replace(/^\//, "") || "postgres";
    return `postgres://${parsed.host}/${database}`;
  } catch {
    return "postgres://<unparseable SUPABASE_DB_URL>";
  }
}
