import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertRuntimeArchitecture, installRuntime, runtimeConfig, uncompressedTarArgs, validateArchiveMembers, type Run, type SetupInput } from "../../deploy/zenith-managed/runtime/setup-kind";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "zenith-j14-contract-"));
  dirs.push(dir);
  const bytes = Buffer.from("contract fixture, never an executable runtime");
  writeFileSync(path.join(dir, "archive"), bytes);
  writeFileSync(path.join(dir, "kubeconfig"), "contract only");
  writeFileSync(path.join(dir, "zenith-j14.marker"), "zenith-life07-j14");
  const input: SetupInput = { cluster: "zenith-life07-j14", kubeconfig: path.join(dir, "kubeconfig"), workdir: dir, archive: path.join(dir, "archive"), sha256: createHash("sha256").update(bytes).digest("hex"), release: "20261001.0" };
  const calls: { command: string; args: readonly string[]; input?: string }[] = [];
  const run: Run = (command, args, stdin) => {
    calls.push({ command, args, input: stdin });
    if (command === "kubectl" && args.includes("current-context")) return `kind-${input.cluster}`;
    if (command === "kind") return `${input.cluster}-control-plane\n${input.cluster}-worker`;
    if (command === "docker" && args[0] === "inspect") return input.cluster;
    if (args.includes("uname")) return "aarch64";
    if (args.includes("od")) return "127 69 76 70 2 1 1 0 0 0 0 0 0 0 0 0 2 0 183 0";
    if (args.includes("-tjf")) return "runsc\ncontainerd-shim-runsc-v1\ngvisor-bin/\ngvisor-bin/sentry";
    if (args.includes("-tvjf")) return "-rwxr-xr-x runsc\ndrwxr-xr-x gvisor-bin";
    if (args.includes("dump")) return 'version = 3\n[plugins."io.containerd.cri.v1.runtime".containerd.runtimes.runc]\nruntime_type = "io.containerd.runc.v2"';
    if (args.includes("--version")) return `runsc version release-${input.release}`;
    return "";
  };
  return { input, run, calls };
}

describe("gVisor installation contract (no Docker)", () => {
  it("sends plain tar streams to minimal kind nodes, preserving every other argument", () => {
    for (const [compressed, plain] of [["-tjf", "-tf"], ["-tvjf", "-tvf"], ["-xjf", "-xf"]]) {
      expect(uncompressedTarArgs(["exec", "-i", "owned-node", "tar", compressed, "-", "-C", "/opt/bundle"])).toEqual(["exec", "-i", "owned-node", "tar", plain, "-", "-C", "/opt/bundle"]);
    }
    expect(uncompressedTarArgs(["constructor", "toString", "__proto__"])).toEqual(["constructor", "toString", "__proto__"]);
  });
  it("requires native ELF architecture, even when the host could run the other binary under emulation", () => {
    const arm = "127 69 76 70 2 1 1 0 0 0 0 0 0 0 0 0 2 0 183 0";
    const amd = arm.replace("183", "62");
    expect(() => assertRuntimeArchitecture("aarch64", arm)).not.toThrow();
    expect(() => assertRuntimeArchitecture("x86_64", amd)).not.toThrow();
    expect(() => assertRuntimeArchitecture("aarch64", amd)).toThrow(/emulation/);
    expect(() => assertRuntimeArchitecture("x86_64", arm)).toThrow(/emulation/);
  });
  it.each(["2", "3", "4"])("preserves default runc and uses the correct containerd v%s CRI plugin", (version) => {
    const config = `version = ${version}\n# retain this default\ndefault_runtime_name = "runc"\n`;
    const out = runtimeConfig(config, `/opt/zenith-gvisor/${"a".repeat(64)}`);
    expect(out.startsWith(config)).toBe(true);
    expect(out).toContain(version === "2" ? "io.containerd.grpc.v1.cri" : "io.containerd.cri.v1.runtime");
    expect(out).toContain('runtime_type = "io.containerd.runsc.v1"');
  });
  it.each(['version = 1', 'version = 3\n[plugins."io.containerd.cri.v1.runtime".containerd.runtimes.runsc]', "version = 4\n[plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.runsc]"])("refuses unsupported or previously configured runtime: %s", (config) => {
    expect(() => runtimeConfig(config, `/opt/zenith-gvisor/${"a".repeat(64)}`)).toThrow();
  });
  it.each(["../runsc", "/runsc", "gvisor-bin/../../etc/passwd", "gvisor-bin/../evil"])("refuses unsafe member %s", (bad) => {
    expect(() => validateArchiveMembers(["runsc", "containerd-shim-runsc-v1", "gvisor-bin/sentry", bad])).toThrow();
  });
  it("requires sidecars, rather than installing only the two legacy binaries", () => {
    expect(() => validateArchiveMembers(["runsc", "containerd-shim-runsc-v1"])).toThrow(/sidecars/);
  });
  it("rejects checksum mismatch without even consulting Docker", () => {
    const f = fixture();
    expect(() => installRuntime({ ...f.input, sha256: "0".repeat(64) }, f.run)).toThrow(/checksum/);
    expect(f.calls).toHaveLength(0);
  });
  it("refuses unowned workdirs without consulting the cluster", () => {
    const f = fixture();
    writeFileSync(path.join(f.input.workdir, "zenith-j14.marker"), "different-cluster");
    expect(() => installRuntime(f.input, f.run)).toThrow(/ownership/);
    expect(f.calls).toHaveLength(0);
  });
  it.each(["ownership", "symlink", "context", "architecture"])("refuses a bad %s preflight before modifying any node", (failure) => {
    const f = fixture();
    const run: Run = (command, args, stdin) => {
      if (failure === "ownership" && command === "docker" && args[0] === "inspect" && args.at(-1)?.endsWith("worker")) return "other-cluster";
      if (failure === "symlink" && args.includes("-tvjf")) return "lrwxr-xr-x link -> /etc/passwd";
      if (failure === "context" && args.includes("current-context")) return "production";
      if (failure === "architecture" && args.includes("uname")) return "riscv64";
      return f.run(command, args, stdin);
    };
    expect(() => installRuntime(f.input, run)).toThrow();
    expect(f.calls.some((c) => c.args.includes("mkdir") || c.args.includes("tee") || c.args.includes("restart"))).toBe(false);
  });
  it("installs the complete bundle with systrap/systemd and labels/publishes only after every node is ready", () => {
    const f = fixture();
    const receipt = installRuntime(f.input, f.run);
    expect(receipt.nodes.map((n) => n.arch)).toEqual(["aarch64", "aarch64"]);
    const restarts = f.calls.map((c, i) => c.args.includes("restart") ? i : -1).filter((i) => i >= 0);
    const labels = f.calls.map((c, i) => c.args.includes("label") ? i : -1).filter((i) => i >= 0);
    expect(restarts).toHaveLength(2);
    expect(Math.min(...labels)).toBeGreaterThan(Math.max(...restarts));
    const shim = f.calls.find((c) => c.args.at(-1)?.endsWith("/runsc.toml"))?.input;
    expect(shim).toContain('platform = "systrap"');
    expect(shim).toContain('systemd-cgroup = "true"');
    expect(f.calls.at(-1)?.args).toContain("create");
  });
  it("never publishes the RuntimeClass when a binary release check fails", () => {
    const f = fixture();
    expect(() => installRuntime(f.input, (command, args, stdin) => args.includes("--version") ? "wrong release" : f.run(command, args, stdin))).toThrow(/release/);
    expect(f.calls.some((c) => c.args.includes("restart") || c.args.includes("label") || c.args.includes("create"))).toBe(false);
  });
});
