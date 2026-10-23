/** Trusted entry inside the networkless container. Never extract on the host. */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const refused = () => { throw new Error("plugin_archive_refused"); };
const field = (header, start, length) => header.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
const octal = (header, start, length) => {
  const text = field(header, start, length).trim();
  if (!/^[0-7]+$/.test(text)) return refused();
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value)) return refused();
  return value;
};

/** Small strict ustar subset: regular files/directories only. No links, PAX,
 * special devices, sparse entries, path traversal or archive-owned modes. */
export async function unpack(bytes, root) {
  const data = gunzipSync(bytes, { maxOutputLength: 64 * 1024 * 1024 });
  const paths = new Set(); let offset = 0; let files = 0;
  await mkdir(root, { recursive: true, mode: 0o700 });
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (data.length - offset < 1024 || !data.subarray(offset).every((byte) => byte === 0)) refused();
      return;
    }
    if (++files > 256 || field(header, 257, 6) !== "ustar") refused();
    const checksum = [...header].reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (checksum !== octal(header, 148, 8)) refused();
    const size = octal(header, 124, 12);
    const prefix = field(header, 345, 155); const leaf = field(header, 0, 100);
    const name = (prefix ? `${prefix}/` : "") + leaf;
    const parts = name.replace(/\/$/, "").split("/");
    if (!name || name.startsWith("/") || /[\\:\x00-\x1f\x7f]/.test(name) || parts.some((p) => !p || p === "." || p === "..")) refused();
    const path = resolve(root, ...parts);
    if (!path.startsWith(resolve(root) + sep) || paths.has(path)) refused();
    paths.add(path);
    const type = field(header, 156, 1);
    if (!["", "0", "5"].includes(type) || field(header, 157, 100) || (type === "5" && size !== 0)) refused();
    offset += 512;
    if (size > 16 * 1024 * 1024 || offset + Math.ceil(size / 512) * 512 > data.length) refused();
    if (type === "5") await mkdir(path, { recursive: true, mode: 0o700 });
    else {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, data.subarray(offset, offset + size), { flag: "wx", mode: 0o600 });
    }
    offset += Math.ceil(size / 512) * 512;
  }
  refused();
}

export async function bootstrapInput(stream = process.stdin) {
  let input = "";
  for await (const chunk of stream) {
    input += chunk.toString();
    if (Buffer.byteLength(input) > 32_768) throw new Error("invalid_bootstrap");
  }
  return JSON.parse(input);
}

/** The gateway alone holds the child token; a plugin bootstrap that carries any token is refused. */
export function checkBootstrap(input, bytes) {
  if (!input || typeof input !== "object" || "token" in input || typeof input.binding?.credentialDigest !== "string" ||
      createHash("sha256").update(bytes).digest("hex") !== input.artifactDigest) throw new Error("invalid_bootstrap");
}

async function main() {
  if (!process.versions.node.startsWith("22.")) throw new Error("node22_required");
  const input = await bootstrapInput();
  const bytes = await readFile("/zenith/artifact.tgz");
  checkBootstrap(input, bytes);
  await unpack(bytes, "/work/plugin");
  const args = input.args.map((arg) => arg.replaceAll("${CLAUDE_PLUGIN_ROOT}", "/work/plugin"));
  const entry = resolve(args[0]);
  if (!entry.startsWith("/work/plugin/")) throw new Error("invalid_entrypoint");
  // No inherited host/container credentials, loader flags, proxy variables or
  // app store settings, and no Zenith token: the gateway authenticates every call.
  const child = spawn(process.execPath, ["--import", "/zenith/transport.mjs", ...args], {
    cwd: "/work/plugin", shell: false,
    env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/work", TMPDIR: "/work", ZENITH_API_VERSION: "3",
      ZENITH_URL: input.apiOrigin, ZENITH_WORKSPACE: input.lease.workspaceId,
      ZENITH_MCP_SOCKET: "/channel/api.sock", ZENITH_MCP_PATH: "/api/agent/v3/mcp" },
    stdio: ["pipe", "ignore", "ignore"],
  });
  // Keep stdio servers alive. The launcher owns process lifetime; container
  // removal kills this child and all descendants, regardless of signal handlers.
  child.on("error", () => { process.exitCode = 1; });
  child.on("close", (code) => { process.exitCode = code ?? 1; });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(() => { process.stderr.write("plugin_runner_refused\n"); process.exitCode = 1; });
}
