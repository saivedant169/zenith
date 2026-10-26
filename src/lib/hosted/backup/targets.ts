/**
 * Where a backup and the revocation ledger are written: a directory, or an
 * S3-compatible bucket.
 *
 * The `BackupTarget` contract has one operation that is not a plain object
 * store: `append`, the revocation ledger's only writer. A ledger line that
 * overwrites the line before it is worse than no ledger at all — the restore
 * would read a truncated history and re-admit people who were removed — so
 * both implementations make appending *safe against a concurrent writer*, in
 * the way their storage allows:
 *
 *  - `FilesystemTarget` opens the file with the `a` flag. A single `write` of
 *    one line under `O_APPEND` is atomic against other appenders on every
 *    filesystem this runs on, so two processes interleave lines rather than
 *    losing one.
 *  - `S3Target` has no append at all — objects are whole — so it does
 *    read-modify-write guarded by the object's ETag: `If-Match` on an existing
 *    object, `If-None-Match: *` on the first line. A racing writer's ETag no
 *    longer matches and that attempt is retried against the new content
 *    instead of silently replacing it. **This depends on the endpoint
 *    honouring conditional writes.** AWS S3 does; an S3-compatible endpoint
 *    may not, and `scripts/hosted/backup-live-check.ts` is the opt-in probe
 *    that says whether the configured one does. When the endpoint ignores the
 *    precondition, a concurrent append can be lost, and that is stated here
 *    rather than assumed away.
 *
 * `none` is not a target. `selectedBackupTarget()` answers with `target: null`
 * and an availability that names `ZENITH_BACKUP_TARGET`, so a caller reports a
 * missing backup rather than pretending one happened.
 */
import fs from "node:fs";
import path from "node:path";
import { HostedError, type Availability, type BackupTarget } from "@/lib/hosted/contracts";
import { hostedConfig } from "@/lib/hosted/config";

/** Keys are POSIX-ish: segments of safe characters, no traversal, no absolutes. */
const KEY_RE = /^(?!\/)(?!.*\/\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$/;

function assertKey(key: string): string {
  if (!KEY_RE.test(key))
    throw new HostedError("invalid_input", `"${key}" is not a usable backup target key.`, {
      fix: "Use a relative key of letters, digits, dot, dash, underscore and slash — for example backups/<id>.zbk or ledger/revocations.jsonl.",
    });
  return key;
}

/* ------------------------------- filesystem ------------------------------- */

/**
 * A directory on a filesystem.
 *
 * Honest about what it is: a directory on the *same host* protects against a
 * deleted database and a bad migration, and against nothing that takes the
 * host with it. `availability()` says so, so a screen can repeat it.
 */
export class FilesystemTarget implements BackupTarget {
  readonly id = "filesystem" as const;
  readonly label: string;
  readonly dir: string;

  constructor(dir: string) {
    this.dir = path.resolve(dir);
    this.label = `Filesystem directory ${this.dir}`;
  }

  private resolve(key: string): string {
    return path.join(this.dir, ...assertKey(key).split("/"));
  }

  async availability(): Promise<Availability> {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.accessSync(this.dir, fs.constants.W_OK);
      return {
        available: true,
        reason: `${this.dir} is writable. A directory on this host is not off-host storage: it does not survive losing the machine.`,
      };
    } catch (error) {
      return {
        available: false,
        reason: `${this.dir} cannot be written to: ${error instanceof Error ? error.message : String(error)}.`,
        fix: "Point ZENITH_BACKUP_DIR at a directory this process can create and write, then try again.",
      };
    }
  }

  async put(key: string, bytes: Buffer): Promise<void> {
    const file = this.resolve(key);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Written beside the target and renamed, so a reader never sees a partial
    // backup and a crash mid-write leaves the previous object intact.
    const staging = `${file}.partial-${process.pid}-${Date.now()}`;
    fs.writeFileSync(staging, bytes);
    fs.renameSync(staging, file);
  }

  async get(key: string): Promise<Buffer | null> {
    const file = this.resolve(key);
    try {
      return fs.readFileSync(file);
    } catch {
      return null;
    }
  }

  async list(prefix: string): Promise<string[]> {
    const out: string[] = [];
    const walk = (absolute: string, relative: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(absolute, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const key = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(path.join(absolute, entry.name), key);
        else if (entry.isFile() && key.startsWith(prefix) && !key.includes(".partial-")) out.push(key);
      }
    };
    walk(this.dir, "");
    return out.sort();
  }

  async append(key: string, line: string): Promise<void> {
    const file = this.resolve(key);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const handle = fs.openSync(file, "a");
    try {
      fs.writeSync(handle, `${line.replace(/\r?\n/g, " ")}\n`);
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
  }
}

/* ----------------------------------- s3 ----------------------------------- */

/** The slice of `@aws-sdk/client-s3` this target uses. A test injects a double. */
export interface S3Like {
  send(command: unknown): Promise<unknown>;
}

/** How an {@link S3Target} is built. */
export interface S3TargetOptions {
  bucket: string;
  /** LocalStack or another S3-compatible endpoint. Omitted for AWS itself. */
  endpoint?: string;
  region?: string;
  /** An already-built client. Tests inject a double; production leaves it out. */
  client?: S3Like;
  /** How many times an append retries after a losing conditional write. */
  appendAttempts?: number;
}

interface S3GetResult {
  Body?: { transformToByteArray?: () => Promise<Uint8Array> };
  ETag?: string;
}

interface S3ListResult {
  Contents?: { Key?: string }[];
  NextContinuationToken?: string;
  IsTruncated?: boolean;
}

/**
 * An S3-compatible bucket.
 *
 * The AWS SDK is imported lazily so that a filesystem-only install never loads
 * it, and so a test can inject a client double without the SDK being involved
 * at all.
 */
export class S3Target implements BackupTarget {
  readonly id = "s3" as const;
  readonly label: string;
  readonly bucket: string;
  readonly endpoint?: string;
  readonly region: string;

  private readonly injected?: S3Like;
  private readonly appendAttempts: number;
  private client?: S3Like;
  private commands?: typeof import("@aws-sdk/client-s3");

  constructor(options: S3TargetOptions) {
    this.bucket = options.bucket;
    this.endpoint = options.endpoint;
    this.region = options.region ?? "us-east-1";
    this.injected = options.client;
    this.appendAttempts = Math.max(1, options.appendAttempts ?? 5);
    this.label = `S3 bucket ${this.bucket}${this.endpoint ? ` at ${this.endpoint}` : ""}`;
  }

  private async sdk(): Promise<typeof import("@aws-sdk/client-s3")> {
    this.commands ??= await import("@aws-sdk/client-s3");
    return this.commands;
  }

  private async connection(): Promise<S3Like> {
    if (this.injected) return this.injected;
    if (this.client) return this.client;
    const { S3Client } = await this.sdk();
    // Path style, because `<bucket>.localhost` is not resolvable and every
    // S3-compatible endpoint accepts the path form.
    this.client = new S3Client({
      region: this.region,
      ...(this.endpoint ? { endpoint: this.endpoint, forcePathStyle: true } : {}),
      maxAttempts: 3,
      requestHandler: { connectionTimeout: 3_000, requestTimeout: 30_000 },
    }) as unknown as S3Like;
    return this.client;
  }

  async availability(): Promise<Availability> {
    if (!this.bucket)
      return {
        available: false,
        reason: "No bucket is configured for the S3 backup target.",
        fix: "Set ZENITH_BACKUP_S3_BUCKET to the bucket backups are written to.",
      };
    try {
      const { HeadBucketCommand } = await this.sdk();
      const client = await this.connection();
      await client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return { available: true, reason: `${this.label} answered a HEAD on the bucket.` };
    } catch (error) {
      return {
        available: false,
        reason: `${this.label} did not answer: ${error instanceof Error ? error.message : String(error)}.`,
        fix: "Check ZENITH_BACKUP_S3_BUCKET, ZENITH_BACKUP_S3_ENDPOINT and the AWS credentials in this process's environment. For LocalStack, run `npm run localstack:up` first.",
      };
    }
  }

  async put(key: string, bytes: Buffer): Promise<void> {
    const { PutObjectCommand } = await this.sdk();
    const client = await this.connection();
    await client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: assertKey(key), Body: bytes })
    );
  }

  async get(key: string): Promise<Buffer | null> {
    const found = await this.getWithEtag(key);
    return found?.bytes ?? null;
  }

  private async getWithEtag(key: string): Promise<{ bytes: Buffer; etag?: string } | null> {
    const { GetObjectCommand } = await this.sdk();
    const client = await this.connection();
    try {
      const result = (await client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: assertKey(key) })
      )) as S3GetResult;
      const body = result.Body;
      if (!body?.transformToByteArray) return { bytes: Buffer.alloc(0), etag: result.ETag };
      return { bytes: Buffer.from(await body.transformToByteArray()), etag: result.ETag };
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async list(prefix: string): Promise<string[]> {
    const { ListObjectsV2Command } = await this.sdk();
    const client = await this.connection();
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const page = (await client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token })
      )) as S3ListResult;
      for (const item of page.Contents ?? []) if (item.Key) keys.push(item.Key);
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return keys.sort();
  }

  /**
   * Append one line, guarded by the object's ETag.
   *
   * Read, concatenate, conditionally write. A racing appender invalidates the
   * ETag, the conditional write is refused, and this retries against the new
   * content — so the losing line is delayed, not dropped. Endpoints that
   * ignore `If-Match` silently make this a last-writer-wins overwrite; the
   * live check script is what tells you which one you have.
   */
  async append(key: string, line: string): Promise<void> {
    const { PutObjectCommand } = await this.sdk();
    const client = await this.connection();
    const safe = `${line.replace(/\r?\n/g, " ")}\n`;
    let lastError: unknown;
    for (let attempt = 0; attempt < this.appendAttempts; attempt++) {
      const existing = await this.getWithEtag(key);
      const body = existing ? Buffer.concat([existing.bytes, Buffer.from(safe, "utf8")]) : Buffer.from(safe, "utf8");
      const guard = existing?.etag ? { IfMatch: existing.etag } : { IfNoneMatch: "*" };
      try {
        await client.send(
          new PutObjectCommand({ Bucket: this.bucket, Key: assertKey(key), Body: body, ...guard })
        );
        return;
      } catch (error) {
        if (!isPreconditionFailed(error)) throw error;
        lastError = error;
      }
    }
    throw new HostedError(
      "conflict",
      `The revocation ledger line could not be appended to ${this.label} after ${this.appendAttempts} attempts: another writer changed ${key} each time.`,
      {
        fix: "Retry the outbox entry. If this repeats, two control processes are writing the same ledger — run one.",
        details: { key, detail: lastError instanceof Error ? lastError.message : String(lastError) },
      }
    );
  }
}

interface AwsErrorShape {
  name?: string;
  Code?: string;
  $metadata?: { httpStatusCode?: number };
}

const awsError = (error: unknown): AwsErrorShape => (error ?? {}) as AwsErrorShape;

const isMissing = (error: unknown): boolean => {
  const e = awsError(error);
  return e.name === "NoSuchKey" || e.name === "NotFound" || e.Code === "NoSuchKey" || e.$metadata?.httpStatusCode === 404;
};

const isPreconditionFailed = (error: unknown): boolean => {
  const e = awsError(error);
  return (
    e.name === "PreconditionFailed" ||
    e.Code === "PreconditionFailed" ||
    e.$metadata?.httpStatusCode === 412 ||
    e.$metadata?.httpStatusCode === 409
  );
};

/* -------------------------------- selection ------------------------------- */

/** The configured target, or `null` with the reason it is not there. */
export interface BackupTargetSelection {
  /** What `ZENITH_BACKUP_TARGET` names. */
  id: "none" | "filesystem" | "s3";
  target: BackupTarget | null;
  /** Never available when `target` is null; carries the fix. */
  availability: Availability;
}

/**
 * Build the target this install is configured for.
 *
 * `availability()` is *not* called here — it does I/O and a network round trip
 * for S3 — so the returned availability describes configuration only. Callers
 * that are about to write should `await selection.target.availability()`.
 */
export function selectedBackupTarget(): BackupTargetSelection {
  const cfg = hostedConfig();
  if (cfg.ZENITH_BACKUP_TARGET === "filesystem")
    return {
      id: "filesystem",
      target: new FilesystemTarget(cfg.backupDir),
      availability: {
        available: true,
        reason: `Backups are written to ${cfg.backupDir}. That is a directory on this host, not off-host storage.`,
      },
    };

  if (cfg.ZENITH_BACKUP_TARGET === "s3") {
    const bucket = cfg.ZENITH_BACKUP_S3_BUCKET;
    if (!bucket)
      return {
        id: "s3",
        target: null,
        availability: {
          available: false,
          reason: "ZENITH_BACKUP_TARGET is s3 but no bucket is named.",
          fix: "Set ZENITH_BACKUP_S3_BUCKET (and ZENITH_BACKUP_S3_ENDPOINT for LocalStack or another S3-compatible endpoint).",
        },
      };
    const endpoint = cfg.ZENITH_BACKUP_S3_ENDPOINT;
    const region = backupS3Region({
      ZENITH_BACKUP_S3_REGION: cfg.ZENITH_BACKUP_S3_REGION,
      AWS_REGION: process.env.AWS_REGION,
      AWS_DEFAULT_REGION: process.env.AWS_DEFAULT_REGION,
    });
    // Without a region the SDK would talk to us-east-1, which fails for a bucket elsewhere (e.g. ap-south-1).
    if (!region && !endpoint)
      return {
        id: "s3",
        target: null,
        availability: {
          available: false,
          reason: "ZENITH_BACKUP_TARGET=s3 needs ZENITH_BACKUP_S3_REGION (or AWS_REGION).",
          fix: "Set ZENITH_BACKUP_S3_REGION to the bucket's region, for example ap-south-1. A custom endpoint (ZENITH_BACKUP_S3_ENDPOINT) needs no region.",
        },
      };
    return {
      id: "s3",
      target: new S3Target({ bucket, endpoint, region }),
      availability: { available: true, reason: `Backups are written to the S3 bucket ${bucket}.` },
    };
  }

  return {
    id: "none",
    target: null,
    availability: {
      available: false,
      reason: "No backup target is configured, so nothing is backed up and no revocation ledger is written off-host.",
      fix: "Set ZENITH_BACKUP_TARGET=filesystem with ZENITH_BACKUP_DIR, or ZENITH_BACKUP_TARGET=s3 with ZENITH_BACKUP_S3_BUCKET. A hosted install with `none` cannot satisfy off-host recovery (G22) or revocation reconciliation (G23).",
    },
  };
}

/**
 * The backup bucket's region, from configuration: ZENITH_BACKUP_S3_REGION, then AWS_REGION, then AWS_DEFAULT_REGION
 * (the same order as archiveTargetFromEnv in src/lib/retention/archive.ts). Undefined when none is set.
 */
export function backupS3Region(env: Readonly<Record<string, string | undefined>>): string | undefined {
  return [env.ZENITH_BACKUP_S3_REGION, env.AWS_REGION, env.AWS_DEFAULT_REGION].map((v) => v?.trim()).find(Boolean);
}

/** The configured target, or a refusal naming the variable that would provide one. */
export function requireBackupTarget(): BackupTarget {
  const selection = selectedBackupTarget();
  if (selection.target) return selection.target;
  throw new HostedError("policy_unavailable", selection.availability.reason ?? "No backup target is configured.", {
    fix: selection.availability.fix,
    details: { target: selection.id },
  });
}

/** The key a backup bundle is stored under. */
export const backupKeyFor = (id: string): string => `backups/${id}.zbk`;

/** The key the off-host revocation ledger is appended to. */
export const REVOCATION_LEDGER_KEY = "ledger/revocations.jsonl";
