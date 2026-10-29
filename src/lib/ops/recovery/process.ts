/**
 * Process and connection plumbing for the backup and restore runbook (PROD-OPS-04).
 *
 * Connection strings carry passwords. They are never put on a command line (visible in the process list), never
 * logged and never written to a manifest or report: `pgArgs` splits a URL into host, port, user and database
 * arguments and passes the password through `PGPASSWORD` in the child's environment only. A runner is injectable so
 * tests exercise the real pg_dump/pg_restore/temporal binaries or an explicit fake, never a silent stub.
 */
import { execFile } from "node:child_process";
import path from "node:path";

export interface RunResult { code: number; stdout: string; stderr: string }
export interface RunOptions { env?: Readonly<Record<string, string>>; timeoutMs?: number; maxBuffer?: number }
export type CommandRunner = (file: string, args: readonly string[], options?: RunOptions) => Promise<RunResult>;

/** The real runner. Resolves with the exit code instead of throwing, so callers decide what a failure means. */
export const execRunner: CommandRunner = (file, args, options = {}) =>
  new Promise((resolve) => {
    const env = { PATH: process.env.PATH, HOME: process.env.HOME ?? process.env.USERPROFILE, SYSTEMROOT: process.env.SYSTEMROOT, ...options.env } as unknown as NodeJS.ProcessEnv;
    execFile(file, [...args], { env, timeout: options.timeoutMs ?? 30 * 60_000, maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      // execFile reports a numeric exit code for a failing process and a string (ENOENT, ...) when it could not start.
      const failure = error as { code?: unknown } | null;
      const code = failure === null ? 0 : typeof failure.code === "number" ? failure.code : 127;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });

export class RecoveryToolError extends Error {
  constructor(readonly code: "tool_unavailable" | "tool_failed" | "refused" | "invalid_input" | "integrity", message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = "RecoveryToolError";
  }
}

export interface PgConnection {
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  /** safe to print: host:port/database */
  readonly label: string;
}

/** Split a postgres URL into arguments and a child environment. Throws a message that never contains the URL. */
export function pgArgs(url: string, parent: Readonly<Record<string, string | undefined>> = process.env): PgConnection {
  let u: URL;
  try { u = new URL(url); } catch { throw new RecoveryToolError("invalid_input", "The database URL is not a valid postgres URL."); }
  if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") throw new RecoveryToolError("invalid_input", "The database URL must be a postgres:// URL.");
  const database = decodeURIComponent(u.pathname.replace(/^\//, ""));
  if (!database) throw new RecoveryToolError("invalid_input", "The database URL names no database.");
  const port = u.port || "5432";
  const env: Record<string, string> = {};
  if (u.password) env.PGPASSWORD = decodeURIComponent(u.password);
  const sslmode = u.searchParams.get("sslmode");
  if (sslmode && /^[a-z-]{1,20}$/.test(sslmode)) env.PGSSLMODE = sslmode;
  // The tool's child sees only PATH and HOME, so a private CA for verify-full reaches libpq only through this standard variable.
  const rootCert = parent.PGSSLROOTCERT?.trim();
  if (rootCert) {
    if (!path.isAbsolute(rootCert)) throw new RecoveryToolError("invalid_input", "PGSSLROOTCERT must be an absolute path.");
    env.PGSSLROOTCERT = rootCert;
  }
  const args = ["--host", u.hostname, "--port", port, ...(u.username ? ["--username", decodeURIComponent(u.username)] : []), "--dbname", database];
  return { args, env, label: `${u.hostname}:${port}/${database}` };
}

/** Where pg_dump / pg_restore / temporal are found: an absolute override first, then PATH. */
export interface Tools { pgDump: string; pgRestore: string; temporal: string }
export function toolsFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): Tools {
  const pick = (names: string[], fallback: string): string => {
    for (const n of names) {
      const v = env[n]?.trim();
      if (v) {
        if (!path.isAbsolute(v)) throw new RecoveryToolError("invalid_input", `${n} must be an absolute path.`);
        return v;
      }
    }
    return fallback;
  };
  return {
    pgDump: pick(["ZENITH_PG_DUMP_BIN", "ZENITH_TEST_PG_DUMP_BIN"], "pg_dump"),
    pgRestore: pick(["ZENITH_PG_RESTORE_BIN", "ZENITH_TEST_PG_RESTORE_BIN"], "pg_restore"),
    temporal: pick(["ZENITH_TEMPORAL_BIN", "ZENITH_TEST_TEMPORAL_BIN"], "temporal"),
  };
}

/** Run a tool and require success; stderr is trimmed to a short, URL-free tail. */
/** Temporal CLI client TLS: the same mTLS files and server name the worker uses (ZENITH_TEMPORAL_TLS_*). */
export interface TemporalCliTls { caFile?: string; certFile?: string; keyFile?: string; serverName?: string }
export function temporalTlsFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): TemporalCliTls | undefined {
  const value = (name: string) => env[name]?.trim() || undefined;
  const caFile = value("ZENITH_TEMPORAL_TLS_CA_FILE"), certFile = value("ZENITH_TEMPORAL_TLS_CERT_FILE"), keyFile = value("ZENITH_TEMPORAL_TLS_KEY_FILE");
  if (value("ZENITH_TEMPORAL_TLS") !== "true" && !caFile && !certFile && !keyFile) return undefined;
  for (const [name, file] of [["ZENITH_TEMPORAL_TLS_CA_FILE", caFile], ["ZENITH_TEMPORAL_TLS_CERT_FILE", certFile], ["ZENITH_TEMPORAL_TLS_KEY_FILE", keyFile]] as const)
    if (file && !path.isAbsolute(file)) throw new RecoveryToolError("invalid_input", `${name} must be an absolute path.`);
  if (!certFile !== !keyFile) throw new RecoveryToolError("invalid_input", "ZENITH_TEMPORAL_TLS_CERT_FILE and ZENITH_TEMPORAL_TLS_KEY_FILE must be set together.");
  const serverName = value("ZENITH_TEMPORAL_TLS_SERVER_NAME");
  return { ...(caFile ? { caFile } : {}), ...(certFile ? { certFile, keyFile } : {}), ...(serverName ? { serverName } : {}) };
}
/** Address and TLS arguments for every Temporal CLI call; an authenticated (mTLS) engine is reachable only with them. */
export function temporalConnectionArgs(address?: string, tls?: TemporalCliTls): string[] {
  return [...(address ? ["--address", address] : []), ...(tls ? ["--tls",
    ...(tls.caFile ? ["--tls-ca-path", tls.caFile] : []), ...(tls.certFile ? ["--tls-cert-path", tls.certFile] : []),
    ...(tls.keyFile ? ["--tls-key-path", tls.keyFile] : []), ...(tls.serverName ? ["--tls-server-name", tls.serverName] : [])] : [])];
}

export async function mustRun(run: CommandRunner, label: string, file: string, args: readonly string[], options?: RunOptions): Promise<RunResult> {
  const result = await run(file, args, options);
  if (result.code === 127 && result.stderr === "") throw new RecoveryToolError("tool_unavailable", `${label} is not available (${path.basename(file)} was not found).`);
  if (result.code !== 0) throw new RecoveryToolError("tool_failed", `${label} failed (exit ${result.code}): ${scrub(result.stderr).slice(-400)}`);
  return result;
}

/** Remove anything that looks like a connection string or password from tool output. */
export function scrub(text: string): string {
  return text.replace(/postgres(?:ql)?:\/\/[^\s'"]+/gi, "postgres://[redacted]").replace(/password[^\n]*/gi, "password [redacted]").replace(/\s+/g, " ").trim();
}
