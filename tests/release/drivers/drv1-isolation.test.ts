/** Offline: the owner-approved Calico pin refuses any manifest other than the reviewed upstream bytes. */
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CALICO_IMAGES, prepareIsolation, pinnedCalico } from "../../../scripts/release/drivers/drv1-isolation";

describe("DRV-1 isolation pins", () => {
  it("refuses a manifest whose bytes differ from the reviewed Calico v3.33.0 release", () => {
    expect(() => pinnedCalico("kind: DaemonSet\n        image: quay.io/calico/node:v3.33.0\n")).toThrow("drv1-isolation:calico-manifest-digest");
  });
  it("pins every reviewed Calico image by index digest", () => {
    expect(Object.keys(CALICO_IMAGES).sort()).toEqual(["quay.io/calico/calico:v3.33.0", "quay.io/calico/node:v3.33.0", "quay.io/calico/third-party-cni-plugins:v3.33.0"]);
    expect(Object.values(CALICO_IMAGES).every(digest => /^sha256:[a-f0-9]{64}$/.test(digest))).toBe(true);
  });
});

describe("DRV-1 runc build runtime (owner-approved 2026-10-23, disposable verification only)", () => {
  const KIND_CONFIG = 'version = 2\n[plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc]\n  runtime_type = "io.containerd.runc.v2"\n';
  function fixture(config = KIND_CONFIG) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "drv1-runc-"));
    writeFileSync(path.join(dir, "targets.json"), JSON.stringify({ kind: "zenith-j2", createdBy: "J2-DEFAULT-JOURNEY", containerId: "cp", buildContainerId: "wk" }));
    const calico = path.join(dir, "calico.yaml"); writeFileSync(calico, "not the reviewed manifest");
    const calls: string[][] = [];
    const exec = (command: string, args: readonly string[]): string => {
      calls.push([command, ...args]);
      if (command === "docker" && args[0] === "inspect") return JSON.stringify([{ Id: args[1] === "zenith-j2-control-plane" ? "cp" : "wk", Config: { Labels: { "io.x-k8s.kind.cluster": "zenith-j2" } } }]);
      if (args.includes("uname")) return "aarch64\n";
      if (args.includes("/etc/containerd/config.toml") && args.includes("cat")) return config;
      if (args.includes("/sys/kernel/security/apparmor/profiles")) return "zenith-build (enforce)\n";
      return "";
    };
    return { env: { DRV1_RUNTIME: "runc", DRV1_TARGETS_DIR: dir, DRV1_CALICO_MANIFEST: calico } as unknown as NodeJS.ProcessEnv, exec, calls };
  }
  it("needs no gVisor input and refuses an unknown runtime", () => {
    const { env, exec } = fixture();
    // Reaches the reviewed-Calico check, so the runtime inputs passed; no gVisor archive was required.
    expect(() => prepareIsolation(env, exec)).toThrow("drv1-isolation:calico-manifest-digest");
    expect(() => prepareIsolation({ ...env, DRV1_RUNTIME: "kata" }, exec)).toThrow("drv1-isolation:runtime");
    expect(() => prepareIsolation({ ...env, DRV1_RUNTIME: "gvisor" }, exec)).toThrow("drv1-isolation:usage");
  });
});
