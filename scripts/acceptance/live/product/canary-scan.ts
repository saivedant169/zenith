/**
 * OPS-06: a raw-byte scan of the runner's persistence for one canary value. Docker's data root holds every container's
 * logs, volumes (PostgreSQL files and WAL, Temporal history) and written files; the runner temp and workspace hold the
 * stack's data directories and this harness's own output. A control file with the canary proves the scan can see it.
 *
 * The canary reaches grep only through a 0600 pattern file outside the scanned roots, never argv, logs or evidence.
 * Results name places and counts, never paths or content.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface CanaryScan { control: boolean; leaks: Record<string, number> }
export interface CanaryScanOptions {
  roots: string[];
  /** A directory under one of the roots for the control file. */
  controlDir: string;
  timeoutMs?: number;
  /** Runs `grep` with the given argv; resolves its exit code and stdout. */
  run?: (argv: string[], timeoutMs: number) => Promise<{ code: number | null; stdout: Buffer }>;
}

const PLACES: [RegExp, string][] = [
  [/^\/var\/lib\/docker\/containers\//, "container logs"],
  [/^\/var\/lib\/docker\/volumes\//, "docker volumes"],
  [/^\/var\/lib\/docker\/(overlay2|rootfs|image)\//, "container filesystems"],
  [/^\/var\/lib\/docker\//, "docker data"],
];

export function placeOf(file: string, roots: string[]): string {
  for (const [pattern, place] of PLACES) if (pattern.test(file)) return place;
  const root = roots.find(r => file === r || file.startsWith(`${r.replace(/\/+$/, "")}/`));
  return root ? `root ${roots.indexOf(root) + 1}` : "other";
}

const defaultRun = (argv: string[], timeoutMs: number) => new Promise<{ code: number | null; stdout: Buffer }>((resolve, reject) => {
  // Docker's data root is root-owned; hosted runners allow passwordless sudo. Root needs no sudo.
  const [cmd, ...args] = process.getuid?.() === 0 ? argv : ["sudo", "-n", ...argv];
  const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
  const chunks: Buffer[] = [];
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
  child.on("error", error => { clearTimeout(timer); reject(error); });
  child.on("close", code => { clearTimeout(timer); resolve({ code, stdout: Buffer.concat(chunks) }); });
});

export async function scanForCanary(canary: string, options: CanaryScanOptions): Promise<CanaryScan> {
  if (!/^[A-Za-z0-9_-]{24,128}$/.test(canary)) throw new Error("canary must be 24-128 URL-safe characters");
  const roots = options.roots.filter(r => path.isAbsolute(r) && existsSync(r));
  if (!roots.length) throw new Error("no scan root exists");
  if (!roots.some(r => options.controlDir.startsWith(`${r.replace(/\/+$/, "")}/`))) throw new Error("the control directory is outside every scan root");
  // Pattern file in memory-backed storage outside the roots, so the scan never finds its own input.
  const base = existsSync("/dev/shm") ? "/dev/shm" : os.tmpdir();
  if (roots.some(r => base === r || base.startsWith(`${r.replace(/\/+$/, "")}/`))) throw new Error("the pattern directory is inside a scan root");
  const patternDir = await mkdtemp(path.join(base, "zenith-canary-"));
  const patternFile = path.join(patternDir, "pattern"), controlFile = path.join(options.controlDir, "control.bin");
  try {
    await writeFile(patternFile, `${canary}\n`, { mode: 0o600 });
    await mkdir(options.controlDir, { recursive: true, mode: 0o700 });
    await writeFile(controlFile, `control ${canary} control\n`, { mode: 0o600 });
    const { code, stdout } = await (options.run ?? defaultRun)(["grep", "-rlaFZ", "-D", "skip", "--no-messages", "-f", patternFile, "--", ...roots], options.timeoutMs ?? 15 * 60_000);
    // grep exits 0 on a match, 1 on none and 2 on an error; an error means some bytes went unread.
    if (code !== 0 && code !== 1) throw new Error(code === null ? "the canary scan did not finish within its bound" : "the canary scan could not read every file");
    const files = stdout.toString("utf8").split("\0").filter(Boolean);
    const leaks: Record<string, number> = {};
    for (const file of files) if (file !== controlFile) { const place = placeOf(file, roots); leaks[place] = (leaks[place] ?? 0) + 1; }
    return { control: files.includes(controlFile), leaks };
  } finally {
    await rm(controlFile, { force: true }).catch(() => undefined);
    await rm(patternDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
