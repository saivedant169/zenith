/** Safety unit evidence only; this suite never starts Docker or Temporal. */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { load as loadYaml } from "js-yaml";
import { chmod, link, lstat, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { assertCompleteMigrationSet, assertOwnedPackagedBuilder, assertPackagedSourceUnchanged, cleanupOwnedImage, cleanupOwnedResource, command, createPrivateScratch, inFlightSchemaObserverSql, packagedPrivateTransferPayload, packagedPrivateTransferSource, packagedShutdownAuthoritySql, packagedSourceDigest, packagedTemporalControlSource, packagedTemporalSessionRequest, packagedVolumeCustodySource, PackagedCommandError, parsePackagedArgs, preparePackagedPrivateTransfer, prepareTemporalTls, PRIVATE_TRANSFER_LIMIT_BYTES, privateTemporaryBase, redactDiagnosticLogs, refusalFailureCategory, renderTemporalServerConfiguration, sanitizeClientEvidence, sanitizeContainerState, sanitizeImageId, sanitizeLockedDependencies, sanitizeRuntimeFilesystemEvidence, runtimeFilesystemProbeSource, ssmDocumentsDigest, sanitizePackagedCommandFailure, sanitizePackagedInFlightFailure, sanitizePackagedReadiness, sanitizePackagedSweepEvidence, sanitizePackagedTemporalSessionFrame, sanitizePgWaiterEvidence, sanitizeShutdownAuthorityEvidence, sanitizeTemporalControlEvidence, schemaOutageObserverSql, TEMPORAL_ADMIN_IMAGE, TEMPORAL_CONFIG_DIR, TEMPORAL_IMAGE, waitForPackagedReadiness, waitForRefusalExit, workerFailureCategory } from "../../scripts/acceptance/packaged-worker.mjs";
import { assertPackagedAcceptanceTarget } from "../../workers/execution/packaged-target";
import { EXECUTION_FAILURE_CATEGORIES } from "../../workers/execution/startup";
import { digest as controlDigest } from "../../src/lib/controlplane/digest";

const env = { ZENITH_PACKAGED_ACCEPTANCE: "1", ZENITH_STORE: "file", ZENITH_DATA: "/var/lib/zenith",
  ZENITH_WORKER_PLAN_DIR: "/var/lib/zenith/platform-plans", ZENITH_TEMPORAL_ADDRESS: "temporal:7233",
  ZENITH_PLATFORM_DB_URL: "postgresql://postgres:private-fixture-password@postgres:5432/zenith_packaged" };

const readIdentity = () => ({ id: `op_${"1".repeat(32)}`, workspaceId: "packaged-workspace", projectId: "packaged-project",
  environmentId: "packaged-environment", resourceId: null, capability: "infrastructure.observe", principalKind: "user", subjectId: "packaged-member",
  idempotencyKey: `idem_${controlDigest({ k: "user", p: "packaged-member", c: "infrastructure.observe", key: "packaged-read-refusal" })}` });
const readAuthority = () => ({ observerPid: 11, operation: { id: readIdentity().id, workspace_id: "packaged-workspace",
  project_id: "packaged-project", environment_id: "packaged-environment", resource_id: null, idempotency_key: readIdentity().idempotencyKey,
  principal: { kind: "user", id: "packaged-member" }, proposal: { capability: "infrastructure.observe", scope: {
    workspaceId: "packaged-workspace", projectId: "packaged-project", environmentId: "packaged-environment" } },
  capability: "infrastructure.observe", status: "failed", error: "Operation names no target resource." },
  consumedApprovals: [], buildLaunches: [], agentReceipts: [] });
const readClientEvidence = () => ({ reconcile: { status: "observed", drift: 0, unknown: 0 },
  operation: { workflowStatus: "failed", ledgerStatus: "failed", outcome: "expected no-target refusal", policyDecisions: 2,
    activityTypes: ["acquireLease", "evaluatePolicy", "executeCapability", "markOperation", "releaseLease"], signedReadGrantVerified: true,
    identity: readIdentity() }, cloudWritesProven: false, browserApprovalPerformed: false });

/** Exact initializer program with modeled owner/CHOWN-only fs ports, not Linux proof. */
function volumeCustodyModel() {
  type Entry = { ino: number; dev: number; uid: number; gid: number; mode: number; size: number; nlink: number; kind: "file" | "directory" | "symlink" };
  const nodes = new Map<string, Entry>(), held = new Map<number, { path: string; node: Entry }>();
  const output: unknown[] = [], events: { action: string; path: string }[] = [], closed: number[] = [];
  let nextInode = 1, nextFd = 10, exits = 0;
  const model = { nodes, held, output, events, closed, hook: undefined as ((action: string, path: string) => void) | undefined };
  for (const [directory, names] of [["/server", ["ca.crt", "server.crt", "server.key", "server.yaml"]],
    ["/client", ["ca.crt", "client.crt", "client.key", "rogue-client.crt", "rogue-client.key"]]] as const) {
    nodes.set(directory, { ino: nextInode++, dev: 1, uid: 0, gid: 0, mode: 0o40755, size: 4096, nlink: 2, kind: "directory" });
    for (const name of names) nodes.set(`${directory}/${name}`, { ino: nextInode++, dev: 1, uid: 0, gid: 0, mode: 0o100600, size: 32, nlink: 1, kind: "file" });
  }
  const search = (name: string) => {
    const parent = nodes.get(name.slice(0, name.lastIndexOf("/")));
    if (parent && parent.uid !== 0 && (parent.mode & 1) === 0) throw new Error("Modeled directory search refused.");
  };
  const node = (name: string) => { search(name); const found = nodes.get(name); if (!found) throw new Error("Modeled entry missing."); return found; };
  const descriptor = (fd: number) => { const found = held.get(fd); if (!found) throw new Error("Modeled descriptor missing."); return found; };
  const stat = (entry: Entry) => ({ ...entry, isFile: () => entry.kind === "file", isDirectory: () => entry.kind === "directory", isSymbolicLink: () => entry.kind === "symlink" });
  const fs = {
    constants: { O_RDONLY: 0, O_NOFOLLOW: 0x20000, O_DIRECTORY: 0x10000 },
    lstatSync: (name: string) => stat(node(name)), fstatSync: (fd: number) => stat(descriptor(fd).node),
    readdirSync: (name: string) => {
      const directory = node(name);
      if (directory.uid !== 0 && (directory.mode & 5) !== 5) throw new Error("Modeled directory read refused.");
      return [...nodes.keys()].filter(p => p.startsWith(name + "/") && !p.slice(name.length + 1).includes("/")).map(p => p.slice(name.length + 1));
    },
    openSync: (name: string, flags: number) => {
      model.hook?.("open", name);
      const entry = node(name);
      if (!(flags & fs.constants.O_NOFOLLOW) || entry.kind === "symlink" || (entry.kind === "directory" && !(flags & fs.constants.O_DIRECTORY))) throw new Error("Modeled descriptor flags refused.");
      const fd = nextFd++; held.set(fd, { path: name, node: entry }); return fd;
    },
    fchmodSync: (fd: number, mode: number) => {
      const entry = descriptor(fd);
      // Root without FOWNER cannot chmod after transferring this inode.
      if (entry.node.uid !== 0) throw new Error("Modeled EPERM: owner changed before chmod.");
      events.push({ action: "chmod", path: entry.path }); entry.node.mode = (entry.node.mode & ~0o7777) | mode;
      model.hook?.("chmod", entry.path);
    },
    fchownSync: (fd: number, uid: number, gid: number) => {
      const entry = descriptor(fd); events.push({ action: "chown", path: entry.path });
      entry.node.uid = uid; entry.node.gid = gid; model.hook?.("chown", entry.path);
    },
    closeSync: (fd: number) => { descriptor(fd); held.delete(fd); closed.push(fd); },
  };
  return { ...model, model, fs, run: () => runInNewContext(packagedVolumeCustodySource(), {
    require: (name: string) => { if (name !== "node:fs") throw new Error("Modeled module refused."); return fs; },
    process: { getuid: () => 0, getgid: () => 0, exit: () => { exits++; throw new Error("Modeled initializer refused."); } },
    console: { log: (value: unknown) => { output.push(value); } },
  }, { timeout: 1000 }), exits: () => exits };
}

describe("packaged schema completeness", () => {
  it("requires the fresh database to apply exactly the contiguous source migration set", async () => {
    const files = (await readdir("src/lib/controlplane/db/migrations")).filter(file => /^\d{4}_[a-z0-9_]+\.ts$/.test(file));
    const all = files.map((_, index) => index + 1);
    expect(await assertCompleteMigrationSet(all)).toBe(files.length);
    await expect(assertCompleteMigrationSet(all.slice(0, -1))).rejects.toThrow("complete source migration set");
    await expect(assertCompleteMigrationSet([...all, all.length + 1])).rejects.toThrow("complete source migration set");
    await expect(assertCompleteMigrationSet([2, ...all.slice(1)])).rejects.toThrow("complete source migration set");
  });
});

describe("private volume initializer [exact program; filesystem permission models]", () => {
  it("sets private modes while owned, then transfers each retained inode with CHOWN only", () => {
    const m = volumeCustodyModel(); m.run();
    expect(m.output).toEqual(["CUSTODY_VERIFIED"]); expect(m.exits()).toBe(0);
    for (const [name, entry] of m.nodes) {
      const uid = name.startsWith("/server") ? 1000 : 10001;
      expect(entry.uid).toBe(uid); expect(entry.gid).toBe(uid);
      expect(entry.mode & 0o7777).toBe(entry.kind === "directory" ? 0o700 : 0o600);
      expect(m.events.filter(event => event.path === name).map(event => event.action)).toEqual(["chmod", "chown"]);
    }
    expect(m.held.size).toBe(0); expect(m.closed).toHaveLength(11);
  });
  it.each(["extra file", "missing file", "symlink file", "foreign owner", "foreign group", "empty file", "oversized file", "hard link", "symlink parent", "foreign parent", "unsafe parent mode"])("refuses %s before any mutation and never claims custody", fault => {
    const m = volumeCustodyModel(), file = m.nodes.get("/server/ca.crt")!, parent = m.nodes.get("/client")!;
    if (fault === "extra file") m.nodes.set("/client/extra", { ...file, ino: 999 });
    if (fault === "missing file") m.nodes.delete("/server/server.key");
    if (fault === "symlink file") file.kind = "symlink";
    if (fault === "foreign owner") file.uid = 1;
    if (fault === "foreign group") file.gid = 1;
    if (fault === "empty file") file.size = 0;
    if (fault === "oversized file") file.size = 65537;
    if (fault === "hard link") file.nlink = 2;
    if (fault === "symlink parent") parent.kind = "symlink";
    if (fault === "foreign parent") parent.uid = 1;
    if (fault === "unsafe parent mode") parent.mode = 0o40777;
    expect(() => m.run()).toThrow("Modeled initializer refused");
    expect(m.events).toEqual([]); expect(m.output).toEqual([]); expect(m.exits()).toBe(1); expect(m.held.size).toBe(0);
  });
  it.each(["replacement at open", "changed device at open", "file replacement after chmod", "parent replacement after chmod", "changed parent device after chmod", "changed mode after chown", "changed size after chown", "unexpected file during chmod"])("refuses %s after fresh name/descriptor checks without compensation or a success marker", fault => {
    const m = volumeCustodyModel();
    m.model.hook = (action, name) => {
      if (fault === "replacement at open" && action === "open" && name === "/server/ca.crt") m.nodes.set(name, { ...m.nodes.get(name)!, ino: 999 });
      if (fault === "changed device at open" && action === "open" && name === "/server/ca.crt") m.nodes.set(name, { ...m.nodes.get(name)!, dev: 999 });
      if (fault === "file replacement after chmod" && action === "chmod" && name === "/server/ca.crt") m.nodes.set(name, { ...m.nodes.get(name)!, ino: 999 });
      if (fault === "parent replacement after chmod" && action === "chmod" && name === "/server") m.nodes.set(name, { ...m.nodes.get(name)!, ino: 999 });
      if (fault === "changed parent device after chmod" && action === "chmod" && name === "/server") m.nodes.set(name, { ...m.nodes.get(name)!, dev: 999 });
      if (fault === "changed mode after chown" && action === "chown" && name === "/server/ca.crt") m.nodes.get(name)!.mode = 0o100644;
      if (fault === "changed size after chown" && action === "chown" && name === "/server/ca.crt") m.nodes.get(name)!.size = 64;
      if (fault === "unexpected file during chmod" && action === "chmod" && name === "/server/ca.crt") m.nodes.set("/server/extra", { ...m.nodes.get(name)!, ino: 999 });
    };
    expect(() => m.run()).toThrow("Modeled initializer refused");
    expect(m.output).toEqual([]); expect(m.exits()).toBe(1); expect(m.held.size).toBe(0);
    expect(m.events.filter(event => event.path === "/client")).toEqual([]);
    if (fault === "replacement at open" || fault === "changed device at open") expect(m.events).toEqual([]);
    if (fault === "file replacement after chmod" || fault === "unexpected file during chmod") expect(m.events.filter(event => event.path === "/server/ca.crt").map(event => event.action)).toEqual(["chmod"]);
  });
});

/** Exact receiver with explicit filesystem ports; no kernel or TLS success claim. */
function privateTransferModel(frame: Buffer) {
  const m = volumeCustodyModel(), content = new Map<string, Buffer>();
  for (const [name, entry] of m.nodes) if (entry.kind === "file") m.nodes.delete(name);
  const originalOpen = m.fs.openSync, originalStat = m.fs.lstatSync;
  const flags = { ...m.fs.constants, O_RDWR: 2, O_CREAT: 0x40, O_EXCL: 0x80 };
  let nextFd = 100, nextInode = 100, inputOffset = 0, exits = 0;
  const resolve = (target: string) => {
    const match = /^\/proc\/self\/fd\/(\d+)\/([^/]+)$/.exec(target);
    if (!match) return target;
    const held = m.held.get(Number(match[1]));
    if (!held || held.node !== m.nodes.get(held.path)) throw new Error("Modeled parent substituted.");
    return `${held.path}/${match[2]}`;
  };
  const descriptor = (fd: number) => { const held = m.held.get(fd); if (!held) throw new Error("Modeled descriptor missing."); return held; };
  const fs = Object.assign(m.fs, {
    constants: flags,
    lstatSync: (target: string) => originalStat(resolve(target)),
    openSync: (target: string, options: number, mode?: number) => {
      const name = resolve(target);
      if (!(options & flags.O_CREAT)) return originalOpen(name, options);
      m.model.hook?.("create", name);
      if ((options & (flags.O_RDWR | flags.O_CREAT | flags.O_EXCL | flags.O_NOFOLLOW)) !== (flags.O_RDWR | flags.O_CREAT | flags.O_EXCL | flags.O_NOFOLLOW)
        || mode !== 0o600 || m.nodes.has(name)) throw new Error("Modeled exclusive creation refused.");
      const node = { ino: nextInode++, dev: 1, uid: 0, gid: 0, mode: 0o100600, size: 0, nlink: 1, kind: "file" as const };
      m.nodes.set(name, node); content.set(name, Buffer.alloc(0));
      const fd = nextFd++; m.held.set(fd, { path: name, node }); m.events.push({ action: "create", path: name }); return fd;
    },
    readSync: (fd: number, bytes: Buffer, offset: number, length: number, position: number | null) => {
      if (fd === 0) { const count = Math.min(length, 7, frame.length - inputOffset); frame.copy(bytes, offset, inputOffset, inputOffset + count); inputOffset += count; return count; }
      const entry = descriptor(fd), data = content.get(entry.path)!;
      m.model.hook?.("read", entry.path);
      return data.copy(bytes, offset, position ?? 0, Math.min((position ?? 0) + length, data.length));
    },
    writeSync: (fd: number, bytes: Buffer, offset: number, length: number, position: number) => {
      const entry = descriptor(fd), count = Math.min(length, 3), previous = content.get(entry.path)!;
      const data = Buffer.alloc(Math.max(previous.length, position + count)); previous.copy(data); bytes.copy(data, position, offset, offset + count);
      content.set(entry.path, data); entry.node.size = data.length; m.events.push({ action: "write", path: entry.path });
      m.model.hook?.("write", entry.path); return count;
    },
    fsyncSync: (fd: number) => { const entry = descriptor(fd); m.events.push({ action: "fsync", path: entry.path }); m.model.hook?.("fsync", entry.path); },
  });
  return { ...m, content, fs, runTransfer: () => runInNewContext(packagedPrivateTransferSource(), {
    Buffer, require: (name: string) => { if (name !== "node:fs") throw new Error("Modeled module refused."); return fs; },
    process: { getuid: () => 0, getgid: () => 0, exit: () => { exits++; throw new Error("Modeled transfer refused."); } },
    console: { log: () => { throw new Error("Private receiver must be silent."); }, error: () => { throw new Error("Private receiver must be silent."); } },
  }, { timeout: 1000 }), transferExits: () => exits };
}

describe("private packaged file transfer [exact program; filesystem models]", () => {
  const files = Array.from({ length: 9 }, (_, index) => Buffer.from(`private-canary-${index}`));
  const names = ["/server/ca.crt", "/server/server.crt", "/server/server.key", "/server/server.yaml", "/client/ca.crt", "/client/client.crt", "/client/client.key", "/client/rogue-client.crt", "/client/rogue-client.key"];
  it("creates only nine exclusive root-owned private files before the unchanged CHOWN-only initializer", () => {
    const m = privateTransferModel(packagedPrivateTransferPayload(files)); m.runTransfer();
    expect(m.transferExits()).toBe(0); expect(m.output).toEqual([]); expect(m.held.size).toBe(0); expect(m.closed).toHaveLength(11);
    expect([...m.nodes.keys()].filter(name => m.nodes.get(name)!.kind === "file")).toEqual(names);
    for (const [index, name] of names.entries()) {
      const entry = m.nodes.get(name)!;
      expect({ uid: entry.uid, gid: entry.gid, mode: entry.mode & 0o7777, nlink: entry.nlink, size: entry.size })
        .toEqual({ uid: 0, gid: 0, mode: 0o600, nlink: 1, size: files[index].length });
      expect(m.content.get(name)).toEqual(files[index]);
      expect(m.events.filter(event => event.path === name).at(-1)?.action).toBe("fsync");
    }
    // Byte delivery alone is never custody evidence: execute the original program separately.
    m.run(); expect(m.output).toEqual(["CUSTODY_VERIFIED"]); expect(m.exits()).toBe(0);
    for (const [name, entry] of m.nodes) {
      expect(entry.uid).toBe(name.startsWith("/server") ? 1000 : 10001);
      expect(entry.gid).toBe(entry.uid); expect(entry.mode & 0o7777).toBe(entry.kind === "directory" ? 0o700 : 0o600);
    }
  });
  it.each(["empty", "bad magic", "short length", "short content", "zero length", "oversized length", "extra EOF", "oversized frame"])("refuses %s before any file creation", fault => {
    let frame = packagedPrivateTransferPayload(files);
    const magicLength = Buffer.byteLength("ZENITH-PRIVATE-FILES-V1\n");
    if (fault === "empty") frame = Buffer.alloc(0);
    if (fault === "bad magic") frame[0] ^= 1;
    if (fault === "short length") frame = frame.subarray(0, magicLength + 3);
    if (fault === "short content") frame = frame.subarray(0, frame.length - 1);
    if (fault === "zero length") frame.writeUInt32BE(0, magicLength);
    if (fault === "oversized length") frame.writeUInt32BE(65537, magicLength);
    if (fault === "extra EOF") frame = Buffer.concat([frame, Buffer.from("private-extra")]);
    if (fault === "oversized frame") frame = Buffer.alloc(PRIVATE_TRANSFER_LIMIT_BYTES + 1);
    const m = privateTransferModel(frame);
    expect(() => m.runTransfer()).toThrow("Modeled transfer refused"); expect(m.transferExits()).toBe(1);
    expect(m.events).toEqual([]); expect(m.output).toEqual([]); expect(m.held.size).toBe(0);
  });
  it.each(["foreign parent owner", "foreign parent group", "unsafe parent mode", "symlink parent", "preexisting file", "preexisting symlink", "preexisting hard link"])("refuses %s before any file creation", fault => {
    const m = privateTransferModel(packagedPrivateTransferPayload(files)), parent = m.nodes.get("/client")!;
    if (fault === "foreign parent owner") parent.uid = 501;
    if (fault === "foreign parent group") parent.gid = 20;
    if (fault === "unsafe parent mode") parent.mode = 0o40777;
    if (fault === "symlink parent") parent.kind = "symlink";
    if (fault.startsWith("preexisting")) m.nodes.set("/client/client.key", { ...parent, ino: 999, kind: fault === "preexisting symlink" ? "symlink" : "file", nlink: fault === "preexisting hard link" ? 2 : 1 });
    expect(() => m.runTransfer()).toThrow("Modeled transfer refused"); expect(m.events).toEqual([]);
    expect(m.output).toEqual([]); expect(m.held.size).toBe(0); expect(m.transferExits()).toBe(1);
  });
  it.each(["parent replacement at open", "leaf replacement after write", "hard link after write", "foreign owner after write", "extra entry after write", "changed bytes at readback"])("refuses %s without a custody marker", fault => {
    const m = privateTransferModel(packagedPrivateTransferPayload(files));
    m.model.hook = (action, name) => {
      if (fault === "parent replacement at open" && action === "open" && name === "/client") m.nodes.set(name, { ...m.nodes.get(name)!, ino: 999 });
      if (name !== "/server/ca.crt") return;
      if (fault === "leaf replacement after write" && action === "write") m.nodes.set(name, { ...m.nodes.get(name)!, ino: 999 });
      if (fault === "hard link after write" && action === "write") m.nodes.get(name)!.nlink = 2;
      if (fault === "foreign owner after write" && action === "write") m.nodes.get(name)!.uid = 501;
      if (fault === "extra entry after write" && action === "write") m.nodes.set("/client/extra", { ...m.nodes.get(name)!, ino: 999 });
      if (fault === "changed bytes at readback" && action === "read") m.content.get(name)!.fill(0);
    };
    expect(() => m.runTransfer()).toThrow("Modeled transfer refused"); expect(m.output).toEqual([]);
    expect(m.held.size).toBe(0); expect(m.transferExits()).toBe(1);
    expect(m.events.some(event => event.action === "chown")).toBe(false);
    if (fault === "parent replacement at open") expect(m.events).toEqual([]);
  });
  it.each(["wrong count", "empty file", "oversized file", "non-buffer"])("refuses host frame %s without serializing byte content", fault => {
    const input: unknown[] = [...files];
    if (fault === "wrong count") input.pop();
    if (fault === "empty file") input[0] = Buffer.alloc(0);
    if (fault === "oversized file") input[0] = Buffer.alloc(65537);
    if (fault === "non-buffer") input[0] = "private-canary";
    expect(() => packagedPrivateTransferPayload(input)).toThrow("Private file transfer is unconfirmed.");
  });
  it.each(["missing file", "empty file", "oversized file", "unsafe file mode", "symlink file", "hard link", "unsafe parent mode", "invalid certificate"])("refuses host capture %s with a fixed secret-free error", async fault => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), "zenith-private-transfer-"));
    try {
      await chmod(scratch, 0o700);
      for (const name of new Set(names.map(name => path.basename(name)))) await writeFile(path.join(scratch, name), "private-canary", { mode: 0o600, flag: "wx" });
      const file = path.join(scratch, "ca.crt");
      if (fault === "missing file") await rm(file);
      if (fault === "empty file") await writeFile(file, "");
      if (fault === "oversized file") await writeFile(file, Buffer.alloc(65537));
      if (fault === "unsafe file mode") await chmod(file, 0o644);
      if (fault === "symlink file") { await rm(file); await symlink(path.join(scratch, "server.crt"), file); }
      if (fault === "hard link") await link(file, path.join(scratch, "hard-link-canary"));
      if (fault === "unsafe parent mode") await chmod(scratch, 0o755);
      const hash = createHash("sha256").update("private-canary").digest("hex"), certificates = { ca: hash, server: hash, client: hash, "rogue-client": hash };
      await expect(preparePackagedPrivateTransfer(scratch, certificates, hash)).rejects.toThrow(/^Private file transfer is unconfirmed\.$/);
      // Only refusal is modeled here. Valid certificate capture is a separate actual TLS probe.
    } finally { await rm(scratch, { recursive: true, force: true }); }
  });
  it("wires only bounded stdin into the owned installer before independently confirming custody", () => {
    const harness = readFileSync(new URL("../../scripts/acceptance/packaged-worker.mjs", import.meta.url), "utf8");
    const main = harness.slice(harness.indexOf("export async function packagedWorkerMain("));
    expect(main).toContain('await docker(["exec", "-i", installer, "node", "-e", packagedPrivateTransferSource()], "private-files-transfer", { privateInput: privateFrame })');
    expect(main).toContain("finally { privateFrame.fill(0); }"); expect(main).not.toContain('docker(["cp"');
    expect(main.indexOf("packagedPrivateTransferSource()" )).toBeLessThan(main.indexOf("packagedVolumeCustodySource()"));
    expect(main).toContain('custody.out.trim() !== "CUSTODY_VERIFIED"');
    expect(packagedPrivateTransferSource()).not.toContain("console.");
  });
});

describe("private packaged stdin transport [local process fixtures]", () => {
  it("projects only the fixed transfer phase and input failure category", () => {
    expect(sanitizePackagedCommandFailure(new PackagedCommandError("private-files-transfer", "command-input")))
      .toEqual({ category: "command-input", exitCode: null, signal: null, phase: "private-files-transfer" });
  });
  it("delivers bounded bytes with backpressure while discarding all private command output", async () => {
    const bytes = Buffer.alloc(500000, 97);
    const result = await command(process.execPath, ["-e", "const f=require('node:fs'),b=f.readFileSync(0);process.stdout.write(b);process.stderr.write(b);if(b.length!==500000||b.some(x=>x!==97))process.exit(7)"], "private-files-transfer", { privateInput: bytes });
    expect(result).toEqual({ code: 0, out: "", err: "" });
  });
  it.each(["empty", "oversized", "non-buffer"])("refuses %s stdin before launching a private command", async fault => {
    const privateInput = fault === "empty" ? Buffer.alloc(0) : fault === "oversized" ? Buffer.alloc(PRIVATE_TRANSFER_LIMIT_BYTES + 1) : "private-canary";
    await expect(command("does-not-exist-private-canary", [], "private-files-transfer", { privateInput })).rejects.toMatchObject({ diagnostic: { category: "command-input" } });
  });
  it("refuses broken stdin without exposing private output or permitting an allowed failure", async () => {
    const input = Buffer.alloc(PRIVATE_TRANSFER_LIMIT_BYTES, 97);
    await expect(command(process.execPath, ["-e", "require('node:fs').closeSync(0);console.error('private-canary');setTimeout(()=>process.exit(0),50)"], "private-files-transfer", { privateInput: input, allowFailure: true }))
      .rejects.toMatchObject({ diagnostic: { category: "command-input" } });
  });
  it("refuses a private timeout without exposing bytes or treating delivery as custody", async () => {
    await expect(command(process.execPath, ["-e", "setInterval(()=>{},1000)"], "private-files-transfer", { privateInput: Buffer.alloc(PRIVATE_TRANSFER_LIMIT_BYTES), timeout: 20, allowFailure: true }))
      .rejects.toMatchObject({ diagnostic: { category: "command-timeout" } });
  });
  it("refuses a nonzero private exit with only the fixed diagnostic even when failure was allowed", async () => {
    try {
      await command(process.execPath, ["-e", "require('node:fs').readFileSync(0);console.error('private-canary');process.exit(23)"], "private-files-transfer", { privateInput: Buffer.from("private-canary"), allowFailure: true });
      throw new Error("Expected private exit refusal.");
    } catch (error) {
      expect(error).toBeInstanceOf(PackagedCommandError);
      expect(JSON.stringify(error)).not.toContain("private-canary");
      expect(error).toMatchObject({ diagnostic: { category: "command-exit", exitCode: 23, signal: null } });
    }
  });
  it.each(["launch", "signal", "output limit"])("refuses private %s with no command output or byte serialization", async fault => {
    const binary = fault === "launch" ? "does-not-exist-private-canary" : process.execPath;
    const source = fault === "signal" ? "require('node:fs').readFileSync(0);process.kill(process.pid,'SIGTERM')"
      : "require('node:fs').readFileSync(0);process.stdout.write('private-canary'.repeat(300000))";
    const category = fault === "launch" ? "command-launch" : fault === "signal" ? "command-signal" : "command-output-limit";
    try {
      await command(binary, ["-e", source], "private-files-transfer", { privateInput: Buffer.from("private-byte-canary"), allowFailure: true });
      throw new Error("Expected private command refusal.");
    } catch (error) {
      expect(error).toBeInstanceOf(PackagedCommandError); expect(error).toMatchObject({ diagnostic: { category } });
      expect(String(error)).not.toContain("private-canary"); expect(JSON.stringify(error)).not.toContain("private-byte-canary");
    }
  });
});

describe("packaged in-flight shutdown boundary [source and scalar models]", () => {
  const workerIdentity = "zenith-pkg-arm64-0123456789ab";
  const activity = { scheduleOwned: true, encryptedInput: true, paused: false,
    workflowId: "zenith-reconcile-sweep-v1-2026-10-04T08:00:00Z", runId: "01234567-0123-4123-8123-0123456789ab",
    activityId: "1", activityType: "sweepReconcilePass", workerIdentity, attempt: 1, maximumAttempts: 1,
    workflowStatus: "running", activityState: "started" };
  const history = { ...activity, workflowStatus: "completed", result: "deferred", reason: "prerequisites_unavailable",
    scheduledEventId: 5, startedEventId: 6, completedEventId: 7, startedByOriginalWorker: true, completedByOriginalWorker: true };
  const authority = readAuthority;
  it("admits only the exact started sweep and projects no arbitrary control payload", () => {
    expect(sanitizePackagedSweepEvidence("activity", { ...activity, password: "private-canary", providerWriteAccepted: true }, workerIdentity)).toEqual(activity);
    expect(JSON.stringify(sanitizePackagedSweepEvidence("activity", { ...activity, password: "private-canary" }, workerIdentity))).not.toContain("private-canary");
  });
  it.each([
    { activityState: "scheduled" }, { workflowStatus: "completed" }, { paused: true }, { scheduleOwned: false }, { encryptedInput: false },
    { workerIdentity: "zenith-pkg-arm64-ffffffffffff" }, { maximumAttempts: 2 }, { attempt: 2 },
    { activityType: "executeCapability" }, { activityId: "private-canary" }, { workflowId: "foreign-workflow" }, { runId: "private-canary" },
  ])("refuses an idle, foreign, retried or malformed activity (%j)", change => {
    expect(() => sanitizePackagedSweepEvidence("activity", { ...activity, ...change }, workerIdentity)).toThrow("unconfirmed");
  });
  it("admits exact original-worker event linkage while excluding decoded results and extra history", () => {
    const { activityState, ...expected } = history;
    expect(activityState).toBe("started");
    expect(sanitizePackagedSweepEvidence("history", { ...history, decodedResult: "private-canary" }, workerIdentity))
      .toEqual(expected);
  });
  it.each([
    { startedByOriginalWorker: false }, { completedByOriginalWorker: false }, { result: "completed" }, { reason: "pass_unconfirmed" },
    { scheduledEventId: 0 }, { startedEventId: 5 }, { completedEventId: 6 }, { completedEventId: "private-canary" }, { attempt: 2 },
  ])("refuses a substituted, replayed or unconfirmed terminal history (%j)", change => {
    expect(() => sanitizePackagedSweepEvidence("history", { ...history, ...change }, workerIdentity)).toThrow("unconfirmed");
  });
  it("requires actual pending STARTED metadata and one linked scheduled, started and completed event from the installed SDK", () => {
    const source = packagedTemporalControlSource();
    expect(source).toContain("const pending=d.raw.pendingActivities;");
    expect(source).toContain("pending?.length!==1");
    expect(source).toContain("a.state!==2||a.attempt!==1||a.maximumAttempts!==1");
    expect(source).toContain("a.lastWorkerIdentity!==workerIdentity");
    expect(source).toContain("()=>h.fetchHistory()");
    expect(source).toContain("scheduled.length!==1||started.length!==1||completed.length!==1");
    expect(source).toContain("b.identity!==workerIdentity");
    expect(source).toContain("c.identity!==workerIdentity");
    expect(source).toContain("a.retryPolicy?.maximumAttempts!==1");
    expect(source).toContain("p.status!=='deferred'||p.reason!=='prerequisites_unavailable'");
    expect(source).not.toContain("workflow.start(");
    expect(source).not.toContain("Worker.create(");
  });
  it("scopes the post-signal SQL observer to its owned blocker and original worker container address", () => {
    const query = inFlightSchemaObserverSql(workerIdentity, "172.20.0.4");
    expect(query).toContain("b.pid=any(pg_blocking_pids(a.pid))");
    expect(query).toContain("b.application_name='zenith-pkg-arm64-0123456789ab-inflight-shutdown'");
    expect(query).toContain("a.client_addr='172.20.0.4'::inet");
    expect(query).not.toContain("-schema-outage'");
    for (const address of [undefined, "256.0.0.1", "private-canary", "172.20.0.4'; select 1; --"]) {
      expect(() => inFlightSchemaObserverSql(workerIdentity, address)).toThrow("address is invalid");
    }
  });
  it("keeps existing failed read authority byte-bound across independent connections without claiming consumed-grant or receipt recovery", () => {
    const before = sanitizeShutdownAuthorityEvidence(authority(), readIdentity());
    const after = sanitizeShutdownAuthorityEvidence({ ...authority(), observerPid: 12, privatePayload: "private-canary" }, readIdentity());
    expect(before.sha256).toBe(after.sha256);
    expect(after).toEqual({ observerPid: 12, sha256: before.sha256, consumedApprovalRows: 0, buildLaunchRows: 0, agentReceiptRows: 0 });
    const changed = authority(); changed.operation.error += " Changed.";
    expect(sanitizeShutdownAuthorityEvidence(changed, readIdentity()).sha256).not.toBe(before.sha256);
    expect(JSON.stringify(after)).not.toContain("private-canary");
    const sql = packagedShutdownAuthoritySql(readIdentity());
    expect(sql).toContain("pg_backend_pid()");
    expect(sql).toContain(`id='${readIdentity().id}'`);
    expect(sql).toContain(`idempotency_key='${readIdentity().idempotencyKey}'`);
    expect(sql).not.toContain("idempotency_key='packaged-read-refusal'");
    expect(sql).not.toMatch(/\b(update|insert|delete|truncate|alter)\b/i);
  });
  it.each(["consumedApprovals", "buildLaunches", "agentReceipts"] as const)("refuses nonempty %s rather than borrowing mutation evidence from this fixture", key => {
    const value: Record<string, unknown> = authority(); value[key] = [{ privatePayload: "private-canary" }];
    expect(() => sanitizeShutdownAuthorityEvidence(value, readIdentity())).toThrow("unconfirmed");
  });
  it("requires the post-signal held boundary, a distinct fresh entrypoint and original history before accepting recovery", () => {
    const harness = readFileSync(new URL("../../scripts/acceptance/packaged-worker.mjs", import.meta.url), "utf8");
    expect(harness.indexOf('entered = await control("activity")')).toBeLessThan(harness.indexOf('await docker(["kill", "--signal", "SIGTERM", worker]'));
    expect(harness.indexOf('await docker(["kill", "--signal", "SIGTERM", worker]')).toBeLessThan(harness.indexOf('afterSignal = await control("activity"'));
    expect(harness).toContain('drainWaiter.waiterPid !== heldWaiter.waiterPid');
    expect(harness).toContain('drainWaiter.blockerPid !== heldWaiter.blockerPid');
    expect(harness).toContain('await docker([...isolated(recoveryWorker, recoveryEnvFile), "-d", image]');
    expect(harness).toContain('const retainedHistory = await control("history", "client", false, [entered.workflowId, entered.runId, entered.activityId])');
    expect(harness).toContain('authorityBefore.sha256 !== authorityAfterRecovery.sha256');
    expect(harness).toContain('consumedApprovalPreservationProven: false, receiptRecoveryProven: false');
    expect(harness).toContain('await docker(["stop", "--time", "40", recoveryWorker]');
    expect(harness).not.toContain('"--privileged"');
    expect(harness).not.toContain('"--tls-disable-host-verification"');
  });
});

describe("packaged shutdown operation identity [source and scalar models]", () => {
  it("binds the sanitized original client result to its exact native operation and canonical scoped key", () => {
    const client = sanitizeClientEvidence("operations", { ...readClientEvidence(), privatePayload: "private-canary" });
    if (!client || typeof client !== "object" || !client.operation) throw new Error("Expected admitted operations evidence.");
    expect(client.operation.identity).toEqual(readIdentity());
    const sql = packagedShutdownAuthoritySql(client.operation.identity);
    expect(sql).toContain(`id='${readIdentity().id}'`);
    expect(sql).toContain(`idempotency_key='${readIdentity().idempotencyKey}'`);
    for (const predicate of ["workspace_id='packaged-workspace'", "project_id='packaged-project'", "environment_id='packaged-environment'",
      "resource_id is null", "capability='infrastructure.observe'", "principal->>'kind'='user'", "principal->>'id'='packaged-member'",
      "proposal->>'capability'='infrastructure.observe'", "proposal->'scope'->>'workspaceId'='packaged-workspace'",
      "proposal->'scope'->>'projectId'='packaged-project'", "proposal->'scope'->>'environmentId'='packaged-environment'",
      "proposal->'scope'->>'resourceId' is null"]) expect(sql).toContain(predicate);
    expect(sql).not.toMatch(/\b(limit|like|update|insert|delete|truncate|alter)\b/i);
    expect(sql).not.toContain("packaged-read-refusal");
    expect(JSON.stringify(client)).not.toContain("private-canary");
    expect(sanitizeShutdownAuthorityEvidence(readAuthority(), client.operation.identity)).toMatchObject({
      consumedApprovalRows: 0, buildLaunchRows: 0, agentReceiptRows: 0 });
  });
  it.each(["missing identity", "array identity", "missing id", "number id", "overlong id", "wrong prefix", "foreign shape", "SQL injection id",
    "foreign workspace", "foreign project", "foreign environment", "resource present", "resource missing", "wrong capability", "wrong principal kind",
    "wrong subject", "raw key", "different scoped key", "key wrong type", "SQL injection key"] as const)("refuses client and SQL identity %s", fault => {
    const value: Record<string, unknown> = { ...readIdentity() };
    let candidate: unknown = value;
    switch (fault) {
      case "missing identity": candidate = undefined; break;
      case "array identity": candidate = [value]; break;
      case "missing id": delete value.id; break;
      case "number id": value.id = 1; break;
      case "overlong id": value.id = `op_${"1".repeat(10000)}`; break;
      case "wrong prefix": value.id = `dep_${"1".repeat(32)}`; break;
      case "foreign shape": value.id = "op_private-canary"; break;
      case "SQL injection id": value.id = "op_'; select 1; --"; break;
      case "foreign workspace": value.workspaceId = "foreign-workspace"; break;
      case "foreign project": value.projectId = "foreign-project"; break;
      case "foreign environment": value.environmentId = "foreign-environment"; break;
      case "resource present": value.resourceId = "foreign-resource"; break;
      case "resource missing": delete value.resourceId; break;
      case "wrong capability": value.capability = "infrastructure.apply"; break;
      case "wrong principal kind": value.principalKind = "integration"; break;
      case "wrong subject": value.subjectId = "foreign-member"; break;
      case "raw key": value.idempotencyKey = "packaged-read-refusal"; break;
      case "different scoped key": value.idempotencyKey = `idem_${controlDigest({ k: "user", p: "foreign-member", c: "infrastructure.observe", key: "packaged-read-refusal" })}`; break;
      case "key wrong type": value.idempotencyKey = [readIdentity().idempotencyKey]; break;
      case "SQL injection key": value.idempotencyKey = "idem_'; select 1; --"; break;
    }
    const client = readClientEvidence();
    expect(() => sanitizeClientEvidence("operations", { ...client, operation: { ...client.operation, identity: candidate } })).toThrow("unconfirmed");
    expect(() => packagedShutdownAuthoritySql(candidate)).toThrow("unconfirmed");
    expect(() => sanitizeShutdownAuthorityEvidence(readAuthority(), candidate)).toThrow("unconfirmed");
  });
  it.each(["different operation", "missing operation", "foreign workspace", "foreign project", "foreign environment", "resource present",
    "resource missing", "wrong capability", "raw key", "different scoped key", "foreign subject", "foreign principal kind", "delegated subject",
    "integration identity", "missing principal", "missing proposal", "wrong proposal capability", "foreign proposal workspace",
    "foreign proposal project", "foreign proposal environment", "proposal resource", "successful operation", "wrong refusal"] as const)("refuses native readback %s with original client identity unchanged", fault => {
    const original = readAuthority();
    const operation: Record<string, unknown> = { ...original.operation };
    const principal: Record<string, unknown> = { ...original.operation.principal };
    const scope: Record<string, unknown> = { ...original.operation.proposal.scope };
    const proposal: Record<string, unknown> = { ...original.operation.proposal, scope };
    operation.principal = principal; operation.proposal = proposal;
    switch (fault) {
      case "different operation": operation.id = `op_${"2".repeat(32)}`; break;
      case "missing operation": break;
      case "foreign workspace": operation.workspace_id = "foreign-workspace"; break;
      case "foreign project": operation.project_id = "foreign-project"; break;
      case "foreign environment": operation.environment_id = "foreign-environment"; break;
      case "resource present": operation.resource_id = "foreign-resource"; break;
      case "resource missing": delete operation.resource_id; break;
      case "wrong capability": operation.capability = "infrastructure.apply"; break;
      case "raw key": operation.idempotency_key = "packaged-read-refusal"; break;
      case "different scoped key": operation.idempotency_key = `idem_${"a".repeat(64)}`; break;
      case "foreign subject": principal.id = "foreign-member"; break;
      case "foreign principal kind": principal.kind = "integration"; break;
      case "delegated subject": principal.onBehalfOf = "packaged-member"; break;
      case "integration identity": principal.integrationId = "foreign-integration"; break;
      case "missing principal": delete operation.principal; break;
      case "missing proposal": delete operation.proposal; break;
      case "wrong proposal capability": proposal.capability = "infrastructure.apply"; break;
      case "foreign proposal workspace": scope.workspaceId = "foreign-workspace"; break;
      case "foreign proposal project": scope.projectId = "foreign-project"; break;
      case "foreign proposal environment": scope.environmentId = "foreign-environment"; break;
      case "proposal resource": scope.resourceId = "foreign-resource"; break;
      case "successful operation": operation.status = "succeeded"; break;
      case "wrong refusal": operation.error = "a different refusal"; break;
    }
    expect(() => sanitizeShutdownAuthorityEvidence({ ...original, operation: fault === "missing operation" ? null : operation }, readIdentity())).toThrow("unconfirmed");
  });
  it("verifies the persisted native tuple before emitting identity and reuses it for every shutdown readback", () => {
    const client = readFileSync(new URL("../../workers/execution/packaged-client.ts", import.meta.url), "utf8");
    const harness = readFileSync(new URL("../../scripts/acceptance/packaged-worker.mjs", import.meta.url), "utf8");
    expect(client).toContain('const scopedKey = `idem_${digest({ k: principal.kind, p: principal.id, c: request.capability, key: request.idempotencyKey })}`;');
    for (const check of ["recorded.id !== proposal.operation.id", "recorded.idempotencyKey !== scopedKey", "recorded.resourceId !== undefined",
      "recordedScope.workspaceId !== WS", "recordedScope.projectId !== PROJECT", "recordedScope.environmentId !== ENVIRONMENT",
      "recordedScope.resourceId !== undefined", 'recorded.principal.kind !== "user"', "recorded.principal.id !== HUMAN"]) expect(client).toContain(check);
    expect(client.indexOf('throw new Error("Read operation identity does not match the packaged request.")')).toBeLessThan(client.indexOf("identity: { id: recorded.id"));
    expect(harness).toContain("packagedShutdownAuthoritySql(evidence.operations.operation.identity)");
    expect(harness).toContain("sanitizeShutdownAuthorityEvidence(JSON.parse(result.out.trim()), evidence.operations.operation.identity)");
    expect(harness).toContain("authorityBefore.sha256 !== authorityAfterRecovery.sha256");
  });
});

describe("packaged real-server admission contracts [source and scalar models]", () => {
  const template = readFileSync(new URL("../../deploy/acceptance/temporal-worker-test.yaml", import.meta.url), "utf8");
  const builder = "zenith-owned-0123456789ab";
  const buildImage = "moby/buildkit:buildx-stable-1@sha256:cec9f139f45e93c5c69c60f8b07cfad9f43f4ef6b6a6cd917527fea5ff2e3dea";
  const inspected = `Name: ${builder}\nDriver: docker-container\nNodes:\nName: ${builder}0\nEndpoint: desktop-linux\nDriver Options: image="${buildImage}" memory="4g" default-load="true"\n`;
  it("admits the exact external bounded builder observation, without treating it as a creation receipt", () => {
    expect(assertOwnedPackagedBuilder(builder, inspected, "desktop-linux")).toBe(builder);
  });
  it.each([
    { name: "default", observed: inspected }, { name: builder, observed: inspected.replace(builder, "foreign") },
    { name: builder, observed: inspected.replace("docker-container", "docker") },
    { name: builder, observed: inspected.replace('memory="4g"', 'memory="8g"') },
    { name: builder, observed: inspected.replace(buildImage, "moby/buildkit:latest") },
    { name: builder, observed: inspected.replace("Endpoint: desktop-linux", "Endpoint: remote") },
  ])("refuses an unconfirmed or unbounded builder ($name)", ({ name, observed }) => {
    expect(() => assertOwnedPackagedBuilder(name, observed, "desktop-linux")).toThrow("externally owned bounded builder");
  });
  it("renders only bounded hex credentials, retaining real mutual TLS and disabled HTTP", () => {
    const rendered = renderTemporalServerConfiguration(template, "a".repeat(64));
    const config = loadYaml(rendered) as {
      persistence: { datastores: Record<string, { sql: { databaseName: string; connectAddr: string; password: string } }> };
      global: { tls: Record<"frontend" | "internode", { server: { requireClientAuth: boolean; certFile: string; keyFile: string; clientCaFiles: string[] }; client: { serverName: string; rootCaFiles: string[]; disableHostVerification?: boolean } }> };
      services: { frontend: { rpc: { httpPort: number } } };
    };
    expect(config.persistence.datastores.default.sql).toMatchObject({ databaseName: "temporal", connectAddr: "postgres:5432", password: "a".repeat(64) });
    expect(config.persistence.datastores.visibility.sql).toMatchObject({ databaseName: "temporal_visibility", connectAddr: "postgres:5432", password: "a".repeat(64) });
    for (const role of ["frontend", "internode"] as const) {
      expect(config.global.tls[role].server).toEqual({ requireClientAuth: true, certFile: "/etc/zenith-temporal/server.crt", keyFile: "/etc/zenith-temporal/server.key", clientCaFiles: ["/etc/zenith-temporal/ca.crt"] });
      expect(config.global.tls[role].client).toEqual({ serverName: "temporal", rootCaFiles: ["/etc/zenith-temporal/ca.crt"] });
    }
    expect(config.services.frontend.rpc.httpPort).toBe(0);
    expect(rendered).not.toContain("__OWNED_POSTGRES_PASSWORD__");
  });
  it.each(["", "a".repeat(63), "a".repeat(65), "a\npermissions: admin", "private-canary"])("refuses malformed password data before YAML insertion", password => {
    expect(() => renderTemporalServerConfiguration(template, password)).toThrow("configuration is invalid");
  });
  it("refuses missing or additional template authority rather than substituting a partial config", () => {
    expect(() => renderTemporalServerConfiguration(template.replaceAll("__OWNED_POSTGRES_PASSWORD__", "unbound"), "a".repeat(64))).toThrow();
    expect(() => renderTemporalServerConfiguration(template + "\n__OWNED_POSTGRES_PASSWORD__", "a".repeat(64))).toThrow();
  });
  it("refuses nonprivate TLS scratch before invoking any certificate command", async () => {
    const temporary = await mkdtemp(path.join(await realpath(os.tmpdir()), "zenith-tls-mode-contract-"));
    let calls = 0;
    try {
      await chmod(temporary, 0o755);
      await expect(prepareTemporalTls(temporary, async () => { calls++; throw new Error("Unexpected certificate command."); })).rejects.toThrow("Private TLS custody");
      expect(calls).toBe(0);
      expect(await readdir(temporary)).toEqual([]);
    } finally { await rm(temporary, { recursive: true, force: true }); }
  });
  it("requires the fifth current observation check and exports no arbitrary readiness payload", () => {
    expect(sanitizePackagedReadiness({ ready: true, checks: { temporal: "ok", store: "ok", policy: "ok", drivers: "ok", reconciliation: "ok" }, privatePayload: "private-canary" }))
      .toEqual({ ready: true, checks: { temporal: "ok", store: "ok", policy: "ok", drivers: "ok", reconciliation: "ok" } });
  });
  it.each([undefined, "unavailable", "unknown", true])("refuses absent or unsuccessful current observation (%s)", reconciliation => {
    expect(() => sanitizePackagedReadiness({ ready: true, checks: { temporal: "ok", store: "ok", policy: "ok", drivers: "ok", reconciliation } })).toThrow("incomplete");
  });
  it("bounds returned schedule metadata and never promotes the old operation to a cloud write", () => {
    const result = { scheduleOwned: true, encryptedInput: true, paused: false, status: "completed", runId: "01234567-0123-4123-8123-0123456789ab", completedAt: 1_791_000_000_000, current: true };
    expect(sanitizeTemporalControlEvidence("observe", { ...result, password: "private-canary", cloudWritesProven: true })).toEqual(result);
    expect(JSON.stringify(sanitizeTemporalControlEvidence("observe", { ...result, privatePayload: "private-canary" }))).not.toContain("private-canary");
  });
  it.each([
    { scheduleOwned: false }, { encryptedInput: false }, { runId: "private-canary" }, { completedAt: "private-canary" },
    { status: "deferred", current: true }, { paused: true, current: true }, { status: "unconfirmed" },
  ])("refuses damaged schedule evidence (%j)", change => {
    expect(() => sanitizeTemporalControlEvidence("observe", { scheduleOwned: true, encryptedInput: true, paused: false, status: "completed", runId: "01234567-0123-4123-8123-0123456789ab", completedAt: 1_791_000_000_000, current: true, ...change })).toThrow("unconfirmed");
  });
  it("requires distinct actual observer, claimant and blocker PIDs", () => {
    expect(sanitizePgWaiterEvidence([{ observerPid: 11, waiterPid: 12, blockerPid: 13, query: "private-canary" }])).toEqual({ observerPid: 11, waiterPid: 12, blockerPid: 13 });
  });
  it.each([
    { value: [] }, { value: [{ observerPid: 11, waiterPid: 11, blockerPid: 13 }] },
    { value: [{ observerPid: 11, waiterPid: 12, blockerPid: 12 }] },
    { value: [{ observerPid: 0, waiterPid: 12, blockerPid: 13 }] },
    { value: [{ observerPid: 11, waiterPid: "private-canary", blockerPid: 13 }] },
  ])("refuses missing or ambiguous waiter observations (%j)", ({ value }) => {
    expect(() => sanitizePgWaiterEvidence(value)).toThrow("not confirmed");
  });
  it("scopes the real wait query to its exact disposable database, blocker and schema read", () => {
    const query = schemaOutageObserverSql("zenith-pkg-arm64-0123456789ab");
    expect(query).toContain("b.pid=any(pg_blocking_pids(a.pid))");
    expect(query).toContain("a.pid<>pg_backend_pid()");
    expect(query).toContain("a.datname='zenith_packaged'");
    expect(query).toContain("select version, name, applied_at, checksum from platform.schema_migrations%");
    expect(query).toContain("b.application_name='zenith-pkg-arm64-0123456789ab-schema-outage'");
    expect(() => schemaOutageObserverSql("foreign'; select 1; --")).toThrow("identity is invalid");
  });
  it("uses only image-local authenticated control with a read-only production codec and pinned targets", () => {
    const source = packagedTemporalControlSource();
    expect(source).toContain("process.env.NODE_ENV!=='production'");
    expect(source).toContain("process.env.ZENITH_TEMPORAL_ADDRESS!=='temporal:7233'");
    expect(source).toContain("encode:async()=>{throw new Error();}");
    expect(source).toContain("clientCertPair");
    expect(source).toContain("serverNameOverride:auth==='wrong-server-name'?'unowned.acceptance.invalid':'temporal'");
    expect(source).toContain("getHandle('zenith-reconcile-sweep-v1')");
    expect(source).not.toContain("workflow.start(");
    expect(source).not.toContain("Worker.create(");
  });
  it("prepares actual server client-auth and SAN negatives, current-result recovery and owned cleanup without a TLS bypass", () => {
    const harness = readFileSync(new URL("../../scripts/acceptance/packaged-worker.mjs", import.meta.url), "utf8");
    expect(harness).toContain('for (const auth of ["none", "rogue", "wrong-server-name"])');
    expect(harness).toContain('NODE_ENV: "production"');
    expect(harness).toContain('ZENITH_TEMPORAL_NAMESPACE: runId');
    expect(harness).toContain('ZENITH_WORKER_RECONCILE_SCHEDULE_MODE: "provision"');
    expect(harness).toContain('await observation("completed", previous.runId)');
    expect(harness).toContain('await observation("completed", beforeRestart.runId)');
    expect(harness).toContain('schemaOutageObserverSql(runId)');
    expect(harness).toContain('const PRIVATE_FILE_NAMES = ["ca.crt", "server.crt", "server.key", "server.yaml", "ca.crt", "client.crt", "client.key", "rogue-client.crt", "rogue-client.key"]');
    const receiver = packagedPrivateTransferSource();
    expect(receiver).toContain('{ name: "/server", names: ["ca.crt", "server.crt", "server.key", "server.yaml"] }');
    expect(receiver).toContain('{ name: "/client", names: ["ca.crt", "client.crt", "client.key", "rogue-client.crt", "rogue-client.key"] }');
    const transfer = 'await docker(["exec", "-i", installer, "node", "-e", packagedPrivateTransferSource()], "private-files-transfer", { privateInput: privateFrame })';
    expect(harness).toContain(transfer);
    expect(harness).toContain('custody.out.trim() !== "CUSTODY_VERIFIED"');
    expect(harness.indexOf(transfer)).toBeLessThan(harness.indexOf('const custody = await docker(["exec", installer, "node", "-e", packagedVolumeCustodySource()]'));
    expect(harness).not.toContain('"--tls-disable-host-verification"');
    expect(harness).not.toContain('"--allow-no-auth"');
    expect(harness).not.toContain('"--privileged"');
    expect(harness).not.toContain('type=bind');
    expect(harness).not.toMatch(/docker\s+system\s+prune|builder\s+prune/);
  });
});

async function sourceFixture(run: (source: string, base: string) => Promise<void>): Promise<void> {
  const base = await mkdtemp(path.join(await realpath(os.tmpdir()), "zenith-packaged-source-fixture-"));
  const source = path.join(base, "source");
  try {
    for (const relative of ["docker", "src/lib", "workers/execution", "deploy/aws/ssm-documents", "deploy/slo", "policy/dist"]) {
      await mkdir(path.join(source, relative), { recursive: true });
    }
    for (const relative of ["package.json", "package-lock.json", "tsconfig.json"]) await writeFile(path.join(source, relative), "{}\n");
    await writeFile(path.join(source, "deploy/slo/slo-definitions.json"), "{}\n");
    await writeFile(path.join(source, ".dockerignore"), ".git\n.env*\n");
    await writeFile(path.join(source, "docker/worker.Dockerfile"), [
      "FROM fixture AS build", "COPY package.json package-lock.json ./", "COPY tsconfig.json ./",
      "COPY src/lib ./src/lib", "COPY workers/execution ./workers/execution",
      "COPY deploy/aws/ssm-documents ./deploy/aws/ssm-documents", "COPY deploy/slo/slo-definitions.json ./deploy/slo/slo-definitions.json", "FROM fixture AS runtime",
      "COPY --from=build /app/dist/execution ./dist/execution", "COPY --chown=zenith:zenith policy/dist ./policy/dist", "",
    ].join("\n"));
    await run(source, base);
  } finally { await rm(base, { recursive: true, force: true }); }
}

describe("private packaged acceptance storage", () => {
  it("admits canonical outside-source storage with private permissions", async () => {
    await sourceFixture(async (source, base) => {
      const scratch = await createPrivateScratch(source, base, "private-scratch-");
      expect(path.dirname(scratch)).toBe(await realpath(base));
      expect((await lstat(scratch)).mode & 0o777).toBe(0o700);
      expect(await readdir(scratch)).toEqual([]);
    });
  });
  it.each(["source", "descendant", "source-alias", "descendant-alias"])("refuses %s temp placement before creating a secret directory", async (kind) => {
    await sourceFixture(async (source, base) => {
      const nested = path.join(source, "src/lib/tmp");
      await mkdir(nested);
      const direct = kind.startsWith("source") ? source : nested;
      const location = kind.endsWith("alias") ? path.join(base, "temporary-alias") : direct;
      if (kind.endsWith("alias")) await symlink(direct, location);
      const before = await readdir(direct);
      await expect(createPrivateScratch(source, location, "secret-scratch-")).rejects.toThrow("outside the source tree");
      expect(await readdir(direct)).toEqual(before);
    });
  });
  it("resolves a source alias before deciding whether a temporary base is external", async () => {
    await sourceFixture(async (source, base) => {
      const alias = path.join(base, "source-alias");
      await symlink(source, alias);
      await expect(privateTemporaryBase(alias, path.join(source, "src/lib"))).rejects.toThrow("outside the source tree");
    });
  });
  it("uses the same guard for runtime secrets and private diagnostics before generating keys or calling Docker", () => {
    const harness = readFileSync(new URL("../../scripts/acceptance/packaged-worker.mjs", import.meta.url), "utf8");
    const main = harness.slice(harness.indexOf("export async function packagedWorkerMain("));
    const guard = main.indexOf("const scratch = await createPrivateScratch(");
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(main.indexOf('generateKeyPairSync("ed25519")'));
    expect(guard).toBeLessThan(main.indexOf('await writeFile(envFile'));
    expect(guard).toBeLessThan(main.indexOf('await docker(["build"'));
    expect(main).toContain('directory = await createPrivateScratch(process.cwd(), os.tmpdir(), `${runId}-diagnostics-`)');
  });
});

describe("actual packaged COPY input binding", () => {
  it("includes a Git-ignored imported module copied by Docker", async () => {
    await sourceFixture(async (source) => {
      await writeFile(path.join(source, ".gitignore"), "src/lib/ignored-module.ts\n");
      await writeFile(path.join(source, "workers/execution/entrypoint.ts"), 'import "../../src/lib/ignored-module";\n');
      const ignored = path.join(source, "src/lib/ignored-module.ts");
      await writeFile(ignored, "export const observed = 1;\n");
      const before = await packagedSourceDigest(source);
      await writeFile(ignored, "export const observed = 2;\n");
      expect(await packagedSourceDigest(source)).not.toBe(before);
    });
  });
  it.each([".dockerignore", "docker/worker.Dockerfile.dockerignore", "docker/worker.Dockerfile"])("binds changes to %s", async (relative) => {
    await sourceFixture(async (source) => {
      const before = await packagedSourceDigest(source);
      const filename = path.join(source, relative);
      const content = relative.endsWith("Dockerfile") ? readFileSync(filename, "utf8") + "# changed context recipe\n" : "src/lib/ignored-module.ts\n";
      await writeFile(filename, content);
      expect(await packagedSourceDigest(source)).not.toBe(before);
    });
  });
  it("rejects new COPY authority outside the bound root inventory", async () => {
    await sourceFixture(async (source) => {
      const filename = path.join(source, "docker/worker.Dockerfile");
      await writeFile(filename, readFileSync(filename, "utf8") + "COPY additional-source ./extra\n");
      await expect(packagedSourceDigest(source)).rejects.toThrow("COPY inventory differs");
    });
  });
  it("rejects ADD authority absent from the bound inventory", async () => {
    await sourceFixture(async (source) => {
      const filename = path.join(source, "docker/worker.Dockerfile");
      await writeFile(filename, readFileSync(filename, "utf8") + "ADD additional-source ./extra\n");
      await expect(packagedSourceDigest(source)).rejects.toThrow("ADD inputs are not bound");
    });
  });
  it.each(["file", "directory", "ancestor", "context-control"])("rejects a copied %s symlink rather than claiming full source binding", async (kind) => {
    await sourceFixture(async (source, base) => {
      const outside = path.join(base, "outside-input");
      await mkdir(outside);
      await writeFile(path.join(outside, "module.ts"), "export const observed = 1;\n");
      const link = kind === "file" ? path.join(source, "src/lib/module.ts")
        : kind === "directory" ? path.join(source, "src/lib/alias")
          : kind === "ancestor" ? path.join(source, "src") : path.join(source, ".dockerignore");
      if (kind === "ancestor" || kind === "context-control") await rm(link, { recursive: true, force: true });
      await symlink(kind === "file" || kind === "context-control" ? path.join(outside, "module.ts") : outside, link);
      await expect(packagedSourceDigest(source)).rejects.toThrow("cannot contain symlinks");
    });
  });
  it("rejects missing inputs and directory-shaped package controls", async () => {
    await sourceFixture(async (source) => {
      const filename = path.join(source, "package-lock.json");
      await rm(filename);
      await expect(packagedSourceDigest(source)).rejects.toThrow();
      await mkdir(filename);
      await expect(packagedSourceDigest(source)).rejects.toThrow("controls must be regular files");
    });
  });
  it("binds copied file permissions as well as content", async () => {
    await sourceFixture(async (source) => {
      const filename = path.join(source, "src/lib/helper.sh");
      await writeFile(filename, "exit 0\n", { mode: 0o600 });
      const before = await packagedSourceDigest(source);
      await chmod(filename, 0o700);
      expect(await packagedSourceDigest(source)).not.toBe(before);
    });
  });
  it("fails changed build inputs and accepts an unchanged capture", async () => {
    await sourceFixture(async (source) => {
      const before = await packagedSourceDigest(source);
      expect(() => assertPackagedSourceUnchanged(before, before)).not.toThrow();
      await writeFile(path.join(source, "src/lib/during-build.ts"), "export const changed = true;\n");
      const after = await packagedSourceDigest(source);
      expect(() => assertPackagedSourceUnchanged(before, after)).toThrow("changed during the fresh image build");
    });
  });
  it("checks live context binding after build and before services without claiming an immutable snapshot", () => {
    const harness = readFileSync(new URL("../../scripts/acceptance/packaged-worker.mjs", import.meta.url), "utf8");
    const main = harness.slice(harness.indexOf("export async function packagedWorkerMain("));
    const before = main.indexOf("evidence.sourceInputSha256 = await packagedSourceDigest(");
    const build = main.indexOf('await docker(["build"');
    const after = main.indexOf("assertPackagedSourceUnchanged(evidence.sourceInputSha256, await packagedSourceDigest(");
    expect(before).toBeGreaterThan(0);
    expect(before).toBeLessThan(build);
    expect(build).toBeLessThan(after);
    expect(after).toBeLessThan(main.indexOf('phase = "isolated-services"'));
    expect(main).toContain("immutableBuildContext: false");
  });
});

describe("packaged worker acceptance safety", () => {
  const lockedFixture = (): { packages: Record<string, { version: string; privatePayload: string }>; privatePayload: string } => ({ packages: Object.fromEntries(["@temporalio/worker", "@temporalio/client", "postgres", "jose"].map((name) => [
    `node_modules/${name}`, { version: "1.2.3", privatePayload: "private-canary" },
  ])), privatePayload: "private-canary" });
  it("exports only the fixed admitted locked versions, dropping all extra payloads", () => {
    const lock = lockedFixture();
    lock.packages["node_modules/untrusted-extra"] = { version: "private-canary", privatePayload: "private-canary" };
    const evidence = sanitizeLockedDependencies(lock);
    expect(evidence).toEqual({ "@temporalio/worker": "1.2.3", "@temporalio/client": "1.2.3", postgres: "1.2.3", jose: "1.2.3" });
    expect(JSON.stringify(evidence)).not.toContain("private-canary");
  });
  const taintedVersions: { tainted: unknown }[] = ["private-canary", "1.2.3\nprivate-canary", "1.2.3\n", { privatePayload: "private-canary" }, ["private-canary"], null].map((tainted) => ({ tainted }));
  it.each(taintedVersions)("rejects a tainted locked version without publishing a partial result ($tainted)", ({ tainted }) => {
    const lock = lockedFixture();
    const packages: Record<string, unknown> = { ...lock.packages, "node_modules/jose": { version: tainted } };
    const evidence: { lockedDependencies?: Record<string, string> } = {};
    expect(() => { evidence.lockedDependencies = sanitizeLockedDependencies({ ...lock, packages }); }).toThrow("trusted schema");
    expect(evidence).toEqual({});
    try { sanitizeLockedDependencies({ ...lock, packages }); }
    catch (error) { expect(String(error)).not.toContain("private-canary"); }
  });
  it.each([{}, { packages: null }, { packages: [] }, { packages: {} }])("rejects malformed or incomplete locked dependency evidence (%j)", (lock) => {
    expect(() => sanitizeLockedDependencies(lock)).toThrow("trusted schema");
  });
  it("admits only a fixed SHA-256 Docker image identifier", () => {
    const id = `sha256:${"a".repeat(64)}`;
    expect(sanitizeImageId(id)).toBe(id);
  });
  const taintedImageIds: { id: unknown }[] = ["private-canary", `sha256:${"a".repeat(63)}`, `sha256:${"A".repeat(64)}`, `sha256:${"a".repeat(64)}\nprivate-canary`, `sha256:${"a".repeat(64)}\n`, { Id: "private-canary" }, null].map((id) => ({ id }));
  it.each(taintedImageIds)("rejects tainted image identifiers before evidence assignment ($id)", ({ id }) => {
    const evidence: { image?: { id: string } } = {};
    expect(() => { evidence.image = { id: sanitizeImageId(id) }; }).toThrow("trusted schema");
    expect(evidence).toEqual({});
    try { sanitizeImageId(id); }
    catch (error) { expect(String(error)).not.toContain("private-canary"); }
  });
  it("requires explicit opt-in before parsing a platform or starting resources", () => {
    expect(() => parsePackagedArgs(["--platform", "linux/arm64"], {})).toThrow("Explicit");
  });
  it.each(["linux/amd64", "linux/arm64"])("accepts the explicit supported architecture %s", (platform) => {
    expect(parsePackagedArgs(["--platform", platform], { ZENITH_PACKAGED_WORKER_ACCEPTANCE: "1" })).toEqual({ platform });
  });
  it.each([{ args: [] }, { args: ["--platform", "linux/386"] }, { args: ["--platform", "linux/arm64", "--reuse"] }, { args: ["--host", "localhost"] }])(
    "refuses unsupported or ambiguous arguments ($args)", ({ args }) => {
      expect(() => parsePackagedArgs(args, { ZENITH_PACKAGED_WORKER_ACCEPTANCE: "1" })).toThrow("Usage");
    }
  );
  it("accepts only the disclosed disposable target configuration", () => {
    expect(() => assertPackagedAcceptanceTarget(env)).not.toThrow();
  });
  it.each([
    { ZENITH_PACKAGED_ACCEPTANCE: "0" }, { ZENITH_STORE: "postgres" }, { ZENITH_DATA: "/existing-user-data" },
    { ZENITH_WORKER_PLAN_DIR: "/existing-plan-files" }, { ZENITH_TEMPORAL_ADDRESS: "localhost:7233" },
    { ZENITH_PLATFORM_DB_URL: "postgresql://postgres:private-fixture-password@db.example.test:5432/zenith_packaged" },
    { ZENITH_PLATFORM_DB_URL: "postgresql://postgres:private-fixture-password@postgres:5432/existing" },
    { ZENITH_PLATFORM_DB_URL: "postgresql://postgres:private-fixture-password@postgres:5432/zenith_packaged?host=db.example.test" },
    { ZENITH_PLATFORM_DB_URL: "private-fixture-password-invalid-url" },
  ])("refuses shared/wrong targets without echoing their values (%j)", (changed) => {
    try { assertPackagedAcceptanceTarget({ ...env, ...changed }); throw new Error("Expected refusal"); }
    catch (error) {
      expect((error as Error).message).toContain("isolated disposable");
      expect((error as Error).message).not.toContain("private-fixture-password");
      expect((error as Error).message).not.toContain("db.example.test");
    }
  });
  it("drops unrecognized client evidence fields instead of emitting them", () => {
    expect(sanitizeClientEvidence("prepare", { prepared: true, appliedVersions: [1, 2], productStore: "isolated-file-fixture",
      platformStore: "postgres", password: "do-not-log", sql: "do-not-log" })).toEqual({ prepared: true, appliedVersions: [1, 2],
      productStore: "isolated-file-fixture", platformStore: "postgres" });
  });
  it("rejects arbitrary strings disguised as validated evidence", () => {
    expect(() => sanitizeClientEvidence("prepare", { prepared: true, appliedVersions: ["private-password"],
      productStore: "isolated-file-fixture", platformStore: "postgres" })).toThrow("trusted schema");
    expect(() => sanitizeClientEvidence("assets", { uid: 10001, arch: "arm64", node: "private-password" })).toThrow("trusted schema");
  });
  it("admits exact plan storage evidence and refuses any other mode, owner or retention claim", () => {
    const hexDigest = "e".repeat(64);
    const assets = { uid: 10001, arch: "x64", node: "v22.23.3", tofu: ["OpenTofu v1.12.5", "on linux_amd64"], policySha256: hexDigest,
      ssmDocuments: { count: 12, sha256: hexDigest }, dependencies: { "@temporalio/worker": "1.2.3", "@temporalio/client": "1.2.3", postgres: "3.4.5", jose: "5.6.7" },
      plans: { logicallyExpired: true, ciphertextRetained: true, terminalRetained: true, encryptedLifecycleFixture: true, activeRetained: true, unownedRetained: true, sentinelFiles: true },
      planStorage: { dirMode: "700", fileModes: ["600", "600", "600"], owner: 10001, retainedKept: true } };
    expect(sanitizeClientEvidence("assets", assets)?.planStorage).toEqual({ dirMode: "700", fileModes: ["600", "600", "600"], owner: 10001, retainedKept: true });
    expect(() => sanitizeClientEvidence("assets", { ...assets, planStorage: { ...assets.planStorage, dirMode: "755" } })).toThrow("trusted schema");
    expect(() => sanitizeClientEvidence("assets", { ...assets, planStorage: { ...assets.planStorage, fileModes: ["600", "644", "600"] } })).toThrow("trusted schema");
    expect(() => sanitizeClientEvidence("assets", { ...assets, planStorage: { ...assets.planStorage, owner: 0 } })).toThrow("trusted schema");
    expect(() => sanitizeClientEvidence("assets", { ...assets, planStorage: { ...assets.planStorage, retainedKept: false } })).toThrow("trusted schema");
    expect(() => sanitizeClientEvidence("assets", { ...assets, planStorage: undefined })).toThrow("trusted schema");
  });
  it("never promotes cloud-write or successful-operation claims from the scoped read fixture", () => {
    expect(() => sanitizeClientEvidence("operations", { reconcile: { status: "observed", drift: 0, unknown: 0 },
      operation: { workflowStatus: "succeeded" }, cloudWritesProven: true })).toThrow("trusted schema");
  });
  it("hashes deploy/aws SSM documents as the packaged client hashes the TypeScript module", async () => {
    const { ZENITH_SSM_DOCUMENTS } = await import("../../src/lib/machines/transports/aws-ssm-docs");
    expect(await ssmDocumentsDigest()).toEqual({ count: 12, sha256: createHash("sha256").update(JSON.stringify(ZENITH_SSM_DOCUMENTS)).digest("hex") });
  });
  it("changes the host SSM digest when any source document changes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zenith-ssm-digest-"));
    try {
      const source = "deploy/aws/ssm-documents";
      await mkdir(path.join(root, source), { recursive: true });
      for (const file of await readdir(source)) await writeFile(path.join(root, source, file), readFileSync(path.join(source, file)));
      const original = await ssmDocumentsDigest(root);
      await writeFile(path.join(root, source, "Zenith-DnsCheck.json"), "{}");
      expect((await ssmDocumentsDigest(root)).sha256).not.toBe(original.sha256);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("whitelists runtime filesystem evidence and rejects loose values", () => {
    const ok = { readonlyRootfs: true, capDropAll: true, noNewPrivileges: true, user: 10001, rootWriteRefused: true, tmpWritable: true };
    expect(sanitizeRuntimeFilesystemEvidence({ ...ok, privatePath: "/var/secret" })).toEqual(ok);
    expect(() => sanitizeRuntimeFilesystemEvidence({ ...ok, user: "10001" })).toThrow("trusted schema");
    expect(() => sanitizeRuntimeFilesystemEvidence({ ...ok, readonlyRootfs: "true" })).toThrow("trusted schema");
    expect(() => sanitizeRuntimeFilesystemEvidence(undefined)).toThrow("trusted schema");
  });
  it("distinguishes a refused root write from a writable tmpfs probe", async () => {
    const result = await command(process.execPath, ["-e", runtimeFilesystemProbeSource()], "runtime-probe-fixture");
    const probe = JSON.parse(result.out.trim());
    expect(probe.tmpWrite).toBe("written");
    expect(probe.rootWrite).not.toBe("written");
  });
  it("suppresses raw child-process errors", async () => {
    await expect(command(process.execPath, ["-e", "console.error('private-password private-sql'); process.exit(1)"], "fixture-phase"))
      .rejects.toThrow("Packaged acceptance phase failed: fixture-phase");
  });
  it.each(["private-tls-tool", "private-tls-ca", "private-tls-leaf", "private-tls-sign", "private-tls-verify"])("exports the fixed private TLS subphase (%s) without raw diagnostic data", phase => {
    const error = new PackagedCommandError(phase, "command-exit", 1);
    Object.assign(error.diagnostic, { output: "private-canary", path: "/private-canary", certificate: "private-canary" });
    Object.assign(error, { message: "private-canary" });
    expect(sanitizePackagedCommandFailure(error)).toEqual({ category: "command-exit", exitCode: 1, signal: null, phase });
    expect(JSON.stringify(sanitizePackagedCommandFailure(error))).not.toContain("private-canary");
  });
  it.each(["missing-schema", "invalid-secret", "invalid-signer", "plaintext-temporal", "missing-namespace", "wrong-queue"])("retains all three fixed refusal command subphases (%s)", kind => {
    for (const step of ["launch", "exit", "logs"]) {
      const phase = `refusal-${step}-${kind}`;
      expect(sanitizePackagedCommandFailure(new PackagedCommandError(phase, "command-exit", 1)))
        .toEqual({ category: "command-exit", exitCode: 1, signal: null, phase });
    }
  });
  it.each(["private-tls-tool-private-canary", "/private-canary", "private-tls-copy", "private-volume-custody-private-canary"])("omits every unrecognized command phase (%s)", phase => {
    expect(sanitizePackagedCommandFailure(new PackagedCommandError(phase, "command-exit", 23)))
      .toEqual({ category: "command-exit", exitCode: 23, signal: null });
  });
  it.each(["private-installer-start", "private-server-copy", "private-client-copy", "private-volume-custody", "private-installer-stop"])("exports only the fixed initializer subphase (%s)", phase => {
    const error = new PackagedCommandError(phase, "command-exit", 1);
    Object.assign(error.diagnostic, { output: "private-canary", path: "/private-canary", certificate: "private-canary" });
    expect(sanitizePackagedCommandFailure(error)).toEqual({ category: "command-exit", exitCode: 1, signal: null, phase });
  });
  it.each(["command-launch", "command-timeout", "command-output-limit", "command-exit", "command-signal"] as const)("retains a fixed command category (%s)", category => {
    expect(sanitizePackagedCommandFailure(new PackagedCommandError("private-tls-tool", category, null, "SIGKILL")))
      .toEqual({ category, exitCode: null, signal: "SIGKILL", phase: "private-tls-tool" });
  });
  it("refuses a generic error or a damaged command category instead of exporting its payload", () => {
    expect(sanitizePackagedCommandFailure(new Error("private-canary"))).toBeUndefined();
    const error = new PackagedCommandError("private-tls-tool", "command-exit", 1);
    Object.assign(error.diagnostic, { category: "private-canary", output: "private-canary" });
    expect(sanitizePackagedCommandFailure(error)).toBeUndefined();
  });
  it.each([NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "private-canary"])("drops damaged command scalar data (%s)", exitCode => {
    const error = new PackagedCommandError("private-tls-tool", "command-exit", 1);
    Object.assign(error.diagnostic, { exitCode, signal: "private-canary" });
    expect(sanitizePackagedCommandFailure(error))
      .toEqual({ category: "command-exit", exitCode: null, signal: null, phase: "private-tls-tool" });
  });
  it("preserves a failed TLS tool admission and exports only its fixed phase", async () => {
    const temporary = await mkdtemp(path.join(await realpath(os.tmpdir()), "zenith-tls-diagnostic-contract-"));
    let calls = 0;
    try {
      await chmod(temporary, 0o700);
      try {
        await prepareTemporalTls(temporary, async (_binary, _args, phase) => {
          calls++;
          expect(phase).toBe("private-tls-tool");
          throw new PackagedCommandError(phase, "command-exit", 1);
        });
        throw new Error("Expected TLS tool failure.");
      } catch (error) {
        expect(sanitizePackagedCommandFailure(error))
          .toEqual({ category: "command-exit", exitCode: 1, signal: null, phase: "private-tls-tool" });
      }
      expect(calls).toBe(1);
      expect(await readdir(temporary)).toEqual([]);
    } finally { await rm(temporary, { recursive: true, force: true }); }
  });
  it("uses a pinned real server and private read-only config, requiring authenticated health before worker startup", () => {
    const harness = readFileSync(new URL("../../scripts/acceptance/packaged-worker.mjs", import.meta.url), "utf8");
    expect(TEMPORAL_CONFIG_DIR).toBe("/etc/zenith-temporal");
    expect(TEMPORAL_IMAGE).toMatch(/^temporalio\/server:1\.32\.0@sha256:[a-f0-9]{64}$/);
    expect(TEMPORAL_ADMIN_IMAGE).toMatch(/^temporalio\/admin-tools:1\.32\.0@sha256:[a-f0-9]{64}$/);
    expect(harness).toContain("target=${TEMPORAL_CONFIG_DIR},readonly");
    expect(harness).toContain('"--config-file", `${TEMPORAL_CONFIG_DIR}/server.yaml`, "start"');
    expect(harness).not.toContain('"start-dev"');
    expect(harness).toContain('await control("health", "client", true)');
    expect(harness.indexOf('phase = "temporal-ready"')).toBeLessThan(harness.indexOf('phase = "actual-worker-entrypoint"'));
  });
  it("exports only fixed container state without arbitrary daemon errors or config", () => {
    const value = { Status: "exited", Running: false, ExitCode: 137, OOMKilled: true,
      Error: "private-password", Config: { Env: ["private-key"] } };
    expect(sanitizeContainerState(value)).toEqual({ status: "exited", running: false, exitCode: 137, oomKilled: true });
    expect(sanitizeContainerState({ ...value, Status: "private-password" })).toBeUndefined();
    expect(sanitizeContainerState({ ...value, ExitCode: "private-key" })).toBeUndefined();
    expect(sanitizeContainerState({ ...value, ExitCode: -1 })).toBeUndefined();
  });
  it("identifies only worker-owned, allowlisted startup categories", () => {
    for (const category of EXECUTION_FAILURE_CATEGORIES) {
      const record = { component: "execution-worker", msg: "execution worker failed", failureCategory: category, error: "private-password" };
      expect(workerFailureCategory(`native private-key\n${JSON.stringify(record)}\n`)).toBe(category);
    }
    expect(workerFailureCategory(JSON.stringify({ component: "untrusted", msg: "execution worker failed", failureCategory: "policy-assets" }))).toBe("unavailable");
    expect(workerFailureCategory(JSON.stringify({ component: "execution-worker", msg: "execution worker failed", failureCategory: "private-password" }))).toBe("unavailable");
  });
  it("scrubs every generated credential including overlapping URL/JWK values from private diagnostics", () => {
    const secrets = ["password-canary", "secret-canary", "private-d-canary", "postgresql://user:password-canary@postgres/db", '{"d":"private-d-canary"}'];
    const logs = secrets.join("\n") + "\npermission denied\n";
    const redacted = redactDiagnosticLogs(logs, [...secrets, ""]);
    for (const secret of secrets) expect(redacted).not.toContain(secret);
    expect(redacted).toContain("permission denied");
    expect(redacted).toContain("[REDACTED]");
  });
  it("records a failed command's exact exit with no arbitrary output", async () => {
    try {
      await command(process.execPath, ["-e", "console.error('private-password'); process.exit(23)"], "fixture-phase");
      throw new Error("Expected command failure");
    } catch (error) {
      expect(error).toBeInstanceOf(PackagedCommandError);
      if (!(error instanceof PackagedCommandError)) throw error;
      expect(error.diagnostic).toEqual({ category: "command-exit", exitCode: 23, signal: null });
      expect(JSON.stringify(error.diagnostic)).not.toContain("private-password");
    }
  });
  it("never treats a timeout as an allowed failure result", async () => {
    await expect(command(process.execPath, ["-e", "setInterval(()=>{},1000)"], "fixture-timeout", { timeout: 20, allowFailure: true }))
      .rejects.toMatchObject({ diagnostic: { category: "command-timeout", exitCode: null, signal: "SIGKILL" } });
  });
  it("bounds captured output and fails instead of accumulating a large Docker log", async () => {
    await expect(command(process.execPath, ["-e", "process.stdout.write('x'.repeat(3*1024*1024))"], "output-limit"))
      .rejects.toThrow("Packaged acceptance phase failed: output-limit");
  });
  it("reports incomplete cleanup when a failed build leaves an image but inspection fails before any container exists", async () => {
    const commands: string[][] = [];
    const runId = "zenith-pkg-arm64-fixture";
    const image = `${runId}:acceptance`;
    // Simulate a build that writes its tag before failing; no container/volume
    // cleanup results exist to prevent the former empty-array success claim.
    const runDocker = async (args: string[]) => {
      commands.push(args);
      if (args[0] === "build") throw new Error("Build failed after tagging");
      if (args[1] === "inspect") return { code: 1, out: "" };
      return { code: 0, out: `${image}\n` };
    };
    await expect(runDocker(["build", "--tag", image])).rejects.toThrow("Build failed");
    const cleanup = [await cleanupOwnedImage(image, runId, runDocker)];
    expect(cleanup.every(Boolean)).toBe(false);
    expect(commands.some((args) => args[1] === "rm")).toBe(false);
  });
  it.each(["nonzero", "throw"])("does not report absence when the image inspector and daemon listing fail (%s)", async (failure) => {
    const runDocker = async () => {
      if (failure === "throw") throw new Error("Private daemon details");
      return { code: 1, out: "" };
    };
    expect(await cleanupOwnedImage("fixture:acceptance", "fixture", runDocker)).toBe(false);
  });
  it("establishes absence through a successful empty listing when no image was produced", async () => {
    const commands: string[][] = [];
    const runDocker = async (args: string[]) => {
      commands.push(args);
      return { code: args[1] === "inspect" ? 1 : 0, out: "" };
    };
    expect(await cleanupOwnedImage("fixture:acceptance", "fixture", runDocker)).toBe(true);
    expect(commands).toEqual([
      ["image", "inspect", "--format", '{{index .Config.Labels "io.zenith.acceptance.run"}}', "fixture:acceptance"],
      ["image", "ls", "--filter", "reference=fixture:acceptance", "--format", "{{.Repository}}:{{.Tag}}"],
      ["image", "ls", "--all", "--quiet", "--no-trunc", "--filter", "label=io.zenith.acceptance.run=fixture"],
    ]);
  });
  it("does not claim cleanup when the tag disappears but an owned dangling image remains", async () => {
    const commands: string[][] = [];
    const runDocker = async (args: string[]) => {
      commands.push(args);
      if (args[1] === "inspect") return { code: 1, out: "" };
      return { code: 0, out: args.includes("--all") ? "sha256:owned-dangling-image\n" : "" };
    };
    expect(await cleanupOwnedResource("image", "fixture:acceptance", "fixture", runDocker))
      .toEqual({ removed: false, outcome: "ownership-unconfirmed", attempts: 0 });
    expect(commands.some((args) => args[1] === "rm")).toBe(false);
    expect(commands.filter((args) => args.includes("--all"))).toHaveLength(2);
  });
  it.each(["nonzero", "throw"])("requires a successful owned image inventory after tag removal (%s)", async (failure) => {
    const runDocker = async (args: string[]) => {
      if (args[1] === "inspect") return { code: 0, out: "fixture\n" };
      if (args.includes("--all")) {
        if (failure === "throw") throw new Error("Private daemon details");
        return { code: 1, out: "" };
      }
      return { code: 0, out: "" };
    };
    expect(await cleanupOwnedResource("image", "fixture:acceptance", "fixture", runDocker))
      .toEqual({ removed: false, outcome: "absence-unconfirmed", attempts: 2 });
  });
  it("only removes its exact labeled tag and independently verifies absence", async () => {
    const commands: string[][] = [];
    const runDocker = async (args: string[]) => {
      commands.push(args);
      return { code: 0, out: args[1] === "inspect" ? "fixture\n" : "" };
    };
    expect(await cleanupOwnedImage("fixture:acceptance", "fixture", runDocker)).toBe(true);
    expect(commands.filter((args) => args[1] === "rm")).toEqual([["image", "rm", "fixture:acceptance"]]);
    expect(commands.at(-1)?.slice(0, 2)).toEqual(["image", "ls"]);
  });
  it("leaves an image with another run's label untouched and reports incomplete cleanup", async () => {
    const commands: string[][] = [];
    const runDocker = async (args: string[]) => { commands.push(args); return { code: 0, out: "another-run\n" }; };
    expect(await cleanupOwnedImage("fixture:acceptance", "fixture", runDocker)).toBe(false);
    expect(commands).toHaveLength(1);
  });
  it.each(["delete-failed", "still-listed", "list-failed"])("does not report removed images without complete evidence (%s)", async (failure) => {
    const runDocker = async (args: string[]) => {
      if (args[1] === "inspect") return { code: 0, out: "fixture\n" };
      if (args[1] === "rm") return { code: failure === "delete-failed" ? 1 : 0, out: "" };
      return { code: failure === "list-failed" ? 1 : 0, out: failure === "list-failed" ? "" : "fixture:acceptance\n" };
    };
    expect(await cleanupOwnedImage("fixture:acceptance", "fixture", runDocker)).toBe(false);
  });
});

describe("packaged refusal exit proof", () => {
  const runId = "zenith-pkg-amd64-fixture";
  const name = `${runId}-missing-schema`;
  const state = (Status = "exited", ExitCode = 1, OOMKilled = false, owner = runId) => ({
    Config: { Labels: { "io.zenith.acceptance.run": owner } }, State: { Status, Running: Status === "running", ExitCode, OOMKilled },
  });
  const failureLog = (failureCategory: string, component = "execution-worker") => JSON.stringify({ component, msg: "execution worker failed", failureCategory });

  it("waits through created/running state for the actual owned worker exit", async () => {
    const snapshots = [state("created", 0), state("running", 0), state()];
    const commands: string[][] = []; let elapsed = 0;
    const runDocker = async (args: string[]) => { commands.push(args); return { code: 0, out: JSON.stringify(snapshots.shift()) }; };
    expect(await waitForRefusalExit(name, runId, runDocker, { now: () => elapsed, wait: async (ms: number) => { elapsed += ms; } }))
      .toEqual({ status: "exited", running: false, exitCode: 1, oomKilled: false });
    expect(commands).toHaveLength(3);
    expect(commands.every((args) => args[0] === "inspect" && args.at(-1) === name)).toBe(true);
    expect(elapsed).toBe(500);
  });
  it.each([{ code: 0, oom: false }, { code: 137, oom: false }, { code: 1, oom: true }])(
    "rejects the wrong exit or an OOM ($code/$oom)", async ({ code, oom }) => {
      const runDocker = async () => ({ code: 0, out: JSON.stringify(state("exited", code, oom)) });
      await expect(waitForRefusalExit(name, runId, runDocker)).rejects.toThrow("required worker exit");
    }
  );
  it("refuses another run's container before interpreting its exit", async () => {
    const runDocker = async () => ({ code: 0, out: JSON.stringify(state("exited", 1, false, "another-run")) });
    await expect(waitForRefusalExit(name, runId, runDocker)).rejects.toThrow("ownership did not match");
  });
  it.each(["inspect-failed", "malformed-state", "dead"])("does not invent refusal proof from %s", async (failure) => {
    const runDocker = async () => ({ code: failure === "inspect-failed" ? 1 : 0,
      out: JSON.stringify(failure === "malformed-state" ? { ...state(), State: { Status: "private-canary" } } : state("dead", 1)) });
    await expect(waitForRefusalExit(name, runId, runDocker)).rejects.toThrow(/could not be inspected|state was unavailable|without a verified worker exit/);
  });
  it("fails the bounded observation window without claiming a worker signal or exit", async () => {
    let elapsed = 0;
    const runDocker = async () => ({ code: 0, out: JSON.stringify(state("created", 0)) });
    await expect(waitForRefusalExit(name, runId, runDocker, { timeout: 500, now: () => elapsed, wait: async (ms: number) => { elapsed += ms; }, phase: "refusal-exit-missing-schema" }))
      .rejects.toMatchObject({ diagnostic: { category: "command-timeout", exitCode: null, signal: null } });
    expect(elapsed).toBe(500);
  });
  it("does not accept an exit observation returned after its deadline", async () => {
    let elapsed = 0;
    const runDocker = async () => { elapsed = 501; return { code: 0, out: JSON.stringify(state()) }; };
    await expect(waitForRefusalExit(name, runId, runDocker, { timeout: 500, now: () => elapsed }))
      .rejects.toMatchObject({ diagnostic: { category: "command-timeout", exitCode: null, signal: null } });
  });
  it.each(["command-timeout", "command-signal", "command-output-limit"] as const)("never accepts a Docker %s as the worker refusal", async (category) => {
    const runDocker = async () => { throw new PackagedCommandError("refusal-exit-missing-schema", category, null, category === "command-signal" ? "SIGTERM" : null); };
    await expect(waitForRefusalExit(name, runId, runDocker)).rejects.toMatchObject({ diagnostic: { category } });
  });
  it.each(["missing-schema", "invalid-secret", "invalid-signer"])("accepts only the expected worker-owned category and secret-free output (%s)", (kind) => {
    const category = kind === "missing-schema" ? "platform-store" : "configuration";
    expect(refusalFailureCategory(kind, failureLog(category), ["private-canary"])).toBe(category);
    expect(() => refusalFailureCategory(kind, failureLog("module-load"), [])).toThrow("category did not match");
    expect(() => refusalFailureCategory(kind, failureLog(category, "untrusted"), [])).toThrow("category did not match");
    expect(() => refusalFailureCategory(kind, failureLog(category) + "\nprivate-canary", ["private-canary"])).toThrow("secret material");
  });
});

describe("owned resource cleanup proof", () => {
  const runId = "zenith-pkg-amd64-fixture";
  const name = `${runId}-missing-schema`;
  it("confirms absence after the removal CLI times out, without another removal", async () => {
    const commands: string[][] = [];
    const runDocker = async (args: string[]) => {
      commands.push(args);
      if (args[0] === "inspect") return { code: 0, out: runId };
      if (args[0] === "rm") throw new PackagedCommandError("cleanup", "command-timeout", null, "SIGKILL");
      return { code: 0, out: "" };
    };
    expect(await cleanupOwnedResource("container", name, runId, runDocker)).toEqual({ removed: true, outcome: "absent-after-timeout", attempts: 1 });
    expect(commands.filter((args) => args[0] === "rm")).toEqual([["rm", "-f", name]]);
    expect(commands.at(-1)).toEqual(["ps", "-aq", "--filter", `name=^/${name}$`]);
  });
  it("rechecks ownership before the second bounded removal attempt", async () => {
    let removes = 0; let inspections = 0;
    const runDocker = async (args: string[]) => {
      if (args[0] === "inspect") { inspections++; return { code: 0, out: runId }; }
      if (args[0] === "rm") { removes++; return { code: removes === 1 ? 1 : 0, out: "" }; }
      return { code: 0, out: args[0] === "ps" && removes === 1 ? "owned-id" : "" };
    };
    expect(await cleanupOwnedResource("container", name, runId, runDocker)).toEqual({ removed: true, outcome: "removed", attempts: 2 });
    expect(removes).toBe(2); expect(inspections).toBe(2);
  });
  it("distinguishes a failed removal response from a verified successful removal response", async () => {
    const runDocker = async (args: string[]) => ({ code: args[0] === "rm" ? 1 : 0, out: args[0] === "inspect" ? runId : "" });
    expect(await cleanupOwnedResource("container", name, runId, runDocker)).toEqual({ removed: true, outcome: "absent-after-error", attempts: 1 });
  });
  it("records a persistent removal timeout and does not exceed two attempts", async () => {
    let removes = 0;
    const runDocker = async (args: string[]) => {
      if (args[0] === "inspect") return { code: 0, out: runId };
      if (args[0] === "rm") { removes++; throw new PackagedCommandError("cleanup", "command-timeout"); }
      return { code: 0, out: args[0] === "ps" ? "still-present-id" : "" };
    };
    expect(await cleanupOwnedResource("container", name, runId, runDocker)).toEqual({ removed: false, outcome: "remove-timeout", attempts: 2 });
    expect(removes).toBe(2);
  });
  it("stops if ownership changes between attempts", async () => {
    let inspections = 0; let removes = 0;
    const runDocker = async (args: string[]) => {
      if (args[0] === "inspect") return { code: 0, out: ++inspections === 1 ? runId : "different-run" };
      if (args[0] === "rm") removes++;
      return { code: 0, out: args[0] === "ps" ? "present-id" : "" };
    };
    expect(await cleanupOwnedResource("container", name, runId, runDocker)).toEqual({ removed: false, outcome: "label-mismatch", attempts: 1 });
    expect(removes).toBe(1);
  });
  it.each(["container", "volume", "network", "image"] as const)("never removes a %s whose ownership cannot be inspected", async (kind) => {
    const commands: string[][] = [];
    const runDocker = async (args: string[]) => {
      commands.push(args);
      return { code: args.includes("inspect") ? 1 : 0, out: args.includes("inspect") ? "" : "present-owned-name" };
    };
    expect(await cleanupOwnedResource(kind, name, runId, runDocker)).toEqual({ removed: false, outcome: "ownership-unconfirmed", attempts: 0 });
    expect(commands.some((args) => args.includes("rm"))).toBe(false);
  });
  it("records incomplete cleanup after exactly two attempts if the resource remains", async () => {
    let removes = 0;
    const runDocker = async (args: string[]) => {
      if (args[0] === "inspect") return { code: 0, out: runId };
      if (args[0] === "rm") removes++;
      return { code: 0, out: args[0] === "ps" ? "still-present-id" : "" };
    };
    expect(await cleanupOwnedResource("container", name, runId, runDocker)).toEqual({ removed: false, outcome: "still-present", attempts: 2 });
    expect(removes).toBe(2);
  });
  it("does not accept failed absence listings after removal", async () => {
    const runDocker = async (args: string[]) => ({ code: args[0] === "ps" ? 1 : 0, out: args[0] === "inspect" ? runId : "" });
    expect(await cleanupOwnedResource("container", name, runId, runDocker)).toEqual({ removed: false, outcome: "absence-unconfirmed", attempts: 2 });
  });
});

describe("packaged Temporal controller [actual Node ESM linkage; no transport]", () => {
  function lockedControllerSource(): string {
    const lock = JSON.parse(readFileSync(new URL("../../package-lock.json", import.meta.url), "utf8"));
    for (const name of ["@temporalio/client", "@temporalio/common", "@temporalio/proto"]) {
      const installed = JSON.parse(readFileSync(new URL(`../../node_modules/${name}/package.json`, import.meta.url), "utf8"));
      expect(installed.version).toBe(lock.packages[`node_modules/${name}`].version);
    }
    // ESM imports link before these fixture statements execute. The unchanged
    // controller guard then refuses before reading credentials or connecting.
    return "process.env.NODE_ENV='module-linkage-fixture';process.env.ZENITH_TEMPORAL_ADDRESS='module-linkage.invalid';delete process.env.ZENITH_TEMPORAL_NAMESPACE;\n"
      + packagedTemporalControlSource();
  }
  it("links every generated controller import against the actual locked packages before the unchanged environment refusal", async () => {
    const result = await command(process.execPath, ["--input-type=module", "-e", lockedControllerSource(), "health", "client"],
      "temporal-control-health", { timeout: 10_000, allowFailure: true });
    expect(result).toEqual({ code: 1, out: "", err: "Packaged authenticated Temporal control failed.\n" });
  }, 15_000);
  it("the previous named protobuf import fails actual Node linkage before the controller can read credentials or connect", async () => {
    const source = lockedControllerSource().replace("import temporalProto from '@temporalio/proto';\nconst { temporal } = temporalProto;",
      "import { temporal } from '@temporalio/proto';");
    const result = await command(process.execPath, ["--input-type=module", "-e", source, "health", "client"],
      "temporal-control-health", { timeout: 10_000, allowFailure: true });
    expect(result.code).toBe(1); expect(result.out).toBe("");
    expect(result.err).toContain("SyntaxError"); expect(result.err).toContain("Named export 'temporal' not found");
    expect(result.err).toContain("@temporalio/proto");
    expect(result.err).not.toContain("Packaged authenticated Temporal control failed.");
  }, 15_000);
});

describe("packaged in-flight fixed failure diagnostics [scalar models; no services]", () => {
  const guards = [
    ["Local shutdown authority readback is unconfirmed.", "shutdown-authority-unconfirmed"],
    ["Owned in-flight worker is unconfirmed.", "owned-worker-unconfirmed"],
    ["Owned worker address is invalid.", "owned-worker-address-invalid"],
    ["Owned schema outage identity is invalid.", "schema-observer-identity-invalid"],
    ["Owned shutdown blocker was not confirmed.", "shutdown-blocker-unconfirmed"],
    ["Actual in-flight schema waiter was not confirmed.", "inflight-schema-waiter-unconfirmed"],
    ["Actual schema waiter was not confirmed.", "schema-waiter-evidence-unconfirmed"],
    ["Packaged Temporal control evidence is unconfirmed.", "temporal-control-evidence-unconfirmed"],
    ["Packaged in-flight sweep evidence is unconfirmed.", "inflight-sweep-evidence-unconfirmed"],
    ["A fresh started sweep was not confirmed.", "fresh-started-sweep-unconfirmed"],
    ["Worker drain did not begin.", "worker-drain-not-started"],
    ["The same started activity and held SQL boundary were not retained during drain.", "held-drain-boundary-changed"],
    ["In-flight packaged worker did not drain cleanly.", "inflight-worker-drain-unconfirmed"],
    ["Worker lifecycle logs contained secret material.", "worker-lifecycle-output-refused"],
    ["Existing local authority changed across the held activity drain.", "shutdown-authority-changed"],
    ["Fresh packaged worker did not restore readiness.", "fresh-worker-readiness-unconfirmed"],
    ["Worker readiness evidence is incomplete.", "worker-readiness-evidence-incomplete"],
    ["A fresh owned schedule result was not confirmed.", "fresh-schedule-result-unconfirmed"],
    ["Recovery reused the held sweep instead of a fresh pass.", "fresh-worker-sweep-reused"],
    ["Existing local authority changed across fresh-worker recovery.", "recovery-authority-changed"],
  ] as const;
  it.each(guards)("exports only the fixed category for existing guard %s", (message, category) => {
    const error = new Error(message);
    Object.assign(error, { stack: "private-canary", output: "private-canary", sql: "private-canary", password: "private-canary" });
    for (const phase of ["inflight-schema-shutdown", "inflight-fresh-worker-recovery"]) {
      expect(sanitizePackagedInFlightFailure(phase, error)).toEqual({ category });
      expect(JSON.stringify(sanitizePackagedInFlightFailure(phase, error))).not.toContain("private-canary");
    }
    expect(sanitizePackagedInFlightFailure("operator-pause", error)).toBeUndefined();
    for (const changed of [`${message} private-canary`, `private-canary ${message}`, `${message}\nprivate-canary`, ` ${message}`]) {
      expect(sanitizePackagedInFlightFailure("inflight-schema-shutdown", new Error(changed))).toBeUndefined();
    }
  });
  it("leaves unknown, non-error, inherited and accessor messages absent without evaluating private getters", () => {
    let reads = 0;
    const accessor = new Error("private-canary");
    Object.defineProperty(accessor, "message", { get: () => { reads++; throw new Error("private-canary"); } });
    for (const error of [undefined, null, "private-canary", { message: guards[0][0] }, Object.create(Error.prototype), accessor,
      new Error("private-canary"), new Error(), new PackagedCommandError("temporal-control-activity", "command-exit", 1)]) {
      expect(sanitizePackagedInFlightFailure("inflight-schema-shutdown", error)).toBeUndefined();
    }
    expect(reads).toBe(0);
    const phase = { toString: () => { reads++; throw new Error("private-canary"); } };
    expect(sanitizePackagedInFlightFailure(phase, new Error(guards[0][0]))).toBeUndefined();
    expect(reads).toBe(0);
  });
  it.each(["shutdown-authority-readback", "inflight-worker-address", "inflight-schema-blocker", "inflight-schema-held", "inflight-schema-waiter",
    "temporal-control-observe", "temporal-control-trigger", "temporal-control-activity", "inflight-sigterm", "inflight-drain-started", "inflight-drain-waiter",
    "inflight-worker-exit", "inflight-stopped-worker", "inflight-worker-lifecycle-logs", "fresh-recovery-entrypoint", "probe-readyz", "temporal-control-history"])(
    "exports only the existing fixed in-flight command phase %s", phase => {
      const error = new PackagedCommandError(phase, "command-exit", 1);
      Object.assign(error.diagnostic, { output: "private-canary", sql: "private-canary" });
      expect(sanitizePackagedCommandFailure(error)).toEqual({ category: "command-exit", exitCode: 1, signal: null, phase });
      expect(sanitizePackagedCommandFailure(new PackagedCommandError(`${phase}-private-canary`, "command-exit", 1)))
        .toEqual({ category: "command-exit", exitCode: 1, signal: null });
    }
  );
});

/** Exact read/control closure with modeled locked SDK replies. No TLS, SQL, worker or activity is executed. */
function drainControlModel() {
  const workerIdentity = "zenith-pkg-arm64-0123456789ab", previousRunId = "01234567-0123-4123-8123-0123456789ab";
  const runId = "11234567-0123-4123-8123-0123456789ab", workflowId = "zenith-reconcile-sweep-v1-2026-10-04T08:01:00Z";
  const previousWorkflowId = "zenith-reconcile-sweep-v1-2026-10-04T08:00:00Z";
  let clock = Date.now(), idleReads = 2, startReads = 0;
  const state = { triggers: 0, skipped: false, neverIdle: false, foreignRunning: false, terminal: false, pending: "normal", workerIdentity, attempt: 1, maximumAttempts: 1 };
  const expected = { contract: "zenith.reconcile-sweep.v1", maxEnvironments: 25, environmentConcurrency: 1 };
  const config = createHash("sha256").update(JSON.stringify([expected.contract, 25, 1])).digest("hex");
  const fresh = () => state.triggers > 0 && !state.skipped;
  const schedule = {
    async describe() {
      const running = fresh() ? !state.terminal : state.neverIdle || idleReads-- > 0;
      return { scheduleId: "zenith-reconcile-sweep-v1", memo: { zenithOwner: "zenith", zenithContract: expected.contract, zenithConfigSha256: config },
        typedSearchAttributes: { get: () => expected.contract }, state: { paused: false }, spec: { intervals: [{ every: 60000 }] },
        policies: { overlap: "SKIP", pauseOnFailure: false },
        action: { type: "startWorkflow", workflowType: "reconcileSweepWorkflow", workflowId: "zenith-reconcile-sweep-v1", taskQueue: "zenith-execution", args: [expected] },
        raw: { schedule: { action: { startWorkflow: { input: { payloads: [{ metadata: { encoding: Buffer.from("binary/zenith.temporal.v1") } }] } } } } },
        info: { runningActions: running ? [{ type: "startWorkflow", workflow: {
          workflowId: state.foreignRunning ? "foreign-workflow" : fresh() ? workflowId : previousWorkflowId,
          firstExecutionRunId: fresh() ? runId : previousRunId } }] : [], recentActions: [{ action: { type: "startWorkflow", workflow: {
          workflowId: fresh() ? workflowId : previousWorkflowId, firstExecutionRunId: fresh() ? runId : previousRunId } } }] } };
    },
    async trigger(overlap: string) { expect(overlap).toBe("SKIP"); state.triggers++; },
  };
  const client = { workflow: {
    async withDeadline(_deadline: number, fn: () => Promise<unknown>) { return fn(); },
    getHandle(id: string, selectedRunId: string) {
      if (![runId, previousRunId].includes(selectedRunId)) throw new Error("Modeled foreign run refuses.");
      const original = selectedRunId === previousRunId;
      return {
        async describe() {
          let pendingActivities: object[] = [];
          if (!original && !state.terminal) {
            startReads++;
            if (state.pending !== "empty" && startReads > 2) pendingActivities = [{ activityType: { name: "sweepReconcilePass" }, activityId: "1",
              state: state.pending === "scheduled" || startReads < 5 ? 1 : 2, attempt: state.attempt, maximumAttempts: state.maximumAttempts,
              lastWorkerIdentity: state.workerIdentity, lastStartedTime: { seconds: 1 } }];
          }
          return { workflowId: id, runId: selectedRunId, type: "reconcileSweepWorkflow", taskQueue: "zenith-execution",
            status: { name: original || state.terminal ? "COMPLETED" : "RUNNING" }, closeTime: new Date(clock - 10), raw: { pendingActivities } };
        },
        async result() {
          return original ? { status: "completed", counts: Object.fromEntries([
            ...["claimed", "reconciled", "nothingToReconcile", "busy", "ineligible", "failed", "deferred", "nudged", "driftDetected", "driftCleared", "openFindings", "unreadNodes", "repairsProposed", "repairsStarted", "repairsAwaitingApproval", "repairsDenied", "ms"].map(key => [key, 0]),
            ["saturated", false], ["timedOut", false] ]) } : { status: "deferred", reason: "prerequisites_unavailable" };
        },
        async fetchHistory() {
          return { events: [
            { eventId: 5, activityTaskScheduledEventAttributes: { activityId: "1", activityType: { name: "sweepReconcilePass" }, taskQueue: { name: "zenith-execution" }, retryPolicy: { maximumAttempts: 1 } } },
            { eventId: 6, activityTaskStartedEventAttributes: { scheduledEventId: 5, attempt: 1, identity: state.workerIdentity } },
            { eventId: 7, activityTaskCompletedEventAttributes: { scheduledEventId: 5, startedEventId: 6, identity: state.workerIdentity } },
          ] };
        },
      };
    },
  } };
  class ModelDate extends Date { static now() { return clock; } }
  const program = packagedTemporalControlSource();
  const closure = program.slice(program.indexOf(" const run=async("), program.indexOf(" if(action==='session')")) + "\nrun;";
  const run: (action: string, pinned?: string[]) => Promise<Record<string, unknown> | undefined> = runInNewContext(closure, {
    client, schedule, rpc: (fn: () => Promise<unknown>) => fn(), namespace: workerIdentity, encoding: "binary/zenith.temporal.v1",
    process: { env: { ZENITH_WORKER_IDENTITY: workerIdentity } }, createHash, Buffer, Date: ModelDate,
    defineSearchAttributeKey: () => ({}), SearchAttributeType: { KEYWORD: 2 }, ScheduleOverlapPolicy: { SKIP: "SKIP" },
    setTimeout: (fn: () => void, ms: number) => { clock += ms; fn(); return 1; },
  }, { timeout: 1000 });
  return { state, run, workerIdentity, previousRunId, runId, workflowId };
}

describe("packaged prewarmed drain control [exact closure and scalar protocol models]", () => {
  const workerIdentity = "zenith-pkg-arm64-0123456789ab", previousRunId = "01234567-0123-4123-8123-0123456789ab";
  const activity = { scheduleOwned: true, encryptedInput: true, paused: false,
    workflowId: "zenith-reconcile-sweep-v1-2026-10-04T08:01:00Z", runId: "11234567-0123-4123-8123-0123456789ab",
    activityId: "1", activityType: "sweepReconcilePass", workerIdentity, attempt: 1, maximumAttempts: 1,
    workflowStatus: "running", activityState: "started" };
  const frame = (sequence: number, action: string, evidence: object) => "PACKAGED_TEMPORAL_SESSION " + JSON.stringify({ sequence, action, evidence });
  it("frames only fixed read actions and exact owned pinned activity identity", () => {
    const pinned = [activity.workflowId, activity.runId, activity.activityId];
    expect(packagedTemporalSessionRequest(1, "history", pinned)).toBe(JSON.stringify({ sequence: 1, action: "history", pinned }));
    expect(sanitizePackagedTemporalSessionFrame(frame(0, "ready", { ready: true }), 0, "ready", workerIdentity)).toEqual({ ready: true });
    expect(sanitizePackagedTemporalSessionFrame(frame(1, "activity", activity), 1, "activity", workerIdentity, pinned)).toEqual(activity);
    expect(sanitizePackagedTemporalSessionFrame(frame(2, "close", { closed: true }), 2, "close", workerIdentity)).toEqual({ closed: true });
  });
  it.each(["arbitrary RPC", "namespace mutation", "unbounded sequence", "missing history pin", "foreign workflow", "malformed run", "extra activity pin"])(
    "refuses session request %s without emitting a command", fault => {
      const action = fault === "arbitrary RPC" ? "terminateWorkflow" : fault === "namespace mutation" ? "namespace" : "history";
      const pinned = fault === "missing history pin" ? [] : [activity.workflowId, activity.runId, activity.activityId];
      if (fault === "foreign workflow") pinned[0] = "foreign-workflow";
      if (fault === "malformed run") pinned[1] = "private-canary";
      if (fault === "extra activity pin") pinned.push("private-canary");
      expect(() => packagedTemporalSessionRequest(fault === "unbounded sequence" ? 65 : 1, action, pinned)).toThrow("invalid");
    });
  it.each(["missing", "malformed", "duplicate key", "noncanonical", "out of order", "duplicate prior reply", "foreign action", "unknown diagnostic", "nonascii", "oversized"])(
    "refuses control response %s with no arbitrary payload projection", fault => {
      let line = frame(1, "activity", activity);
      if (fault === "missing") line = "";
      if (fault === "malformed") line = "PACKAGED_TEMPORAL_SESSION {";
      if (fault === "duplicate key") line = line.replace('"sequence":1', '"sequence":0,"sequence":1');
      if (fault === "noncanonical") line = line.replace('{"sequence"', '{ "sequence"');
      if (fault === "out of order") line = frame(2, "activity", activity);
      if (fault === "duplicate prior reply") line = frame(0, "activity", activity);
      if (fault === "foreign action") line = frame(1, "history", activity);
      if (fault === "unknown diagnostic") line = frame(1, "activity", { ...activity, output: "private-canary" });
      if (fault === "nonascii") line = frame(1, "activity", { ...activity, output: "\u0000" }).replace("\\u0000", "\u0000");
      if (fault === "oversized") line += "x".repeat(8193);
      expect(() => sanitizePackagedTemporalSessionFrame(line, 1, "activity", workerIdentity)).toThrow("unconfirmed");
    });
  it.each(["queued", "completed", "wrong worker", "retry", "same run", "undrained", "foreign pin"])(
    "refuses unconfirmed started control boundary %s", fault => {
      const evidence = { ...activity, previousRunId, drainedBeforeTrigger: true };
      if (fault === "queued") evidence.activityState = "scheduled";
      if (fault === "completed") evidence.workflowStatus = "completed";
      if (fault === "wrong worker") evidence.workerIdentity = "zenith-pkg-arm64-ffffffffffff";
      if (fault === "retry") evidence.attempt = 2;
      if (fault === "same run") evidence.previousRunId = activity.runId;
      if (fault === "undrained") evidence.drainedBeforeTrigger = false;
      const pinned = fault === "foreign pin" ? [activity.workflowId, previousRunId, activity.activityId] : [];
      expect(() => sanitizePackagedTemporalSessionFrame(frame(1, "triggerActivity", evidence), 1, "triggerActivity", workerIdentity, pinned)).toThrow("unconfirmed");
    });
  it("waits for drained scheduler actions and actual started metadata before confirming a fresh run", async () => {
    const model = drainControlModel(), result = await model.run("triggerActivity");
    expect(result).toEqual({ ...activity, previousRunId, drainedBeforeTrigger: true });
    expect(model.state.triggers).toBe(1);
    expect(sanitizePackagedTemporalSessionFrame(frame(1, "triggerActivity", result!), 1, "triggerActivity", workerIdentity)).toEqual(result);
  });
  it.each(["overlap skipped", "never drained", "foreign running action", "pending never starts", "wrong worker", "attempt changed", "retry allowed"])(
    "actual closure refuses %s rather than accepting a trigger acknowledgement", async fault => {
      const model = drainControlModel();
      if (fault === "overlap skipped") model.state.skipped = true;
      if (fault === "never drained") model.state.neverIdle = true;
      if (fault === "foreign running action") model.state.foreignRunning = true;
      if (fault === "pending never starts") model.state.pending = "scheduled";
      if (fault === "wrong worker") model.state.workerIdentity = "zenith-pkg-arm64-ffffffffffff";
      if (fault === "attempt changed") model.state.attempt = 2;
      if (fault === "retry allowed") model.state.maximumAttempts = 2;
      await expect(model.run("triggerActivity")).rejects.toThrow();
      expect(model.state.triggers).toBe(["never drained", "foreign running action"].includes(fault) ? 0 : 1);
    });
  it("rereads the exact held activity and native linked terminal history without retriggering", async () => {
    const model = drainControlModel();await model.run("triggerActivity");
    const pinned = [model.workflowId, model.runId, "1"];
    expect(await model.run("activity", pinned)).toEqual(activity);
    model.state.terminal = true;
    await expect(model.run("activity", pinned)).rejects.toThrow();
    const history = await model.run("history", pinned);
    expect(history).toMatchObject({ workflowStatus: "completed", result: "deferred", reason: "prerequisites_unavailable",
      scheduledEventId: 5, startedEventId: 6, completedEventId: 7, startedByOriginalWorker: true, completedByOriginalWorker: true });
    expect(model.state.triggers).toBe(1);
  });
  it("prewarms positively owned control before blocker and retains same worker SQL waiter and cleanup requirements", () => {
    const source = readFileSync(new URL("../../scripts/acceptance/packaged-worker.mjs", import.meta.url), "utf8");
    const main = source.slice(source.indexOf("export async function packagedWorkerMain("));
    expect(main.indexOf("drainControl = await openPackagedTemporalSession(")).toBeLessThan(main.indexOf("const shutdownBlocker = docker("));
    expect(main.indexOf('await drainControl.call("idle")')).toBeLessThan(main.indexOf("const shutdownBlocker = docker("));
    expect(main).toContain('controlState.Config?.Labels?.["io.zenith.acceptance.run"] !== runId');
    expect(main).toContain("controlState.State?.Running !== true");
    expect(main).toContain("created.containers.push(drainControlName)");
    expect(main).toContain('admittedDrainActivity = await drainControl.call("triggerActivity")');
    expect(main).toContain('entered = await control("activity")');
    expect(main).toContain('afterSignal = await control("activity", "client", false, pinned)');
    expect(main).toContain("drainWaiter.waiterPid !== heldWaiter.waiterPid");
    expect(main).toContain("drainWaiter.blockerPid !== heldWaiter.blockerPid");
    expect(main).toContain("await drainControl.close();");
    expect(main).toContain("for (const name of created.containers.reverse()) await removeOwned");
    expect(main).toContain("sqlActivityAttributionProven: false, providerMutationAccepted: false");
    expect(main).toContain("consumedApprovalPreservationProven: false, receiptRecoveryProven: false");
    expect(packagedTemporalControlSource()).toContain("if(packet.action==='triggerActivity'&&selected)throw new Error()");
    expect(packagedTemporalControlSource()).toContain("packet.sequence!==sequence+1");
    expect(packagedTemporalControlSource()).toContain("process.getuid()!==10001");
    const runtime = readFileSync(new URL("../../src/lib/workflows/reconcile-schedule.ts", import.meta.url), "utf8");
    expect(runtime).toContain("set local lock_timeout='5s'");
  });
});


describe("packaged readiness polling [actual harness function; controlled response sequence]", () => {
  const readyBody = () => ({ ready: true, checks: { temporal: "ok", store: "ok", policy: "ok", drivers: "ok", reconciliation: "ok" } });
  const admitted = { ready: true, checks: { temporal: "ok", store: "ok", policy: "ok", drivers: "ok", reconciliation: "ok" } };

  it.each([false, true])("uses one successful response for status and strict readiness, recovery=%s", async recovery => {
    for (const laterStatus of [503, undefined]) {
      let probes = 0;
      const waits: number[] = [];
      const probe = async () => {
        probes++;
        return probes === 1 ? { status: 200, body: { ...readyBody(), privatePayload: "not-exported" } }
          : laterStatus === undefined ? undefined : { status: laterStatus, body: { ready: false } };
      };
      await expect(waitForPackagedReadiness(probe, { recovery, wait: async (ms: number) => { waits.push(ms); } })).resolves.toEqual(admitted);
      expect(probes).toBe(1);
      expect(waits).toEqual([]);
    }
  });

  it.each([undefined, null, {}, { ready: false, checks: readyBody().checks }, { ready: true, checks: null }])(
    "refuses malformed or false readiness in an otherwise successful response: %j", async body => {
      let probes = 0;
      const waits: number[] = [];
      await expect(waitForPackagedReadiness(async () => { probes++; return { status: 200, body }; },
        { wait: async (ms: number) => { waits.push(ms); } })).rejects.toThrow("Worker readiness evidence is incomplete.");
      expect(probes).toBe(1);
      expect(waits).toEqual([]);
    });

  it.each(["temporal", "store", "policy", "drivers", "reconciliation"] as const)("refuses a missing or failing %s check without retrying the accepted status", async key => {
    const { [key]: removed, ...missing } = readyBody().checks;
    expect(removed).toBe("ok");
    for (const checks of [missing, { ...readyBody().checks, [key]: "failed" }]) {
      let probes = 0;
      const waits: number[] = [];
      await expect(waitForPackagedReadiness(async () => { probes++; return { status: 200, body: { ready: true, checks } }; },
        { recovery: true, wait: async (ms: number) => { waits.push(ms); } })).rejects.toThrow("Worker readiness evidence is incomplete.");
      expect(probes).toBe(1);
      expect(waits).toEqual([]);
    }
  });

  it.each([undefined, 503, 201, "200", 0])("never admits a valid body without exact status200 and retains the91-probe/90-delay bound: %s", async status => {
    for (const recovery of [false, true]) {
      let probes = 0;
      const waits: number[] = [];
      await expect(waitForPackagedReadiness(async () => { probes++; return { status, body: readyBody() }; },
        { recovery, wait: async (ms: number) => { waits.push(ms); } })).rejects.toThrow(recovery
        ? "Fresh packaged worker did not restore readiness." : "Packaged worker did not become ready.");
      expect(probes).toBe(91);
      expect(waits).toEqual(Array(90).fill(1000));
    }
  });

  it("waits for a current successful response instead of carrying a previous non200 body", async () => {
    const responses = [{ status: 503, body: readyBody() }, { status: 200, body: readyBody() }, { status: 503, body: undefined }];
    let probes = 0;
    const waits: number[] = [];
    await expect(waitForPackagedReadiness(async () => responses[probes++],
      { wait: async (ms: number) => { waits.push(ms); } })).resolves.toEqual(admitted);
    expect(probes).toBe(2);
    expect(waits).toEqual([1000]);
  });

  it("preserves a transport failure without admitting or retrying an absent response", async () => {
    let probes = 0;
    const waits: number[] = [];
    const unavailable = new Error("Modeled transport unavailable.");
    await expect(waitForPackagedReadiness(async () => { probes++; throw unavailable; },
      { wait: async (ms: number) => { waits.push(ms); } })).rejects.toBe(unavailable);
    expect(probes).toBe(1);
    expect(waits).toEqual([]);
  });

  it("uses the same tested function at both initial and fresh-worker readiness joins", () => {
    const source = readFileSync(new URL("../../scripts/acceptance/packaged-worker.mjs", import.meta.url), "utf8");
    expect(source.match(/await waitForPackagedReadiness\(/g)).toHaveLength(2);
    expect(source).toContain('const ready = await waitForPackagedReadiness(() => probe("readyz"));');
    expect(source).toContain('await waitForPackagedReadiness(() => probe("readyz", recoveryWorker), { recovery: true });');
    expect(source).not.toContain('sanitizePackagedReadiness((await probe("readyz"))?.body)');
    expect(source).not.toContain('sanitizePackagedReadiness((await probe("readyz", recoveryWorker))?.body)');
  });
});
