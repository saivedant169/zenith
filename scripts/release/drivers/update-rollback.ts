/** J15 revision update, real failed rollout, and exact browser-reviewed rollback on owned J1/J2/kind. */
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import path from "node:path";
import { ensure, nonce, until, ok, NATIVE } from "../../../tests/e2e/default/support.mjs";
import { runOperated, driverCli, cleanupAll, type Operated } from "./operated";

export function updatePlan(baseImage: string, updateImage: string, initialMarker: string, updatedMarker: string) {
  const pinned = /^localhost:5000\/[a-z0-9][a-z0-9/_-]*@sha256:[a-f0-9]{64}$/;
  if (!pinned.test(baseImage) || !pinned.test(updateImage) || baseImage === updateImage
    || !/^[a-f0-9]{24}$/.test(initialMarker) || !/^[a-f0-9]{24}$/.test(updatedMarker) || initialMarker === updatedMarker) throw new Error("Distinct owned pinned revisions required");
  return [
    { phase: "baseline", image: baseImage, marker: initialMarker, expected: "succeeded" },
    { phase: "compatible-update", image: updateImage, marker: updatedMarker, expected: "succeeded" },
    { phase: "failed-rollout", image: updateImage, marker: "", expected: "failed" },
    { phase: "rollback", image: baseImage, marker: initialMarker, expected: "succeeded" },
  ] as const;
}
async function variant(ctx: Operated) {
  const modules = ctx.stack!.modules, id = nonce(), tag = "localhost:5000/zenith-drv1/" + id + ":update";
  const file = path.join(ctx.scratch, "Dockerfile");
  ensure(/^localhost:5000\/[A-Za-z0-9/_-]+@sha256:[a-f0-9]{64}$/.test(ctx.config!.kind.image), "local-base-image");
  writeFileSync(file, "FROM " + ctx.config!.kind.image + "\nLABEL io.zenith.drv1=" + id + "\nENV DRV1_COMPATIBLE_REVISION=" + id + "\n", { mode: 0o600, flag: "wx" });
  let createdImage = "", reference = "", kindNodeId = "", importAttempted = false;
  ctx.cleaners.push({ id: "remove-owned-update-image", run: async () => {
    const failures = await cleanupAll([
      { id: "kind-update-refs", run: async () => {
        if (!importAttempted) return;
        const [node] = JSON.parse(await modules.docker(["inspect", "zenith-j2-control-plane"]));
        ensure(node.Id === kindNodeId && node.Config.Labels?.["io.x-k8s.kind.cluster"] === "zenith-j2", "image-kind-cleanup-owner");
        const list = (): Promise<string> => modules.docker(["exec", node.Id, "ctr", "--namespace=k8s.io", "images", "ls", "--quiet"]);
        for (const ref of [tag, reference].filter(Boolean)) if ((await list()).split(/\s+/).includes(ref))
          await modules.docker(["exec", node.Id, "ctr", "--namespace=k8s.io", "images", "rm", ref]);
        ensure(!(await list()).split(/\s+/).some(ref => [tag, reference].includes(ref)), "kind-update-ref-absence");
      } },
      { id: "host-update-refs", run: async () => {
        const found = [...new Set((await modules.docker(["image", "ls", "-q", "--filter", "label=io.zenith.drv1=" + id])).split(/\s+/).filter(Boolean))];
        if (!found.length) return;
        ensure(found.length === 1, "one-owned-update-image");
        const [image] = JSON.parse(await modules.docker(["image", "inspect", found[0]!]));
        ensure(image.Config.Labels?.["io.zenith.drv1"] === id && (!createdImage || image.Id === createdImage), "update-image-cleanup-owner");
        // Exact local refs only; no prune, shared base/image or registry deletion.
        for (const ref of [...(image.RepoTags ?? []), ...(image.RepoDigests ?? [])]) {
          ensure(ref === tag || ref.startsWith(tag.slice(0, -7) + "@"), "image-cleanup-exact-ref");
          if (!(await modules.docker(["image", "ls", "-q", "--filter", "label=io.zenith.drv1=" + id]))) break;
          const [current] = JSON.parse(await modules.docker(["image", "inspect", image.Id]));
          ensure(current.Config.Labels?.["io.zenith.drv1"] === id, "image-ref-cleanup-owner");
          if ([...(current.RepoTags ?? []), ...(current.RepoDigests ?? [])].includes(ref)) await modules.docker(["image", "rm", ref]);
        }
        ensure(!(await modules.docker(["image", "ls", "-q", "--filter", "label=io.zenith.drv1=" + id])), "update-image-absence");
      } },
      { id: "private-image-files", run: async () => { for (const item of [file, path.join(ctx.scratch, "update.tar")]) if (existsSync(item)) unlinkSync(item); } },
    ]);
    ensure(failures.length === 0, "update-image-cleanup-incomplete");
  } });
  // This compatible fixture is a distinct image configuration. It retains J2's inert witness binary.
  await modules.docker(["build", "--network", "none", "--pull=false", "--platform", "linux/" + NATIVE?.image, "--label", "io.zenith.drv1=" + id,
    "--label", "io.zenith.installation=" + ctx.stack!.state.applicationInstallationId, "-t", tag, ctx.scratch]);
  await modules.docker(["push", tag]);
  const [image] = JSON.parse(await modules.docker(["image", "inspect", tag]));
  ensure(image.Architecture === NATIVE?.image && image.Config.Labels?.["io.zenith.drv1"] === id, "native-update-image");
  createdImage = image.Id;
  reference = image.RepoDigests.find((ref: string) => ref.startsWith(tag.slice(0, -7) + "@")) ?? "";
  ensure(reference && reference !== ctx.config!.kind.image, "distinct-update-digest");
  const archive = path.join(ctx.scratch, "update.tar");
  await modules.docker(["image", "save", "--output", archive, tag]);
  const { command } = await import("../../../tests/e2e/default/support.mjs");
  const [node] = JSON.parse(await modules.docker(["inspect", "zenith-j2-control-plane"]));
  ensure(node.Config.Labels?.["io.x-k8s.kind.cluster"] === "zenith-j2", "image-import-kind-owner");
  kindNodeId = node.Id; importAttempted = true;
  try { await command("kind", ["load", "image-archive", "--name", "zenith-j2", archive], { timeout: 120_000 }); }
  finally { if (existsSync(archive)) unlinkSync(archive); }
  await modules.docker(["exec", "zenith-j2-control-plane", "ctr", "--namespace=k8s.io", "images", "tag", "--force", tag, reference]);
  return reference as string;
}
export function assertReleaseRecords(rows: { operation_id: string; revision_id: string; image_digest: string; kind: string; state: string; readback: unknown }[],
  expected: { baseline: string; update: string; failure: string; rollback: string; baselineRevision: string; baseDigest: string; updateDigest: string }) {
  const one = (id: string) => { const hits = rows.filter(row => row.operation_id === id); ensure(hits.length === 1, "one-release-per-operation"); return hits[0]!; };
  for (const [id, digest] of [[expected.baseline, expected.baseDigest], [expected.update, expected.updateDigest], [expected.rollback, expected.baseDigest]]) {
    const row = one(id!);
    ensure(row.state === "readback_verified" && row.image_digest === digest
      && (row.readback as { status?: string; observedDigest?: string })?.status === "verified"
      && (row.readback as { observedDigest?: string }).observedDigest === digest, "release-verified-digest");
  }
  ensure(one(expected.failure).state === "failed" && one(expected.failure).image_digest === expected.updateDigest, "failed-release-persisted");
  ensure(one(expected.rollback).kind === "rollback" && one(expected.rollback).revision_id === expected.baselineRevision, "exact-rollback-revision");
}
async function readback(ctx: Operated, marker: string, image: string, steady = true) {
  const deployment = await until(async () => JSON.parse(await ctx.kubectl(["get", "deployment", "witness", "-o", "json"])),
    (d: { spec?: { replicas?: number }; status?: { availableReplicas?: number; updatedReplicas?: number; replicas?: number; observedGeneration?: number }; metadata?: { generation?: number } }) =>
      !steady || (d.spec?.replicas === 1 && d.status?.availableReplicas === 1 && d.status?.updatedReplicas === 1 && d.status?.replicas === 1
        && (d.status?.observedGeneration ?? -1) >= (d.metadata?.generation ?? Infinity)));
  ensure(deployment.metadata.annotations?.["zenith.dev/environment"] === ctx.environmentId, "independent-workload-owner");
  if (steady) ensure(deployment.spec.template.spec.containers[0].image === image, "independent-serving-digest");
  const selector = Object.entries(deployment.spec.selector.matchLabels).map(([key, value]) => key + "=" + value).join(",");
  const pods = JSON.parse(await ctx.kubectl(["get", "pods", "-l", selector, "-o", "json"]));
  const pod = pods.items.find((p: { metadata: { name: string }; spec: { containers: { image: string; env?: { name: string; value?: string }[] }[] }; status?: { conditions?: { type: string; status: string }[] } }) =>
    p.status?.conditions?.some(c => c.type === "Ready" && c.status === "True") && p.spec.containers[0]?.image === image
    && p.spec.containers[0].env?.some(e => e.name === "WITNESS_NONCE" && e.value === marker));
  ensure(pod, "independent-serving-pod");
  const body = JSON.parse(await ctx.kubectl(["exec", pod.metadata.name, "--", "/usr/local/bin/witness", "probe"]));
  ensure(body.kind === "zenith-default-journey" && body.nonce === marker, "independent-application-version");
  return deployment.metadata.uid as string;
}
export async function run(receipt: string, env = process.env) {
  return runOperated("update-rollback", receipt, env, async (ctx, step) => {
    const baseImage = ctx.config!.kind.image, updateImage = await variant(ctx);
    const phases = updatePlan(baseImage, updateImage, nonce(), nonce());
    let baseline!: Awaited<ReturnType<Operated["deploy"]>>, update!: Awaited<ReturnType<Operated["deploy"]>>,
      failure!: Awaited<ReturnType<Operated["deploy"]>>, rollback!: Awaited<ReturnType<Operated["propose"]>>;
    let uid = "";
    await step("baseline-readback", async () => {
      baseline = await ctx.deploy(phases[0].marker); ensure(baseline.terminal.operation.status === "succeeded", "baseline-success");
      uid = await readback(ctx, phases[0].marker, baseImage);
    });
    // A stable stored product record must survive every image revision and rollback.
    const projectBefore = ok(await ctx.request("/api/projects/" + ctx.project!.id));
    ctx.config!.kind.image = updateImage;
    await step("compatible-update-readback", async () => {
      update = await ctx.deploy(phases[1].marker); ensure(update.terminal.operation.status === "succeeded", "compatible-update-success");
      ensure(await readback(ctx, phases[1].marker, updateImage) === uid, "update-preserves-workload-identity");
    });
    await step("failed-rollout-readback", async () => {
      // Real failure: J2 witness refuses an empty nonce and the new pod crashes. Existing ready pods remain available.
      failure = await ctx.deploy(phases[2].marker);
      ensure(failure.terminal.operation.status === "failed" && /steady|rollout|progress/i.test(failure.terminal.operation.error ?? ""), "confirmed-rollout-failure");
      const deployment = JSON.parse(await ctx.kubectl(["get", "deployment", "witness", "-o", "json"]));
      const selector = Object.entries(deployment.spec.selector.matchLabels).map(([key, value]) => key + "=" + value).join(",");
      await until(async () => JSON.parse(await ctx.kubectl(["get", "pods", "-l", selector, "-o", "json"])),
        (pods: { items: { spec: { containers: { env?: { name: string; value?: string }[] }[] }; status?: { containerStatuses?: { restartCount: number; state?: { waiting?: { reason?: string } } }[] } }[] }) => pods.items.some(p =>
        p.spec.containers[0]?.env?.some(e => e.name === "WITNESS_NONCE" && e.value === "")
        && p.status?.containerStatuses?.some(s => s.restartCount > 0 && s.state?.waiting?.reason === "CrashLoopBackOff")), 30_000);
      ensure(await readback(ctx, phases[1].marker, updateImage, false) === uid, "failed-update-preserves-serving-version");
    });
    await step("browser-rollback-readback", async () => {
      rollback = await ctx.propose(baseline.revisionId); await ctx.approve(rollback.operationId);
      ensure((await ctx.settle(rollback.operationId)).operation.status === "succeeded", "rollback-success");
      ensure(await readback(ctx, phases[3].marker, baseImage) === uid, "rollback-restores-original-version");
    });
    await step("independent-release-readback", async () => {
      for (const operation of [baseline, update, failure, rollback]) await ctx.eventReadback(operation.operationId);
      const rows = await ctx.sql<{ operation_id: string; revision_id: string; image_digest: string; kind: string; state: string; readback: unknown }>(
        "select operation_id,revision_id,image_digest,kind,state,readback from platform.release_runs where workspace_id=$1 and environment_id=$2 and service_address='container_service/witness'",
        [ctx.workspaceId, ctx.environmentId]);
      assertReleaseRecords(rows, { baseline: baseline.operationId, update: update.operationId, failure: failure.operationId, rollback: rollback.operationId,
        baselineRevision: baseline.revisionId, baseDigest: baseImage.split("@")[1]!, updateDigest: updateImage.split("@")[1]! });
      const releases = ok(await ctx.request("/api/platform/v1/releases?environmentId=" + encodeURIComponent(ctx.environmentId))).releases;
      ensure(releases.length === rows.length && releases.some((r: { operationId: string; revisionId: string }) => r.operationId === rollback.operationId && r.revisionId === baseline.revisionId), "release-api-independent-pg-agreement");
      const after = ok(await ctx.request("/api/projects/" + ctx.project!.id));
      ensure(projectBefore.project?.id === ctx.project!.id && after.project?.id === ctx.project!.id
        && projectBefore.project.createdAt === after.project.createdAt, "compatible-product-record-preserved");
    });
  }, ["Compatible image configuration and stateless witness behavior are rehearsed; data migration/restore safety remains a separate lane.",
    "Failure injection uses the real witness process and Kubernetes controller. Local fixture cleanup uses an independent observer with exact owned UID preconditions.",
    "Owned image references are removed; content-addressed registry/cache blobs remain until the borrowed J1/J2 targets are torn down by their owner."]);
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve("scripts/release/drivers/update-rollback.ts"))
  void driverCli(run, process.argv.slice(2)).then(code => { process.exitCode = code; });
