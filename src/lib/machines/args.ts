/**
 * Strict per-operation argument schemas (spec §18, ADR-0012).
 *
 * Every schema is `.strict()`: an unknown key is an error, never ignored, so a
 * typo cannot silently widen or drop a limit. Every string that will reach a
 * machine is constrained to an alphabet in which it is inert: unit names,
 * container references and paths cannot contain whitespace, quotes, `$`,
 * backticks, `;`, `|`, `&`, `..`, NUL or newlines. The exception is
 * `argv[1..]` of the exec escape hatch, which is arbitrary data by design and
 * is passed as an argv vector, never joined into a shell string by anything
 * except the SSM transport's single-quote escaper.
 *
 * Parsing normalizes: defaults are filled in and paths are canonicalized, and
 * the parsed value (not the caller's raw object) is what transports receive
 * and what the evidence log summarizes.
 *
 * `MachineOperation`s without a schema here without a schema remain vocabulary-only; `IMPLEMENTED_OPERATIONS` is the authoritative list.
 */
import { z } from "zod";
import { MACHINE_OPERATIONS, type MachineOperation } from "./types";
import {
  DEFAULT_FILE_READ_BYTES,
  DEFAULT_LOG_LINES,
  MAX_ARGV_ITEMS,
  MAX_ARGV_ITEM_CHARS,
  MAX_ARGV_TOTAL_CHARS,
  MAX_CONTAINER_LIMIT,
  MAX_LOG_LINES,
  MAX_OUTPUT_BYTES,
  MAX_PORT_CHECK_TIMEOUT_SEC,
  MAX_PROCESS_LIMIT,
  MAX_TIMEOUT_SEC,
} from "./limits";
import { checkNetworkHost, isCanonicalWritePath, isDeniedWritePath, isProtectedUnit, normalizeAbsolutePath, parseSince } from "./guards";

/* ------------------------------- primitives ------------------------------- */

/** systemd unit names Zenith will touch; the regex is the contract shared with zenithd and the SSM documents. */
export const UNIT_NAME_RE = /^[A-Za-z0-9@._:-]{1,128}\.(service|socket|timer)$/;
/** Docker container id (hex, ≤64) or name: `[a-zA-Z0-9][a-zA-Z0-9_.-]*`. Also a superset of a Kubernetes container name. */
export const CONTAINER_REF_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
/** the executable of an argv vector: a bare name or a path, no spaces or metacharacters */
const EXECUTABLE_RE = /^[A-Za-z0-9._@:+=,/-]{1,256}$/;
export const OPERATION_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
/** LABEL_SELECTOR is passed as a query parameter (never a shell); the charset is the label-selector grammar. */
const LABEL_SELECTOR_RE = /^[A-Za-z0-9_.\/=!,() -]{1,256}$/;

export const unitSchema = z
  .string()
  .regex(UNIT_NAME_RE, "must be a systemd unit name ending in .service, .socket or .timer")
  .refine((u) => !u.startsWith("-"), "unit names may not start with '-'");

const containerRefSchema = z.string().regex(CONTAINER_REF_RE, "must be a container id or name ([A-Za-z0-9][A-Za-z0-9_.-]*, ≤128)");

export const pathSchema = z
  .string()
  .max(1024)
  .transform((s, ctx) => {
    const r = normalizeAbsolutePath(s);
    if (!r.ok) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: r.reason });
      return z.NEVER;
    }
    return r.path;
  });

const filePathSchema = pathSchema.refine((p) => p !== "/", "must name a file, not the root");

const hostSchema = (allowUnderscore: boolean) =>
  z
    .string()
    .max(253)
    .transform((s, ctx) => {
      const r = checkNetworkHost(s, { allowUnderscore });
      if (!r.ok) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: r.reason });
        return z.NEVER;
      }
      return r.host;
    });

/** relative duration `15m`, `2h`, `1d`, `900s`; at most 7 days; the wire form stays a string */
const sinceSchema = z
  .string()
  .max(8)
  .refine((s) => parseSince(s) !== null, "must be a relative duration like 900s, 15m, 2h or 1d, at most 7d");

const linesSchema = (fallback: number) => z.number().int().min(1).max(MAX_LOG_LINES).prefault(fallback);

/**
 * argv vector: 1..32 items, each ≤4096 characters, no NUL; the executable is
 * `[A-Za-z0-9._@:+=,/-]` only; total ≤32 KiB. Never a shell string.
 */
export const argvSchema = z
  .array(z.string().max(MAX_ARGV_ITEM_CHARS, `each argv item is at most ${MAX_ARGV_ITEM_CHARS} characters`))
  .min(1, "argv needs at least the executable")
  .max(MAX_ARGV_ITEMS, `argv has at most ${MAX_ARGV_ITEMS} items`)
  .superRefine((argv, ctx) => {
    if (!EXECUTABLE_RE.test(argv[0] ?? "")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [0], message: "the executable must match [A-Za-z0-9._@:+=,/-]{1,256}" });
    }
    argv.forEach((a, i) => {
      if (a.includes("\0")) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i], message: "argv items may not contain NUL" });
    });
    if (argv.reduce((n, a) => n + a.length, 0) > MAX_ARGV_TOTAL_CHARS) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `argv totals more than ${MAX_ARGV_TOTAL_CHARS} characters` });
    }
  });

const execTimeoutSchema = z.number().int().min(1).max(MAX_TIMEOUT_SEC);

/* --------------------------- per-operation schemas --------------------------- */

const none = z.object({}).strict();

export const MachineArgsSchemas = {
  "machine.inspect": none,
  "process.list": z
    .object({
      limit: z.number().int().min(1).max(MAX_PROCESS_LIMIT).prefault(50),
      sortBy: z.enum(["cpu", "memory"]).prefault("cpu"),
    })
    .strict(),
  "service.status": z.object({ unit: unitSchema }).strict(),
  "machine.service.restart": z
    .object({ unit: unitSchema.refine((u) => !isProtectedUnit(u), "this unit is protected and cannot be restarted through Zenith") })
    .strict(),
  "container.list": z
    .object({
      all: z.boolean().prefault(false),
      limit: z.number().int().min(1).max(MAX_CONTAINER_LIMIT).prefault(100),
      /** Kubernetes only; refused by the Docker-based transports */
      labelSelector: z.string().regex(LABEL_SELECTOR_RE, "not a valid label selector").optional(),
    })
    .strict(),
  "container.inspect": z.object({ container: containerRefSchema.optional() }).strict(),
  "container.logs": z
    .object({
      container: containerRefSchema.optional(),
      since: sinceSchema.optional(),
      lines: linesSchema(DEFAULT_LOG_LINES),
      timestamps: z.boolean().prefault(false),
    })
    .strict(),
  "container.exec": z
    .object({
      container: containerRefSchema.optional(),
      argv: argvSchema,
      timeoutSec: execTimeoutSchema,
    })
    .strict(),
  "file.read": z
    .object({
      path: filePathSchema,
      maxBytes: z.number().int().min(1).max(MAX_OUTPUT_BYTES).prefault(DEFAULT_FILE_READ_BYTES),
    })
    .strict(),
  "file.write": z.object({
    path: z.string().max(1024).refine((p) => isCanonicalWritePath(p) && !isDeniedWritePath(p), "requires an exact canonical customer application path"),
    contentRef: z.string().max(64).regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/).refine((s) => !/\s/.test(s)),
    contentVersion: z.string().length(64).regex(/^[0-9a-f]{64}$/),
    expectedSha256: z.string().length(64).regex(/^[0-9a-f]{64}$/).nullable(),
  }).strict(),
  "file.upload": z.object({
    path: z.string().max(1024).refine((p) => isCanonicalWritePath(p) && !isDeniedWritePath(p), "requires an exact canonical customer application path"),
    sourceRef: z.string().max(64).regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/).refine((s) => !/\s/.test(s)),
    sourceVersion: z.string().length(64).regex(/^[0-9a-f]{64}$/),
    expectedSha256: z.string().length(64).regex(/^[0-9a-f]{64}$/).nullable(),
  }).strict(),
  "package.install": z.object({
    profileRef: z.string().max(64).regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
    profileVersion: z.string().length(64).regex(/^[0-9a-f]{64}$/),
    expectedInstalledVersion: z.string().max(128).regex(/^(?:[0-9]+:)?[0-9][A-Za-z0-9.+~-]{0,127}$/).nullable(),
  }).strict(),
  "service.configure": z.object({
    unit: unitSchema.refine((u) => u.endsWith(".service") && !isProtectedUnit(u), "must be an unprotected .service unit"),
    profileRef: z.string().max(64).regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
    profileVersion: z.string().length(64).regex(/^[0-9a-f]{64}$/),
    expectedSha256: z.string().length(64).regex(/^[0-9a-f]{64}$/).nullable(),
  }).strict(),
  "network.portCheck": z
    .object({
      host: hostSchema(false),
      port: z.number().int().min(1).max(65535),
      timeoutSec: z.number().int().min(1).max(MAX_PORT_CHECK_TIMEOUT_SEC).prefault(5),
    })
    .strict(),
  "network.dnsCheck": z
    .object({
      name: hostSchema(true),
      recordType: z.enum(["A", "AAAA", "CNAME", "MX", "NS", "SRV", "TXT"]).prefault("A"),
    })
    .strict(),
  "system.metrics": none,
  "system.logs": z
    .object({
      unit: unitSchema.optional(),
      since: sinceSchema.prefault("1h"),
      lines: linesSchema(DEFAULT_LOG_LINES),
    })
    .strict(),
  "machine.exec": z
    .object({
      argv: argvSchema,
      cwd: pathSchema.optional(),
      timeoutSec: execTimeoutSchema,
    })
    .strict(),
} as const;

export type ImplementedOperation = keyof typeof MachineArgsSchemas;
export const IMPLEMENTED_OPERATIONS = Object.keys(MachineArgsSchemas) as ImplementedOperation[];
export const isImplementedOperation = (op: MachineOperation): op is ImplementedOperation =>
  Object.prototype.hasOwnProperty.call(MachineArgsSchemas, op);

/** Parsed (defaults filled, paths canonical) arguments of one operation. */
export type MachineArgs<Op extends ImplementedOperation> = z.output<(typeof MachineArgsSchemas)[Op]>;

/** operations declared in the vocabulary that no schema, and therefore no transport, implements */
export const UNIMPLEMENTED_OPERATIONS: readonly MachineOperation[] = MACHINE_OPERATIONS.filter((o) => !isImplementedOperation(o));

/* -------------------------------- envelope -------------------------------- */

export const MachineTargetSchema = z
  .object({
    workspaceId: z.string().min(1).max(128),
    environmentId: z.string().min(1).max(128).optional(),
    resourceId: z.string().min(1).max(128).optional(),
    address: z.string().min(1).max(512).optional(),
    transport: z.enum(["aws_ssm", "kubernetes", "azure_run_command", "gcp_os_management", "zenithd"]),
    targetId: z.string().min(1).max(512),
  })
  .strict();

export const MachineRequestSchema = z
  .object({
    operationId: z.string().regex(OPERATION_ID_RE, "must match [A-Za-z0-9_.:-]{1,128}"),
    target: MachineTargetSchema,
    operation: z.enum(MACHINE_OPERATIONS),
    args: z.record(z.string(), z.unknown()),
    timeoutSec: z.number().int().min(1).max(MAX_TIMEOUT_SEC),
    maxOutputBytes: z.number().int().min(1).max(MAX_OUTPUT_BYTES),
  })
  .strict();

/* --------------------------------- parsing --------------------------------- */

/** One line per problem, `path: rule`, with no attacker-controlled value echoed back. */
export function describeIssues(error: z.ZodError): string[] {
  return error.issues.slice(0, 8).map((i) => {
    const where = i.path.length ? i.path.join(".") : "(args)";
    const what =
      i.code === "invalid_value"
        ? "is not one of the allowed values"
        : i.code === "unrecognized_keys"
          ? `has unrecognized keys (${i.keys.length})`
          : i.code === "invalid_type"
            ? `expected ${i.expected}`
            : i.message;
    return `${where}: ${what}`.slice(0, 200);
  });
}

export type ParsedArgs<Op extends ImplementedOperation> =
  | { ok: true; args: MachineArgs<Op> }
  | { ok: false; issues: string[] };

export function parseMachineArgs<Op extends ImplementedOperation>(op: Op, args: unknown): ParsedArgs<Op> {
  const parsed = (MachineArgsSchemas[op] as z.ZodTypeAny).safeParse(args);
  return parsed.success ? { ok: true, args: parsed.data as MachineArgs<Op> } : { ok: false, issues: describeIssues(parsed.error) };
}
