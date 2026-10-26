/**
 * Backup targets: a directory, and an S3 bucket driven through an injected
 * client double.
 *
 * The double is not a stand-in for a live endpoint and this file does not
 * pretend otherwise — it pins the *command shapes* and the ETag guard, which
 * is what the code here is responsible for. Whether a particular endpoint
 * honours `If-Match` is a question about that endpoint, and the only thing
 * that answers it is `scripts/hosted/backup-live-check.ts` against a running
 * one. There is deliberately no auto-skipping LocalStack test: a suite that
 * goes green when nothing ran is worse than no suite.
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isolatedDataDir, removeDir } from "../_fixtures";

const dataDir = isolatedDataDir("zenith-backup-targets-");

const { FilesystemTarget, S3Target, backupS3Region, requireBackupTarget, selectedBackupTarget } = await import(
  "@/lib/hosted/backup"
);

afterAll(() => removeDir(dataDir));

/* ------------------------------- filesystem ------------------------------- */

describe("FilesystemTarget", () => {
  const dir = path.join(dataDir, "fs-target");
  const target = new FilesystemTarget(dir);

  it("writes, reads back and lists by prefix", async () => {
    await target.put("backups/one.zbk", Buffer.from("first"));
    await target.put("backups/two.zbk", Buffer.from("second"));
    await target.put("ledger/revocations.jsonl", Buffer.from(""));

    expect((await target.get("backups/one.zbk"))?.toString()).toBe("first");
    expect(await target.get("backups/missing.zbk")).toBeNull();
    expect(await target.list("backups/")).toEqual(["backups/one.zbk", "backups/two.zbk"]);
  });

  it("appends without overwriting, one line per call", async () => {
    await target.append("ledger/lines.jsonl", JSON.stringify({ seq: 1 }));
    await target.append("ledger/lines.jsonl", JSON.stringify({ seq: 2 }));
    expect((await target.get("ledger/lines.jsonl"))?.toString()).toBe('{"seq":1}\n{"seq":2}\n');
  });

  it("keeps a line on one line, whatever the caller passed", async () => {
    await target.append("ledger/oneline.jsonl", 'a\nb\r\nc');
    expect((await target.get("ledger/oneline.jsonl"))?.toString()).toBe("a b c\n");
  });

  it("refuses a key that could escape the directory", async () => {
    for (const key of ["../escape", "/etc/passwd", "backups/../../out", "", "a//b"])
      await expect(target.put(key, Buffer.from("x"))).rejects.toThrow(/not a usable backup target key/);
    expect(fs.existsSync(path.join(path.dirname(dir), "escape"))).toBe(false);
  });

  it("is available when the directory is writable, and says a local directory is not off-host", async () => {
    const availability = await target.availability();
    expect(availability.available).toBe(true);
    expect(availability.reason).toMatch(/not off-host storage/);
  });

  it("never leaves a partial object where a reader could find it", async () => {
    await target.put("backups/big.zbk", Buffer.alloc(1_000_000, 7));
    expect((await target.list("backups/")).some((key) => key.includes(".partial-"))).toBe(false);
    expect((await target.get("backups/big.zbk"))?.length).toBe(1_000_000);
  });
});

/* ----------------------------------- s3 ----------------------------------- */

interface StoredObject {
  body: Buffer;
  etag: string;
}

/** An in-memory bucket that behaves the way a conditional-write S3 does. */
function bucketDouble() {
  const objects = new Map<string, StoredObject>();
  const commands: { name: string; input: Record<string, unknown> }[] = [];
  let version = 0;
  /** Set to mutate an object between a read and the write that follows it. */
  let raceOnce: string | null = null;

  const fail = (name: string, status: number): never => {
    const error = Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });
    throw error;
  };

  const client = {
    async send(command: unknown): Promise<unknown> {
      const anyCommand = command as { constructor: { name: string }; input: Record<string, unknown> };
      const name = anyCommand.constructor.name;
      const input = anyCommand.input;
      commands.push({ name, input });
      const key = String(input.Key ?? "");

      if (name === "HeadBucketCommand") return {};
      if (name === "GetObjectCommand") {
        const found = objects.get(key);
        if (!found) fail("NoSuchKey", 404);
        return {
          ETag: found!.etag,
          Body: { transformToByteArray: async () => new Uint8Array(found!.body) },
        };
      }
      if (name === "ListObjectsV2Command") {
        const prefix = String(input.Prefix ?? "");
        return {
          Contents: [...objects.keys()].filter((k) => k.startsWith(prefix)).map((Key) => ({ Key })),
          IsTruncated: false,
        };
      }
      if (name === "PutObjectCommand") {
        if (raceOnce === key) {
          // Another writer got there first, between this caller's read and
          // this write.
          raceOnce = null;
          objects.set(key, { body: Buffer.from("racer\n"), etag: `"v${++version}"` });
        }
        const existing = objects.get(key);
        if (input.IfNoneMatch === "*" && existing) fail("PreconditionFailed", 412);
        if (typeof input.IfMatch === "string" && existing?.etag !== input.IfMatch) fail("PreconditionFailed", 412);
        objects.set(key, { body: Buffer.from(input.Body as Buffer), etag: `"v${++version}"` });
        return { ETag: `"v${version}"` };
      }
      throw new Error(`the bucket double does not implement ${name}`);
    },
  };

  return {
    client,
    commands,
    objects,
    race(key: string) {
      raceOnce = key;
    },
  };
}

describe("S3Target", () => {
  it("puts, gets and lists through the SDK's commands", async () => {
    const bucket = bucketDouble();
    const target = new S3Target({ bucket: "zenith-backups", endpoint: "http://localhost:4566", client: bucket.client });

    await target.put("backups/one.zbk", Buffer.from("payload"));
    expect((await target.get("backups/one.zbk"))?.toString()).toBe("payload");
    expect(await target.get("backups/absent.zbk")).toBeNull();
    expect(await target.list("backups/")).toEqual(["backups/one.zbk"]);

    const put = bucket.commands.find((command) => command.name === "PutObjectCommand");
    expect(put?.input).toMatchObject({ Bucket: "zenith-backups", Key: "backups/one.zbk" });
    expect(await target.availability()).toMatchObject({ available: true });
  });

  it("creates the ledger with If-None-Match and extends it with If-Match", async () => {
    const bucket = bucketDouble();
    const target = new S3Target({ bucket: "b", client: bucket.client });

    await target.append("ledger/revocations.jsonl", '{"seq":1}');
    await target.append("ledger/revocations.jsonl", '{"seq":2}');

    expect(bucket.objects.get("ledger/revocations.jsonl")?.body.toString()).toBe('{"seq":1}\n{"seq":2}\n');
    const puts = bucket.commands.filter((command) => command.name === "PutObjectCommand");
    expect(puts[0].input.IfNoneMatch).toBe("*");
    expect(puts[0].input.IfMatch).toBeUndefined();
    expect(typeof puts[1].input.IfMatch).toBe("string");
  });

  it("retries against the new content when a racing writer invalidates the ETag", async () => {
    const bucket = bucketDouble();
    const target = new S3Target({ bucket: "b", client: bucket.client });

    await target.append("ledger/revocations.jsonl", '{"seq":1}');
    bucket.race("ledger/revocations.jsonl");
    await target.append("ledger/revocations.jsonl", '{"seq":2}');

    // The racer's line survived and ours was appended after it: the losing
    // append is delayed, never dropped.
    expect(bucket.objects.get("ledger/revocations.jsonl")?.body.toString()).toBe('racer\n{"seq":2}\n');
  });

  it("gives up loudly rather than overwriting when every attempt loses the race", async () => {
    const bucket = bucketDouble();
    const target = new S3Target({ bucket: "b", client: bucket.client, appendAttempts: 2 });
    await target.put("ledger/x.jsonl", Buffer.from("existing\n"));
    // A double whose ETag never matches what a caller read.
    const always = {
      async send(command: unknown) {
        const anyCommand = command as { constructor: { name: string }; input: Record<string, unknown> };
        if (anyCommand.constructor.name === "GetObjectCommand")
          return { ETag: '"stale"', Body: { transformToByteArray: async () => new Uint8Array() } };
        throw Object.assign(new Error("PreconditionFailed"), {
          name: "PreconditionFailed",
          $metadata: { httpStatusCode: 412 },
        });
      },
    };
    const stubborn = new S3Target({ bucket: "b", client: always, appendAttempts: 2 });
    await expect(stubborn.append("ledger/x.jsonl", "line")).rejects.toThrow(/another writer changed/);
  });

  it("reports unavailable, with a fix, when the bucket does not answer", async () => {
    const target = new S3Target({
      bucket: "b",
      endpoint: "http://localhost:4566",
      client: {
        async send() {
          throw new Error("connect ECONNREFUSED 127.0.0.1:4566");
        },
      },
    });
    const availability = await target.availability();
    expect(availability.available).toBe(false);
    expect(availability.reason).toMatch(/ECONNREFUSED/);
    expect(availability.fix).toMatch(/localstack:up/);
  });
});

/* -------------------------------- selection ------------------------------- */

describe("selectedBackupTarget", () => {
  it("answers with no target, and names the variable, when nothing is configured", async () => {
    const previous = process.env.ZENITH_BACKUP_TARGET;
    process.env.ZENITH_BACKUP_TARGET = "none";
    try {
      const selection = selectedBackupTarget();
      expect(selection.id).toBe("none");
      expect(selection.target).toBeNull();
      expect(selection.availability.available).toBe(false);
      expect(selection.availability.fix).toMatch(/ZENITH_BACKUP_TARGET/);
      expect(selection.availability.reason).toMatch(/no revocation ledger/);
      expect(() => requireBackupTarget()).toThrow(/No backup target is configured/);
    } finally {
      process.env.ZENITH_BACKUP_TARGET = previous;
    }
  });

  it("builds a filesystem target from ZENITH_BACKUP_DIR", async () => {
    const previous = { target: process.env.ZENITH_BACKUP_TARGET, dir: process.env.ZENITH_BACKUP_DIR };
    process.env.ZENITH_BACKUP_TARGET = "filesystem";
    process.env.ZENITH_BACKUP_DIR = path.join(dataDir, "configured");
    try {
      const selection = selectedBackupTarget();
      expect(selection.id).toBe("filesystem");
      expect(selection.target?.id).toBe("filesystem");
      expect(requireBackupTarget().label).toContain("configured");
    } finally {
      process.env.ZENITH_BACKUP_TARGET = previous.target;
      process.env.ZENITH_BACKUP_DIR = previous.dir;
    }
  });

  it("refuses an s3 target with no bucket, naming the variable that would give it one", async () => {
    const previous = { target: process.env.ZENITH_BACKUP_TARGET, bucket: process.env.ZENITH_BACKUP_S3_BUCKET };
    process.env.ZENITH_BACKUP_TARGET = "s3";
    delete process.env.ZENITH_BACKUP_S3_BUCKET;
    try {
      const selection = selectedBackupTarget();
      expect(selection.target).toBeNull();
      expect(selection.availability.fix).toMatch(/ZENITH_BACKUP_S3_BUCKET/);
    } finally {
      process.env.ZENITH_BACKUP_TARGET = previous.target;
      if (previous.bucket === undefined) delete process.env.ZENITH_BACKUP_S3_BUCKET;
      else process.env.ZENITH_BACKUP_S3_BUCKET = previous.bucket;
    }
  });
});

/* ------------------------------ S3 region ----------------------------------- */
// Mirrors the archive region tests in tests/retention/retention.test.ts: a bucket outside us-east-1 must
// be addressed with its own region, and S3 without any region is refused unless a custom endpoint is named.

describe("backup S3 region", () => {
  const KEYS = ["ZENITH_BACKUP_TARGET", "ZENITH_BACKUP_S3_BUCKET", "ZENITH_BACKUP_S3_REGION", "ZENITH_BACKUP_S3_ENDPOINT", "AWS_REGION", "AWS_DEFAULT_REGION"] as const;

  function withEnv<T>(vars: Partial<Record<(typeof KEYS)[number], string>>, run: () => T): T {
    const previous = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    for (const k of KEYS) delete process.env[k];
    Object.assign(process.env, { ZENITH_BACKUP_TARGET: "s3", ZENITH_BACKUP_S3_BUCKET: "b", ...vars });
    try {
      return run();
    } finally {
      for (const k of KEYS) {
        if (previous[k] === undefined) delete process.env[k];
        else process.env[k] = previous[k];
      }
    }
  }

  it("resolves the region from ZENITH_BACKUP_S3_REGION, then AWS_REGION, then AWS_DEFAULT_REGION", () => {
    expect(backupS3Region({ ZENITH_BACKUP_S3_REGION: "ap-south-1" })).toBe("ap-south-1");
    expect(backupS3Region({ ZENITH_BACKUP_S3_REGION: "ap-south-1", AWS_REGION: "eu-west-1" })).toBe("ap-south-1");
    expect(backupS3Region({ AWS_REGION: "eu-west-1", AWS_DEFAULT_REGION: "us-west-2" })).toBe("eu-west-1");
    expect(backupS3Region({ AWS_DEFAULT_REGION: "us-west-2" })).toBe("us-west-2");
    expect(backupS3Region({ ZENITH_BACKUP_S3_REGION: "  ", AWS_REGION: " " })).toBeUndefined();
    expect(backupS3Region({})).toBeUndefined();
  });

  it("hands the resolved region to the S3 target", () => {
    const fromBackupVar = withEnv({ ZENITH_BACKUP_S3_REGION: "ap-south-1", AWS_REGION: "eu-west-1" }, () => selectedBackupTarget());
    expect(fromBackupVar.availability.available).toBe(true);
    expect(fromBackupVar.target).toBeInstanceOf(S3Target);
    expect((fromBackupVar.target as InstanceType<typeof S3Target>).region).toBe("ap-south-1");

    const fromAws = withEnv({ AWS_DEFAULT_REGION: "us-west-2" }, () => selectedBackupTarget());
    expect((fromAws.target as InstanceType<typeof S3Target>).region).toBe("us-west-2");
  });

  it("refuses S3 with no region and no custom endpoint, naming the variable that would provide one", () => {
    const selection = withEnv({}, () => selectedBackupTarget());
    expect(selection.target).toBeNull();
    expect(selection.availability).toMatchObject({
      available: false,
      reason: "ZENITH_BACKUP_TARGET=s3 needs ZENITH_BACKUP_S3_REGION (or AWS_REGION).",
    });
    expect(selection.availability.fix).toMatch(/ZENITH_BACKUP_S3_REGION/);
    expect(withEnv({ AWS_REGION: "  " }, () => selectedBackupTarget()).target).toBeNull();
  });

  it("keeps a custom endpoint working without a region, addressed as us-east-1", () => {
    const selection = withEnv({ ZENITH_BACKUP_S3_ENDPOINT: "http://localhost:4566" }, () => selectedBackupTarget());
    expect(selection.availability.available).toBe(true);
    expect(selection.target).toMatchObject({ endpoint: "http://localhost:4566", region: "us-east-1" });
  });
});
