/**
 * DRV-1 owner-approved isolation for the owned two-node J2 kind cluster (verify/DRV-1-DECLARATIONS.md):
 * Calico as the enforcing CNI, the gVisor runsc handler, the zenith-build-gvisor RuntimeClass and the
 * reviewed seccomp profile on every node. The AppArmor profile is loaded into the host kernel by the caller.
 * Only the exact recorded zenith-j2 node containers are touched; nothing is installed anywhere else.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { assertRuntimeArchitecture, runtimeConfig, uncompressedTarArgs, validateArchiveMembers } from "../../../deploy/zenith-managed/runtime/setup-kind";

const PROFILES = "deploy/zenith-managed/build/profiles";
// Upstream projectcalico/calico v3.33.0 manifests/calico.yaml and its images, pinned by index digest.
export const CALICO_MANIFEST_SHA256 = "2de8f47595fb9c41b3f47d7b767a1f8e72ecf84057af834738ff12689a234da5";
export const CALICO_IMAGES: Readonly<Record<string, string>> = {
  "quay.io/calico/calico:v3.33.0": "sha256:4ebc20730127bc9e8bf1db5f5a2d8b58cf37fe0e891b3c7b5471992221d213e5",
  "quay.io/calico/node:v3.33.0": "sha256:565d8db3200e443955557f8f28ff44ab8a4a456754bc74a19c4f2f3444af9b1c",
  "quay.io/calico/third-party-cni-plugins:v3.33.0": "sha256:0f32f48279484c0d6f0e0d0e767b2d0e1a6c6ca34cb3421a61b989d992f3df41",
};

const fail = (code: string): never => { throw new Error("drv1-isolation:" + code); };
const ensure = (ok: unknown, code: string) => { if (!ok) fail(code); };

/** Pins every image to its reviewed digest and sets the owned pod CIDR; any other image refuses. */
export function pinnedCalico(raw: string): string {
  ensure(createHash("sha256").update(raw).digest("hex") === CALICO_MANIFEST_SHA256, "calico-manifest-digest");
  const images = [...raw.matchAll(/^(\s*)image: (\S+)$/gm)].map(match => match[2]);
  ensure(images.length > 0 && images.every(image => Object.hasOwn(CALICO_IMAGES, image)), "calico-image-inventory");
  const cidr = "            # - name: CALICO_IPV4POOL_CIDR\n            #   value: \"192.168.0.0/16\"";
  ensure(raw.split(cidr).length === 2, "calico-pool-anchor");
  return raw.replace(/^(\s*)image: (\S+)$/gm, (_line, indent: string, image: string) => `${indent}image: ${image}@${CALICO_IMAGES[image]}`)
    .replace(cidr, "            - name: CALICO_IPV4POOL_CIDR\n              value: \"10.244.0.0/16\"");
}

type Run = (command: string, args: readonly string[], input?: Buffer | string) => string;
const run: Run = (command, args, input) => {
  const result = spawnSync(command, [...args], { input, encoding: "utf8", timeout: 600_000, maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) fail(`${command}-${args.find(a => /^[a-z][a-z-]{1,20}$/.test(a)) ?? "call"}`);
  return result.stdout;
};

export function prepareIsolation(env: NodeJS.ProcessEnv, exec: Run = run): { nodes: string[]; release: string } {
  const targets = env.DRV1_TARGETS_DIR, archiveFile = env.DRV1_GVISOR_ARCHIVE, sha256 = env.DRV1_GVISOR_SHA256 ?? "", release = env.DRV1_GVISOR_RELEASE ?? "";
  ensure(targets && path.isAbsolute(targets) && archiveFile && /^[a-f0-9]{64}$/.test(sha256) && /^\d{8}\.\d+$/.test(release) && env.DRV1_CALICO_MANIFEST, "usage");
  const journal = JSON.parse(readFileSync(path.join(targets!, "targets.json"), "utf8"));
  ensure(journal.kind === "zenith-j2" && journal.createdBy === "J2-DEFAULT-JOURNEY" && journal.containerId && journal.buildContainerId, "target-journal");
  const kubectl = (...args: string[]) => exec("kubectl", ["--kubeconfig", path.join(targets!, "observer.json"), "--context", "kind-zenith-j2", ...args]);
  const nodes = ["zenith-j2-control-plane", "zenith-j2-worker"];
  for (const name of nodes) {
    const [node] = JSON.parse(exec("docker", ["inspect", name]));
    ensure(node.Config.Labels?.["io.x-k8s.kind.cluster"] === "zenith-j2" && [journal.containerId, journal.buildContainerId].includes(node.Id), "node-owner");
  }
  const archive = readFileSync(archiveFile!);
  ensure(createHash("sha256").update(archive).digest("hex") === sha256, "gvisor-archive-digest");
  const tar = spawnSync("bzip2", ["-dc"], { input: archive, maxBuffer: 512 * 1024 * 1024 });
  ensure(!tar.error && tar.status === 0, "gvisor-decompress");
  const dir = `/opt/zenith-gvisor/${sha256}`;
  const calico = pinnedCalico(readFileSync(env.DRV1_CALICO_MANIFEST!, "utf8"));
  for (const name of nodes) {
    const arch = exec("docker", ["exec", name, "uname", "-m"]).trim();
    validateArchiveMembers(exec("docker", ["exec", "-i", name, ...uncompressedTarArgs(["tar", "-tjf", "-"])], tar.stdout).trim().split("\n"));
    ensure(exec("docker", ["exec", "-i", name, ...uncompressedTarArgs(["tar", "-tvjf", "-"])], tar.stdout).split("\n").filter(Boolean).every(line => /^[d-]/.test(line)), "gvisor-archive-special-files");
    const config = runtimeConfig(exec("docker", ["exec", name, "containerd", "config", "dump"]), dir);
    exec("docker", ["exec", name, "mkdir", "-p", dir]);
    exec("docker", ["exec", "-i", name, ...uncompressedTarArgs(["tar", "-xjf", "-", "--no-same-owner", "-C", dir])], tar.stdout);
    assertRuntimeArchitecture(arch, exec("docker", ["exec", name, "od", "-An", "-t", "u1", "-N", "20", `${dir}/runsc`]));
    ensure(exec("docker", ["exec", name, `${dir}/runsc`, "--version"]).includes(release), "gvisor-release");
    exec("docker", ["exec", "-i", name, "tee", `${dir}/runsc.toml`], `binary_name = "${dir}/runsc"\n[runsc_config]\n  platform = "systrap"\n  systemd-cgroup = "true"\n`);
    exec("docker", ["exec", "-i", name, "tee", "/etc/containerd/config.toml"], config);
    exec("docker", ["exec", name, "systemctl", "restart", "containerd"]);
    exec("docker", ["exec", name, "mkdir", "-p", "/var/lib/kubelet/seccomp"]);
    exec("docker", ["exec", "-i", name, "tee", "/var/lib/kubelet/seccomp/zenith-build.json"], readFileSync(path.join(PROFILES, "zenith-build-seccomp.json")));
    // Preload the digest-pinned CNI images so kubelet never resolves a tag.
    for (const [image, digest] of Object.entries(CALICO_IMAGES)) exec("docker", ["exec", name, "ctr", "--namespace=k8s.io", "images", "pull", "--platform", `linux/${arch === "aarch64" ? "arm64" : "amd64"}`, `${image}@${digest}`]);
  }
  const manifest = path.join(targets!, "calico.pinned.yaml");
  writeFileSync(manifest, calico, { mode: 0o600 });
  kubectl("apply", "-f", manifest);
  kubectl("wait", "--for=condition=Ready", "node", "--all", "--timeout=300s");
  for (const name of nodes) kubectl("label", "node", name, "zenith.dev/runtime=gvisor");
  kubectl("create", "-f", path.join(PROFILES, "zenith-build-gvisor.runtimeclass.json"));
  return { nodes, release };
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith("drv1-isolation.ts")) {
  const result = prepareIsolation(process.env);
  process.stdout.write(JSON.stringify({ prepared: result.nodes.length, gvisorRelease: result.release }) + "\n");
}
