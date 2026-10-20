/** Owned J6 operator bootstrap. Customer builds still run exclusively through the production worker. */
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { ensure, command, privateFile, kubeconfig, until, NATIVE } from "../../../tests/e2e/default/support.mjs";
import { renderBaseline, renderProxy, renderBuildCustody, BUILD_NODE_LABEL, BUILD_PROFILE_LABEL, BUILD_TAINT,
  buildTenantKey, type TenantBuildProfile } from "@/lib/providers/kubernetes/build";
import { BuildDeclaration, declaredProfile } from "./github-fixture";
import { cleanupAll, type Operated } from "./operated";
import { privateLocation, assertPrivate } from "../../deploy/installation.mjs";

const ELF_MACHINE: Record<string, number | undefined> = { arm64: 183, x64: 62 };
export function sourceBinary(bytes: Buffer) {
  ensure(bytes.length >= 64 && bytes.length <= 600 * 1024 && bytes.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70]))
    && bytes[4] === 2 && bytes[5] === 1 && bytes.readUInt16LE(18) === ELF_MACHINE[process.arch], "native-small-elf");
  return bytes.toString("base64");
}
export const sourceDockerfile = 'FROM scratch\nCOPY --chmod=0755 app /app\nUSER 65532:65532\nEXPOSE 8080\nENTRYPOINT ["/app"]\n';
export async function sourceBuildFixture(ctx: Operated): Promise<{ profile: TenantBuildProfile; app: string }> {
  const declaration = BuildDeclaration.parse(JSON.parse(privateFile(ctx.env.ZENITH_LOCAL_SOURCE_BUILD_DECLARATION_FILE!)));
  ensure(!declaration.config.pushSecret, "ephemeral-local-registry-no-push-credential");
  const binaryFile = privateLocation(ctx.env.ZENITH_LOCAL_SOURCE_BINARY_FILE!); assertPrivate(binaryFile);
  const app = sourceBinary(readFileSync(binaryFile));
  const modules = ctx.stack!.modules, state = ctx.stack!.state;
  const key = buildTenantKey(ctx), registryName = "zenith-drv1-reg-" + key.slice(0, 20), label = "io.zenith.drv1=" + key;
  const network = state.applicationProjectName + "_installation", parent = "io.zenith.installation=" + state.applicationInstallationId;
  const journal = JSON.parse(privateFile(path.join(path.dirname(ctx.env.ZENITH_LOCAL_JOURNEY_CONFIG_FILE!), "targets.json")));
  const [worker] = JSON.parse(await modules.docker(["inspect", "zenith-j2-worker"]));
  ensure(worker.Id === journal.buildContainerId && worker.Config.Labels?.["io.x-k8s.kind.cluster"] === "zenith-j2", "owned-dedicated-build-container");
  const target = kubeconfig(ctx.config!.kind.kubeconfigFile, ctx.config);
  const admin = (args: string[]) => command("kubectl", ["--kubeconfig", ctx.config!.kind.observerKubeconfigFile, "--context", ctx.config!.kind.context, ...args]);
  const node = JSON.parse(await admin(["get", "node", "zenith-j2-worker", "-o", "json"]));
  ensure(!node.metadata.labels[BUILD_NODE_LABEL] && !node.metadata.labels[BUILD_PROFILE_LABEL]
    && !(node.spec.taints ?? []).some((t: { key: string }) => t.key === BUILD_TAINT), "unallocated-build-node");
  const registryImage = ctx.env.ZENITH_LOCAL_SOURCE_REGISTRY_IMAGE;
  ensure(registryImage && /^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(registryImage), "pinned-local-registry-image");
  const [image] = JSON.parse(await modules.docker(["image", "inspect", registryImage])); ensure(image.Architecture === NATIVE?.image, "native-source-registry");
  let allocated = false, connected = false;
  const owned: { kind: string; name: string; namespace?: string; uid?: string; apiVersion: string }[] = [];
  const hosts: { id: string; file: string; content: string }[] = [];
  const manifestFile = path.join(ctx.scratch, "build-bootstrap.json");
  ctx.cleaners.push({ id: "owned-source-build-fixture", run: async () => {
    const active = await ctx.sql("select id from platform.operations where workspace_id=$1 and environment_id=$2 and status in ('queued','running','uncertain')", [ctx.workspaceId, ctx.environmentId]);
    ensure(active.length === 0, "no-live-build-writer");
    const failures = await cleanupAll([
      ...[...owned].reverse().map(item => ({ id: "build-object", run: async () => {
        const args = item.namespace ? ["-n", item.namespace] : [];
        const live = await admin([...args, "get", item.kind, item.name, "--ignore-not-found", "-o", "json"]);
        if (!live) return;
        const current = JSON.parse(live);
        ensure(typeof current.metadata.uid === "string" && (!item.uid || current.metadata.uid === item.uid)
          && current.metadata.annotations?.["zenith.dev/drv1"] === key, "build-cleanup-uid-owner");
        const resource = ({ Namespace: "namespaces", ClusterRole: "clusterroles", ClusterRoleBinding: "clusterrolebindings" } as Record<string,string>)[item.kind];
        if (!resource) return; // Namespaced children are removed by exact namespace UID deletion.
        writeFileSync(manifestFile, JSON.stringify({ apiVersion: "v1", kind: "DeleteOptions", propagationPolicy: "Foreground", preconditions: { uid: current.metadata.uid } }), { mode: 0o600 });
        const api = item.apiVersion === "v1" ? "/api/v1" : "/apis/" + item.apiVersion;
        await admin(["delete", "--raw", api + "/" + resource + "/" + item.name, "-f", manifestFile]);
        await until(() => admin(["get", item.kind, item.name, "--ignore-not-found", "-o", "json"]), (value: string) => !value);
      } })),
      { id: "release-build-node", run: async () => {
        if (!allocated) return;
        const live = JSON.parse(await admin(["get", "node", node.metadata.name, "-o", "json"]));
        if (!live.metadata.labels[BUILD_NODE_LABEL] && !live.metadata.labels[BUILD_PROFILE_LABEL]) return;
        ensure(live.metadata.uid === node.metadata.uid && live.metadata.labels[BUILD_NODE_LABEL] === key, "allocated-node-owner");
        const patches = [{ op: "test", path: "/metadata/resourceVersion", value: live.metadata.resourceVersion },
          { op: "remove", path: "/metadata/labels/" + BUILD_NODE_LABEL.replaceAll("/", "~1") },
          { op: "remove", path: "/metadata/labels/" + BUILD_PROFILE_LABEL.replaceAll("/", "~1") },
          { op: "replace", path: "/spec/taints", value: (live.spec.taints ?? []).filter((t: { key: string; value?: string }) => !(t.key === BUILD_TAINT && t.value === key)) }];
        await admin(["patch", "node", node.metadata.name, "--type=json", "-p", JSON.stringify(patches)]);
      } },
      ...hosts.map(host => ({ id: "remove-owned-registry-hosts", run: async () => {
        const [current] = JSON.parse(await modules.docker(["inspect", host.id])); ensure(current.Id === host.id && current.Config.Labels?.["io.x-k8s.kind.cluster"] === "zenith-j2", "registry-host-node-owner");
        ensure(await modules.docker(["exec", host.id, "cat", host.file]) === host.content.trim(), "registry-host-file-owner");
        await modules.docker(["exec", host.id, "rm", host.file]); await modules.docker(["exec", host.id, "rmdir", path.posix.dirname(host.file)]);
      } })),
      { id: "remove-source-registry", run: async () => {
        const found = await modules.docker(["container", "ls", "-aq", "--filter", "label=" + label]);
        if (found) { const [current] = JSON.parse(await modules.docker(["inspect", found])); ensure(current.Name === "/" + registryName && current.Config.Labels?.["io.zenith.drv1"] === key, "registry-cleanup-owner"); await modules.docker(["rm", "-f", current.Id]); }
        ensure(!(await modules.docker(["container", "ls", "-aq", "--filter", "label=" + label])), "registry-absence");
      } },
      { id: "disconnect-build-worker", run: async () => { if (connected) { const [current] = JSON.parse(await modules.docker(["inspect", worker.Id])); ensure(current.Id === journal.buildContainerId, "disconnect-build-worker-owner"); if (current.NetworkSettings.Networks[network]) await modules.docker(["network", "disconnect", network, current.Id]); } } },
    ]);
    ensure(failures.length === 0, "source-build-cleanup-incomplete"); if (existsSync(manifestFile)) unlinkSync(manifestFile);
  } });
  ensure(!worker.NetworkSettings.Networks[network], "fresh-worker-network-join"); connected = true;
  await modules.docker(["network", "connect", network, worker.Id]);
  await modules.docker(["run", "-d", "--name", registryName, "--label", label, "--label", parent, "--network", network, "--user", "1000:1000", "--memory", "128m", "--cpus", "0.25", "--pids-limit", "64",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--read-only", "--tmpfs", "/var/lib/registry:rw,nosuid,size=128m,uid=1000,gid=1000,mode=0700", registryImage]);
  const [registry] = JSON.parse(await modules.docker(["inspect", registryName]));
  const ip = registry.NetworkSettings.Networks[network].IPAddress;
  ensure(/^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(ip) || /^10\.\d+\.\d+\.\d+$/.test(ip) || /^192\.168\.\d+\.\d+$/.test(ip), "owned-registry-private-address");
  const profile = declaredProfile({ ...declaration, registryRepositoryRoot: ip + ":5000/zenith-drv1", config: { ...declaration.config,
    proxy: { ...declaration.config.proxy, destinations: [{ host: ip, ip, port: 5000, tls: false }] } } }, { workspaceId: ctx.workspaceId, environmentId: ctx.environmentId, server: ctx.config!.kind.server, caData: target.caData })[0]!;
  await admin(["get", "runtimeclass", profile.config.runtimeClass]); // Actual operator-installed runtime, never a substitute.
  // Protect the tenant allocation before admitting any build job. J6 probes verify the physical runtime/profile independently.
  allocated = true;
  await admin(["patch", "node", node.metadata.name, "--type=json", "-p", JSON.stringify([
    { op: "test", path: "/metadata/resourceVersion", value: node.metadata.resourceVersion },
    { op: "add", path: "/metadata/labels/" + BUILD_NODE_LABEL.replaceAll("/", "~1"), value: key },
    { op: "add", path: "/metadata/labels/" + BUILD_PROFILE_LABEL.replaceAll("/", "~1"), value: profile.config.nodeIsolation.profileDigest.slice(0, 63) },
    { op: "add", path: "/spec/taints", value: [...(node.spec.taints ?? []), ...["NoSchedule", "NoExecute"].map(effect => ({ key: BUILD_TAINT, value: key, effect }))] },
  ])]);
  for (const imageRef of [profile.config.builderImage, profile.config.proxy.image]) {
    const [image] = JSON.parse(await modules.docker(["image", "inspect", imageRef])); ensure(image.Architecture === NATIVE?.image, "native-build-toolchain");
    const tag = image.RepoTags?.[0]; ensure(tag, "toolchain-local-tag");
    const file = path.join(ctx.scratch, "toolchain.tar");
    try { await modules.docker(["image", "save", "--output", file, tag]); await command("kind", ["load", "image-archive", "--name", "zenith-j2", file], { timeout: 120_000 }); }
    finally { if (existsSync(file)) unlinkSync(file); }
    for (const name of ["zenith-j2-control-plane", "zenith-j2-worker"]) await modules.docker(["exec", name, "ctr", "--namespace=k8s.io", "images", "tag", "--force", tag, imageRef]);
  }
  const objects = [...renderBaseline(profile.config), ...renderProxy(profile.config), ...renderBuildCustody(profile.config)];
  for (const object of objects) {
    const scope = object.metadata.namespace ? ["-n", object.metadata.namespace] : [];
    ensure(!(await admin([...scope, "get", object.kind, object.metadata.name, "--ignore-not-found", "-o", "json"])), "fresh-owned-build-object");
    const annotated = { ...object, metadata: { ...object.metadata, annotations: { ...object.metadata.annotations, "zenith.dev/drv1": key } } };
    writeFileSync(manifestFile, JSON.stringify(annotated), { mode: 0o600 });
    const intent = { kind: object.kind, name: object.metadata.name, namespace: object.metadata.namespace, apiVersion: object.apiVersion, uid: undefined as string | undefined };
    owned.push(intent); // A failed create response may still have created the labelled object.
    const live = JSON.parse(await admin(["create", "-f", manifestFile, "-o", "json"]));
    intent.uid = live.metadata.uid;
  }
  for (const name of ["zenith-j2-control-plane", "zenith-j2-worker"]) {
    const [container] = JSON.parse(await modules.docker(["inspect", name]));
    ensure(container.Config.Labels?.["io.x-k8s.kind.cluster"] === "zenith-j2" && [journal.containerId, journal.buildContainerId].includes(container.Id), "registry-container-identity");
    ensure((await modules.docker(["exec", name, "cat", "/etc/containerd/config.toml"])).includes("/etc/containerd/certs.d"), "containerd-owned-hosts-directory");
    const directory = "/etc/containerd/certs.d/" + ip + ":5000", file = directory + "/hosts.toml";
    const existing = await modules.docker(["exec", name, "ls", "/etc/containerd/certs.d"]); ensure(!existing.split(/\s+/).includes(ip + ":5000"), "fresh-registry-hosts-path");
    const content = `server = "http://${ip}:5000"\n[host."http://${ip}:5000"]\n  capabilities = ["pull", "resolve"]\n`;
    await modules.docker(["exec", name, "mkdir", directory]); hosts.push({ id: container.Id, file, content });
    await modules.docker(["exec", "-i", name, "tee", file], { input: content });
  }
  await admin(["-n", profile.config.proxy.namespace, "rollout", "status", "deployment/zenith-build-proxy", "--timeout=180s"]);
  for (const [account, namespace, reference] of [["zenith-build-controller", profile.config.namespace, profile.credentialRef], ["zenith-build-verifier", profile.config.proxy.namespace, profile.verifierCredentialRef]]) {
    const token = await admin(["-n", namespace!, "create", "token", account!, "--duration=1h"]);
    const config = JSON.stringify({ apiVersion: "v1", kind: "Config", "current-context": "kind-zenith-j2", contexts: [{ name: "kind-zenith-j2", context: { cluster: "zenith-j2", user: account } }],
      clusters: [{ name: "zenith-j2", cluster: { server: profile.server, "certificate-authority-data": target.caData } }], users: [{ name: account, user: { token } }] });
    await ctx.action("system.setSecret", { projectId: ctx.project!.id, serviceId: "witness", key: reference!.slice(6), secretRef: reference, secretValue: config });
  }
  return { profile, app };
}
