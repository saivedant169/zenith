/** Offline gVisor installation, ONLY inside the explicitly owned disposable kind cluster. */
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const RUNTIME_CLASS = "zenith-gvisor";
const HEX = /^[a-f0-9]{64}$/;
export type Run = (command: string, args: readonly string[], input?: string) => string;

export function runtimeConfig(config: string, binaryDir: string): string {
  // containerd 2.x dumps version 3 or 4; both keep the CRI runtime under io.containerd.cri.v1.runtime.
  const version = /^\s*version\s*=\s*([234])\s*$/m.exec(config)?.[1];
  if (!version || !/^\/opt\/zenith-gvisor\/[a-f0-9]{64}$/.test(binaryDir)) throw new Error("Unsupported containerd configuration or installation path.");
  if (/runtimes[.\"]+runsc\b/.test(config)) throw new Error("An existing runsc handler must not be replaced.");
  const plugin = version === "2" ? "io.containerd.grpc.v1.cri" : "io.containerd.cri.v1.runtime";
  const prefix = `plugins."${plugin}".containerd.runtimes.runsc`;
  return `${config.trimEnd()}\n\n[${prefix}]\n  runtime_type = "io.containerd.runsc.v1"\n  runtime_path = "${binaryDir}/containerd-shim-runsc-v1"\n[${prefix}.options]\n  TypeUrl = "io.containerd.runsc.v1.options"\n  ConfigPath = "${binaryDir}/runsc.toml"\n`;
}

/** Require a flat publisher bundle, including the sidecars introduced in 2026. */
export function validateArchiveMembers(names: string[]): void {
  const clean = names.map((n) => n.replace(/^\.\//, ""));
  if (!clean.includes("runsc") || !clean.includes("containerd-shim-runsc-v1") || !clean.some((n) => n.startsWith("gvisor-bin/") && !n.endsWith("/"))) throw new Error("The complete gVisor bundle, including sidecars, is required.");
  if (clean.some((n) => n !== "." && n !== "" && !/^(runsc|containerd-shim-runsc-v1|gvisor-bin\/(?:[A-Za-z0-9_.-]+\/?)*|LICENSE|NOTICE)$/.test(n))) throw new Error("Unsafe or unexpected archive member.");
  if (clean.some((n) => n.split("/").includes(".."))) throw new Error("Archive path traversal refused.");
}

/** Reject architecture emulation as native acceptance, even if binfmt can execute the wrong binary. */
export function assertRuntimeArchitecture(arch: string, header: string): void {
  const bytes = header.trim().split(/\s+/).map(Number);
  const machine = arch === "aarch64" ? 183 : arch === "x86_64" ? 62 : -1;
  if (bytes.length !== 20 || bytes.slice(0, 6).join(",") !== "127,69,76,70,2,1" || bytes[18] !== machine || bytes[19] !== 0) throw new Error("gVisor must be a native ELF64 binary for the node architecture; emulation refused.");
}

export interface SetupInput {
  cluster: string;
  kubeconfig: string;
  workdir: string;
  archive: string;
  sha256: string;
  /** Publisher point release, recorded in the receipt, never 'latest'. */
  release: string;
}

export function installRuntime(input: SetupInput, run: Run): { cluster: string; release: string; sha256: string; nodes: { name: string; arch: string; version: string }[] } {
  if (!/^zenith-life07-[a-z0-9]{1,20}$/.test(input.cluster) || !HEX.test(input.sha256) || !/^\d{8}\.\d+$/.test(input.release)) throw new Error("Explicit disposable cluster, SHA-256 and publisher point release required.");
  if (realpathSync(input.kubeconfig) !== realpathSync(path.join(input.workdir, "kubeconfig")) || readFileSync(path.join(input.workdir, "zenith-j14.marker"), "utf8").trim() !== input.cluster) throw new Error("The kubeconfig and ownership marker must belong to this J14 installation.");
  const bytes = readFileSync(input.archive);
  if (createHash("sha256").update(bytes).digest("hex") !== input.sha256) throw new Error("gVisor archive checksum mismatch; nothing installed.");
  const k = (...args: string[]) => run("kubectl", ["--kubeconfig", input.kubeconfig, ...args]);
  if (k("config", "current-context").trim() !== `kind-${input.cluster}`) throw new Error("Wrong Kubernetes context.");
  const names = run("kind", ["get", "nodes", "--name", input.cluster]).trim().split(/\s+/);
  if (!names.length || names.some((n) => !new RegExp(`^${input.cluster}-(control-plane|worker)([0-9]+)?$`).test(n))) throw new Error("Unexpected kind node inventory.");
  const dir = `/opt/zenith-gvisor/${input.sha256}`;
  // Preflight every node BEFORE modifying any node. Docker labels independently prove ownership.
  const prepared = names.map((name) => {
    if (run("docker", ["inspect", "--format", '{{ index .Config.Labels "io.x-k8s.kind.cluster" }}', name]).trim() !== input.cluster) throw new Error("Kind node ownership mismatch.");
    const arch = run("docker", ["exec", name, "uname", "-m"]).trim();
    if (arch !== "aarch64" && arch !== "x86_64") throw new Error("Unsupported node architecture.");
    const listing = run("docker", ["exec", "-i", name, "tar", "-tjf", "-"], bytes.toString("base64"));
    validateArchiveMembers(listing.trim().split("\n"));
    // Links/devices would escape the installation directory. Only regular files/directories are admitted.
    const verbose = run("docker", ["exec", "-i", name, "tar", "-tvjf", "-"], bytes.toString("base64"));
    if (verbose.split("\n").filter(Boolean).some((line) => !/^[d-]/.test(line))) throw new Error("Archive links or special files refused.");
    const config = run("docker", ["exec", name, "containerd", "config", "dump"]);
    return { name, arch, config: runtimeConfig(config, dir) };
  });
  const nodes = prepared.map(({ name, arch, config }) => {
    run("docker", ["exec", name, "mkdir", "-p", dir]);
    run("docker", ["exec", "-i", name, "tar", "-xjf", "-", "--no-same-owner", "-C", dir], bytes.toString("base64"));
    assertRuntimeArchitecture(arch, run("docker", ["exec", name, "od", "-An", "-t", "u1", "-N", "20", `${dir}/runsc`]));
    // Exec format errors (e.g. AMD64 bundle on ARM64) fail BEFORE containerd changes.
    const version = run("docker", ["exec", name, `${dir}/runsc`, "--version"]).trim();
    if (!version.includes(input.release)) throw new Error("The runtime binary does not match the selected publisher release.");
    const shim = `binary_name = "${dir}/runsc"\n[runsc_config]\n  platform = "systrap"\n  systemd-cgroup = "true"\n`;
    run("docker", ["exec", "-i", name, "tee", `${dir}/runsc.toml`], shim);
    run("docker", ["exec", name, "cp", "/etc/containerd/config.toml", "/etc/containerd/config.toml.zenith-j14-before"]);
    run("docker", ["exec", "-i", name, "tee", "/etc/containerd/config.toml"], config);
    run("docker", ["exec", name, "systemctl", "restart", "containerd"]);
    run("docker", ["exec", name, "systemctl", "is-active", "containerd"]);
    return { name, arch, version };
  });
  k("wait", "--for=condition=Ready", "node", "--all", "--timeout=300s");
  for (const { name } of nodes) k("label", "node", name, "zenith.dev/runtime=gvisor");
  // Never publish scheduling capability until every node has its handler installed.
  k("create", "-f", path.join(path.dirname(fileURLToPath(import.meta.url)), "runtimeclass.yaml"));
  return { cluster: input.cluster, release: input.release, sha256: input.sha256, nodes };
}

/** Minimal kind nodes need only tar; the Mac's bzip2 expands the reviewed publisher archive. */
export function uncompressedTarArgs(args: readonly string[]): string[] {
  const flags: Readonly<Record<string, string>> = { "-tjf": "-tf", "-tvjf": "-tvf", "-xjf": "-xf" };
  return args.map((arg) => Object.hasOwn(flags, arg) ? flags[arg] : arg);
}

const cliRun: Run = (command, args, input) => {
  const binaryInput = args.includes("-tjf") || args.includes("-tvjf") || args.includes("-xjf");
  let stdin: string | Buffer | undefined = input;
  if (binaryInput) {
    const expanded = spawnSync("bzip2", ["-dc"], { input: Buffer.from(input ?? "", "base64"), timeout: 360_000, maxBuffer: 512 * 1024 * 1024 });
    if (expanded.error || expanded.status !== 0) throw new Error("The publisher bundle could not be decompressed on the verifier host; nothing published.");
    stdin = expanded.stdout;
  }
  const result = spawnSync(command, binaryInput ? uncompressedTarArgs(args) : [...args], { input: stdin, encoding: "utf8", timeout: 360_000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${command} ${args[0]} failed; inspect the disposable node locally.`);
  return result.stdout;
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.env.ZENITH_TEST_GVISOR_INSTALL !== "1") throw new Error("Not run: set ZENITH_TEST_GVISOR_INSTALL=1 for a disposable kind installation.");
    const receipt = installRuntime({ cluster: process.env.ZENITH_KIND_CLUSTER_NAME ?? "", kubeconfig: process.env.KUBECONFIG ?? "", workdir: process.env.ZENITH_K8S_WORKDIR ?? "", archive: process.env.ZENITH_GVISOR_ARCHIVE ?? "", sha256: process.env.ZENITH_GVISOR_SHA256 ?? "", release: process.env.ZENITH_GVISOR_RELEASE ?? "" }, cliRun);
    writeFileSync(path.join(process.env.ZENITH_K8S_WORKDIR!, "gvisor-installation.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Runtime installation failed.");
    process.exitCode = 1;
  }
}
