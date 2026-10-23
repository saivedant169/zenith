/** Independent observers; never manufacture provenance or build results. */
import { createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { ensure, NATIVE } from "../../../tests/e2e/default/support.mjs";
import { verifyBuildProvenance } from "@/lib/execution/build-provenance";
import type { ApprovedSourceSnapshot } from "@/lib/execution/source-snapshot";
import type { PublicJwk } from "@/lib/credentials/signing/types";
import { verifyPublishedArtifact, verifyProbe, type TenantBuildProfile } from "@/lib/providers/kubernetes/build";
import type { Operated } from "./operated";

interface ContainerView { image: string; args?: string[]; env: {name: string; value: string}[] }
interface DeploymentView { metadata: { uid: string }; spec: { selector: { matchLabels: Record<string,string> }; template: { spec: { containers: ContainerView[]; hostUsers?: boolean; runtimeClassName?: string } } } }
interface JobView extends DeploymentView { metadata: { uid: string; name: string; annotations: Record<string,string> }; status: { succeeded?: number } }
interface PodView { metadata: {name: string; deletionTimestamp?: string}; spec: {containers: {image: string}[]}; status: {phase?: string;
  conditions?: {type: string; status: string}[]; containerStatuses?: {ready: boolean; imageID: string}[]} }

export function assertBuiltRelease(row: Record<string, unknown>, source: ApprovedSourceSnapshot) {
  const readback = row.readback as { status?: string; observedDigest?: string };
  ensure(row.operation_id === source.operationId && row.state === "readback_verified"
    && typeof row.image_digest === "string" && /^sha256:[a-f0-9]{64}$/.test(row.image_digest)
    && typeof row.image_uri === "string" && row.image_uri.endsWith("@" + row.image_digest)
    && readback?.status === "verified" && readback.observedDigest === row.image_digest, "successful-built-release-readback");
  return { image: row.image_uri as string, digest: row.image_digest as string };
}
export function assertRunningBuiltImage(deployment: {spec: {template: {spec: {containers: {image: string}[]}}}}, pods: PodView[], image: string, platformDigest: string) {
  ensure(deployment.spec.template.spec.containers.length === 1 && deployment.spec.template.spec.containers[0].image === image,
    "deployment-equals-verified-build");
  const ready = pods.filter(p => !p.metadata.deletionTimestamp && p.status?.phase === "Running"
    && p.status.conditions?.some(c => c.type === "Ready" && c.status === "True"));
  ensure(ready.length === 1 && ready[0].spec.containers.length === 1 && ready[0].spec.containers[0].image === image
    && ready[0].status.containerStatuses?.length === 1 && ready[0].status.containerStatuses[0].ready === true
    && [image.slice(image.lastIndexOf("@") + 1), platformDigest].some(d => ready[0].status.containerStatuses![0].imageID.endsWith("@" + d)
      || ready[0].status.containerStatuses![0].imageID === "containerd://" + d), "running-equals-verified-build");
  return ready[0].metadata.name as string;
}
export async function builtReadback(ctx: Operated, source: ApprovedSourceSnapshot, profile: TenantBuildProfile) {
  const rows = await ctx.sql("select operation_id,state,image_uri,image_digest,readback from platform.release_runs where workspace_id=$1 and environment_id=$2 and operation_id=$3 and service_address=$4",
    [ctx.workspaceId, ctx.environmentId, source.operationId, source.serviceAddress]);
  ensure(rows.length === 1, "one-successful-built-release"); const built = assertBuiltRelease(rows[0]!, source);
  const evidence = await ctx.sql("select summary,simulated from platform.evidence where workspace_id=$1 and operation_id=$2 and summary->>'kind'='build.provenance' and summary->>'service'=$3",
    [ctx.workspaceId, source.operationId, source.serviceAddress]);
  ensure(evidence.length === 1 && evidence[0]!.simulated === false, "actual-retained-build-provenance");
  const summary = evidence[0]!.summary as { jwsParts: string[] };
  const signing = JSON.parse(ctx.env.ZENITH_CONTROL_SIGNING_JWK!);
  const publicKey = { ...createPublicKey({ key: signing, format: "jwk" }).export({ format: "jwk" }), kid: signing.kid, alg: "EdDSA", use: "sig" } as PublicJwk;
  const verified = await verifyBuildProvenance(summary.jwsParts.join("."), {
    workspaceId: ctx.workspaceId, operationId: source.operationId, environmentId: ctx.environmentId, provider: "kubernetes",
    serviceAddress: source.serviceAddress, pipelineAddress: source.pipelineAddress, contextDir: ".", imageDigest: built.digest,
    source, policy: { allowOpenEgress: false },
  }, [publicKey]);
  ensure(verified.exceptions.length === 0 && verified.claims.stmt.subject[0].name === built.image.slice(0, built.image.lastIndexOf("@"))
    && verified.claims.stmt.predicate.runDetails.builder.id === `zenith-isolated:${profile.config.namespace}:${profile.config.runtimeClass}`, "signed-j6-build-no-exceptions");
  const repository = built.image.slice(0, built.image.lastIndexOf("@"));
  ensure(repository.startsWith(profile.registryRepositoryRoot + "/"), "owned-built-registry-repository");
  const [authority, ...parts] = repository.split("/");
  ensure(profile.config.proxy.destinations.some(d => d.host + ":" + d.port === authority && !d.tls), "owned-local-artifact-origin");
  const api = (await ctx.stack!.modules.compose(ctx.stack!.state, ["ps", "-q", "api"])).trim();
  const [container] = JSON.parse(await ctx.stack!.modules.docker(["inspect", api]));
  ensure(container.Config.Labels?.["io.zenith.installation"] === ctx.stack!.state.applicationInstallationId, "artifact-observer-owner");
  const reader = { read: async (p: string) => {
    ensure(/^(manifests|blobs)\/sha256:[a-f0-9]{64}$/.test(p), "artifact-observer-immutable-path");
    const url = "http://" + authority + "/v2/" + parts.join("/") + "/" + p;
    const script = "(async()=>{const r=await fetch(process.argv[1],{redirect:'error',signal:AbortSignal.timeout(30000),headers:{Accept:'application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.in-toto+json'}});if(!r.ok||!r.body||Number(r.headers.get('content-length'))>1048576)throw Error();let n=0,b=[];for await(const c of r.body){n+=c.length;if(n>1048576)throw Error();b.push(c)}process.stdout.write(Buffer.concat(b).toString('base64'))})().catch(()=>process.exit(1))";
    return Buffer.from(await ctx.stack!.modules.docker(["exec", api, "node", "-e", script, url]), "base64");
  } };
  const index = JSON.parse(Buffer.from(await reader.read("manifests/" + built.digest)).toString());
  const jobNamespace = profile.config.namespace;
  const jobs = JSON.parse(await ctx.kubectl(["-n", jobNamespace, "get", "jobs", "-o", "json"])) as {items: JobView[]};
  const buildJobs = jobs.items.filter(j => j.spec.template.spec.containers[0]!.env.some(e => e.name === "ZENITH_BUILD_ID")
    && j.spec.template.spec.containers[0].args?.includes("build"));
  ensure(buildJobs.length === 1 && buildJobs[0].status.succeeded === 1
    && buildJobs[0].spec.template.spec.hostUsers === false && buildJobs[0].spec.template.spec.runtimeClassName === profile.config.runtimeClass,
  "actual-completed-isolated-build-job");
  ensure(buildJobs[0]!.metadata.uid === verified.claims.stmt.predicate.runDetails.metadata.invocationId
    && buildJobs[0]!.metadata.annotations["zenith.dev/source-digest"] === source.archiveDigest
    && buildJobs[0]!.metadata.annotations["zenith.dev/workspace-id"] === ctx.workspaceId, "signed-build-job-source-binding");
  const buildPods = JSON.parse(await ctx.kubectl(["-n", jobNamespace, "get", "pods", "-l", "job-name=" + buildJobs[0]!.metadata.name, "-o", "json"]));
  ensure(buildPods.items.length === 1 && buildPods.items[0].spec.nodeName === "zenith-j2-worker" && buildPods.items[0].status.phase === "Succeeded"
    && buildPods.items[0].status.containerStatuses?.[0]?.imageID?.endsWith(profile.config.builderImage.slice(profile.config.builderImage.lastIndexOf("@"))), "actual-native-builder-on-dedicated-worker");
  await assertNodeRuntimeSpec(ctx, buildPods.items[0], profile);
  const builderId = buildJobs[0]!.spec.template.spec.containers[0]!.env.find(e => e.name === "ZENITH_BUILD_ID")!.value;
  const probeJobs = jobs.items.filter(j => j.spec.template.spec.containers[0]!.args?.[0] === "probe");
  ensure(probeJobs.length === 1 && probeJobs[0].status.succeeded === 1, "completed-fresh-isolation-probe");
  const probePods = JSON.parse(await ctx.kubectl(["-n", jobNamespace, "get", "pods", "-l", "job-name=" + probeJobs[0].metadata.name, "-o", "json"]));
  ensure(probePods.items.length === 1 && probePods.items[0].spec.nodeName === "zenith-j2-worker", "probe-on-dedicated-worker");
  verifyProbe(probePods.items[0].status.containerStatuses?.[0]?.state?.terminated?.message);
  await assertNodeRuntimeSpec(ctx, probePods.items[0], profile);
  await verifyPublishedArtifact(reader, built.digest, builderId);
  const platform = (index.manifests as {platform?: {os: string; architecture: string}; digest: string}[]).find(m => m.platform?.os === "linux" && m.platform.architecture === NATIVE?.image);
  ensure(platform && /^sha256:[a-f0-9]{64}$/.test(platform.digest), "verified-native-artifact");
  const deployment = JSON.parse(await ctx.kubectl(["get", "deployment", "witness", "-o", "json"]));
  const selector = Object.entries(deployment.spec.selector.matchLabels).map(([key, value]) => key + "=" + value).join(",");
  const pods = JSON.parse(await ctx.kubectl(["get", "pods", "-l", selector, "-o", "json"]));
  const pod = assertRunningBuiltImage(deployment, pods.items, built.image, platform!.digest);
  ensure((await ctx.kubectl(["get", "--raw", `/api/v1/namespaces/zenith-j2/pods/${pod}:8080/proxy/`])).trim() === "zenith-j6-source-release", "independent-built-http-response");
  await ctx.eventReadback(source.operationId);
  return { uid: deployment.metadata.uid as string, image: built.image, platformDigest: platform!.digest };
}

/**
 * The runtime's own record of the container (containerd CRI on the dedicated worker), not the pod spec: the AppArmor
 * profile and the Localhost seccomp filter it actually installed. The probe's in-container checks prove the kernel
 * enforces them; this proves they are the reviewed ones.
 */
async function assertNodeRuntimeSpec(ctx: Operated, pod: { status: { containerStatuses?: { containerID?: string }[] } }, profile: TenantBuildProfile): Promise<void> {
  const id = /^containerd:\/\/([a-f0-9]{64})$/.exec(pod.status.containerStatuses?.[0]?.containerID ?? "")?.[1];
  ensure(id, "runtime-spec-container-id");
  const inspected = JSON.parse(await ctx.stack!.modules.docker(["exec", "zenith-j2-worker", "crictl", "inspect", id!]));
  const spec = inspected?.info?.runtimeSpec;
  ensure(spec?.process?.apparmorProfile === profile.config.appArmorProfile, "runtime-spec-apparmor");
  // The reviewed filter itself, not just "some filter": same default action and the same allowed system calls.
  const reviewed = JSON.parse(readFileSync("deploy/zenith-managed/build/profiles/zenith-build-seccomp.json", "utf8")) as { defaultAction: string; syscalls: { names: string[]; action: string }[] };
  const allowed = (rules: { names?: string[]; action?: string }[] | undefined) => [...new Set((rules ?? []).filter(r => r.action === "SCMP_ACT_ALLOW").flatMap(r => r.names ?? []))].sort().join(",");
  ensure(spec?.linux?.seccomp?.defaultAction === reviewed.defaultAction && allowed(spec.linux.seccomp.syscalls) === allowed(reviewed.syscalls) && allowed(reviewed.syscalls) !== "", "runtime-spec-seccomp");
  const bounding = spec?.process?.capabilities?.bounding;
  ensure(Array.isArray(bounding) && bounding.length > 0 && bounding.every((c: string) => c === "CAP_SETUID" || c === "CAP_SETGID"), "runtime-spec-capabilities");
  ensure(Array.isArray(spec?.linux?.uidMappings) && spec.linux.uidMappings.length > 0 && spec.linux.uidMappings.every((m: { hostID: number }) => m.hostID !== 0), "runtime-spec-user-namespace");
}
