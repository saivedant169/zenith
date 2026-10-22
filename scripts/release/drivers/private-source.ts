/** J15 successful isolated private-source release, followed by revoked-source refusal. */
import path from "node:path";
import { ensure, ok, until, nonce } from "../../../tests/e2e/default/support.mjs";
import { immutableSourceSnapshot, sourceSnapshotDigest } from "@/lib/execution/source-snapshot";
import { githubFixture } from "./github-fixture";
import { sourceBuildFixture, sourceDockerfile } from "./source-build-fixture";
import { builtReadback, assertRunningBuiltImage } from "./source-build-readback";
import { runOperated, driverCli, hash, TERMINAL, type Operated } from "./operated";

export function assertSnapshot(row: { snapshot: unknown; snapshot_digest: string }, expected: {
  workspaceId: string; projectId: string; environmentId: string; operationId: string; commit: string; archive: string; dockerfile: string;
}) {
  const s = immutableSourceSnapshot(row.snapshot);
  ensure(s.workspaceId === expected.workspaceId && s.projectId === expected.projectId && s.environmentId === expected.environmentId
    && s.operationId === expected.operationId && s.commitSha === expected.commit && s.archiveDigest === expected.archive
    && s.dockerfileDigest === hash(expected.dockerfile) && s.githubBinding?.appId === "815" && s.githubBinding.repositoryId === 817
    && s.requestedRef === "main" && sourceSnapshotDigest(s) === row.snapshot_digest, "independent-exact-source-snapshot");
  return s;
}
export async function run(receipt: string, env = process.env) {
  return runOperated("private-source", receipt, env, async (ctx, step) => {
    let build!: Awaited<ReturnType<typeof sourceBuildFixture>>;
    await step("source-build-preconditions", async () => { build = await sourceBuildFixture(ctx); });
    let fixture!: Awaited<ReturnType<typeof githubFixture>>;
    await step("browser-source-binding", async () => {
      fixture = await githubFixture(ctx, { ...build, dockerfile: sourceDockerfile });
      await ctx.a!.goto(ctx.stack!.apiUrl + "/api/platform/v1/github/callback");
      await ctx.a!.getByLabel("Repository (owner/name)").fill(fixture.fixture.repository);
      await ctx.a!.getByRole("button", { name: "Install and bind repository", exact: true }).click();
      await ctx.a!.getByRole("heading", { name: "GitHub source connected", exact: true }).waitFor().catch(async (error: unknown) => {
        if (ctx.env.ZENITH_OPERATED_DIAGNOSTICS === "1") {
          // Static UI only: the page path (no query) plus visible headings and alerts, elided.
          const page = ctx.a!, url = new URL(page.url());
          const texts = async (role: "heading" | "alert") => (await page.getByRole(role).allInnerTexts().catch(() => [] as string[]))
            .map(t => t.replace(/\s+/g, " ").replace(/[a-z]+:\/\/\S+/gi, "<url>").replace(/[A-Za-z0-9_+/=-]{24,}/g, "…").slice(0, 160)).slice(0, 6);
          process.stderr.write(`operated outside-step failed: journey:source-binding-page ${JSON.stringify({ host: url.hostname === "github.com" ? "github.com" : url.origin === new URL(ctx.stack!.apiUrl).origin ? "api" : "other",
            path: url.pathname.replace(/[A-Za-z0-9_-]{20,}/g, "…"), query: [...url.searchParams.keys()].sort(), headings: await texts("heading"), alerts: await texts("alert"),
            body: (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").replace(/[a-z]+:\/\/\S+/gi, "<url>").replace(/[A-Za-z0-9_+/=-]{24,}/g, "…").slice(0, 200) })}\n`);
        }
        throw error;
      });
      const binding = ok(await ctx.request("/api/platform/v1/github/binding"));
      ensure(binding.binding?.state === "connected" && binding.binding.owner + "/" + binding.binding.repo === fixture.fixture.repository, "source-binding-readback");
    });
    const sourceManifest = (marker: string) => {
      const manifest = ctx.manifest(marker);
      const source = { type: "git", repo: "github.com/" + fixture.fixture.repository, ref: "main", dockerfile: "Dockerfile" };
      return { ...manifest, services: [{ ...manifest.services[0], source }] };
    };
    let operationId = "", initialDigest = "";
    await step("private-source-snapshot", async () => {
      await ctx.action("project.updateManifest", { projectId: ctx.project!.id, manifest: sourceManifest("private-source-local") });
      const proposal = await ctx.propose(); operationId = proposal.operationId;
      const rows = await snapshotRows(ctx, operationId);
      ensure(rows.length === 1, "one-retained-source");
      const snapshot = assertSnapshot(rows[0]!, { workspaceId: ctx.workspaceId, projectId: ctx.project!.id, environmentId: ctx.environmentId,
        operationId, commit: fixture.fixture.commit, archive: fixture.expectedArchive, dockerfile: fixture.fixture.dockerfile });
      initialDigest = rows[0]!.snapshot_digest;
      const reviewed = await ctx.detail(operationId), view = reviewed.planReview?.view;
      ensure(view?.approvedSources?.length === 1 && view.approvedSources[0].commit === snapshot.commitSha
        && view.approvedSources[0].archiveDigest === snapshot.archiveDigest, "reviewed-exact-source");
      await fixture.control(true, false); // moving a branch cannot rewrite the retained immutable snapshot
    });
    let baseline!: Awaited<ReturnType<typeof builtReadback>>;
    await step("isolated-private-build", async () => {
      await ctx.approve(operationId);
      ensure((await ctx.settle(operationId)).operation.status === "succeeded", "successful-private-source-operation");
    });
    await step("provenance-verified-deploy", async () => {
      const rows = await snapshotRows(ctx, operationId);
      ensure(rows.length === 1 && rows[0]!.snapshot_digest === initialDigest, "built-approved-snapshot-unchanged");
      const snapshot = assertSnapshot(rows[0]!, { workspaceId: ctx.workspaceId, projectId: ctx.project!.id, environmentId: ctx.environmentId,
        operationId, commit: fixture.fixture.commit, archive: fixture.expectedArchive, dockerfile: fixture.fixture.dockerfile });
      baseline = await builtReadback(ctx, snapshot, build.profile);
      // Capture another proposal from the original branch, then move it again. Retain all revocation assertions.
      await fixture.control(false, false);
      await ctx.action("project.updateManifest", { projectId: ctx.project!.id, manifest: sourceManifest("private-source-refused") });
      operationId = (await ctx.propose()).operationId;
      const later = await snapshotRows(ctx, operationId);
      const captured = assertSnapshot(later[0]!, { workspaceId: ctx.workspaceId, projectId: ctx.project!.id, environmentId: ctx.environmentId,
        operationId, commit: fixture.fixture.commit, archive: fixture.expectedArchive, dockerfile: fixture.fixture.dockerfile });
      initialDigest = later[0]!.snapshot_digest;
      const view = (await ctx.detail(operationId)).planReview?.view;
      ensure(view?.approvedSources?.length === 1 && view.approvedSources[0].commit === captured.commitSha
        && view.approvedSources[0].archiveDigest === captured.archiveDigest, "later-reviewed-exact-source");
      await fixture.control(true, false);
    });
    let paused = false;
    const worker = (await ctx.stack!.modules.compose(ctx.stack!.state, ["ps", "-q", "execution-worker"])).trim();
    const recover = async () => { if (paused) { await ctx.stack!.modules.docker(["unpause", worker]); paused = false; } };
    ctx.recoveries.push({ id: "unpause-owned-source-worker", run: recover });
    try {
      await step("browser-snapshot-approval", async () => {
        const [current] = JSON.parse(await ctx.stack!.modules.docker(["inspect", worker]));
        ensure(current.Config.Labels?.["io.zenith.installation"] === ctx.stack!.state.applicationInstallationId, "owned-worker-injection");
        // Hold only the owned local worker while the genuine UI records approval and revocation.
        // This closes the race where a valid approval could dispatch before our intended injection.
        await ctx.stack!.modules.docker(["pause", worker]); paused = true;
        await ctx.approve(operationId);
        await ctx.a!.goto(ctx.stack!.apiUrl + "/api/platform/v1/github/callback");
        await ctx.a!.getByRole("button", { name: "Revoke source access", exact: true }).click();
        await ctx.a!.getByRole("heading", { name: "GitHub source revoked", exact: true }).waitFor();
        ensure(ok(await ctx.request("/api/platform/v1/github/binding")).binding?.state === "revoked", "browser-source-revoked");
      });
    } finally { await recover(); }
    await step("source-revocation-refused", async () => {
      const terminal = await ctx.settle(operationId);
      ensure(terminal.operation.status === "failed" && /source|binding|github/i.test(terminal.operation.error ?? ""), "source-refusal-required");
      const response = await ctx.request("/api/platform/v1/github/inspect?ref=main");
      ensure(response.status === 403 && response.data.error?.message === "GitHub source access was refused.", "revoked-source-no-anonymous-fallback");
    });
    await step("post-revocation-proposal-refused", async () => {
      await ctx.action("project.updateManifest", { projectId: ctx.project!.id, manifest: sourceManifest("private-source-after-revocation") });
      const response = await ctx.request("/api/actions/deploy.apply", { mode: "execute", input: { projectId: ctx.project!.id, environmentId: ctx.environmentId,
        message: "DRV-1 after revocation" }, scope: { workspaceId: ctx.workspaceId, projectId: ctx.project!.id, environmentId: ctx.environmentId }, idempotencyKey: nonce() });
      if (response.status >= 400 || response.data.result?.ok === false) {
        ensure(response.status < 500 && /source|binding|github/i.test(JSON.stringify(response.data.error ?? response.data.result?.error)), "new-proposal-source-specific-refusal");
        return;
      }
      const proposed = ok(response).result;
      ensure(proposed?.ok && proposed.data.operationId && proposed.data.deploymentId, "new-revoked-proposal-identity");
      const next = proposed.data;
      ctx.operations.push(next.operationId); ctx.deployments.push(next.deploymentId);
      await ctx.approve(next.operationId);
      await ctx.action("deploy.approve", { deploymentId: next.deploymentId }, ctx.b!);
      const reviewed = await until(() => ctx.detail(next.operationId), (d: Awaited<ReturnType<Operated["detail"]>>) =>
        TERMINAL.includes(d.operation.status) || (d.operation.status === "awaiting_approval" && d.operation.approvalRound > 0));
      if (!TERMINAL.includes(reviewed.operation.status)) await ctx.approve(next.operationId);
      const terminal = await ctx.settle(next.operationId);
      ensure(terminal.operation.status === "failed" && /source|binding|github/i.test(terminal.operation.error ?? ""), "new-revoked-build-deploy-refused");
      ensure((await ctx.sql("select effect_id from platform.external_effects where workspace_id=$1 and operation_id=$2", [ctx.workspaceId, next.operationId])).length === 0, "new-revoked-proposal-no-dispatch");
      ensure((await ctx.sql("select operation_id from platform.evidence where workspace_id=$1 and operation_id=$2 and summary->>'kind'='build.provenance'", [ctx.workspaceId, next.operationId])).length === 0, "new-revoked-proposal-no-build");
    });
    await step("independent-source-readback", async () => {
      await ctx.eventReadback(operationId);
      const rows = await snapshotRows(ctx, operationId);
      ensure(rows.length === 1 && rows[0]!.snapshot_digest === initialDigest, "snapshot-not-recaptured");
      assertSnapshot(rows[0]!, { workspaceId: ctx.workspaceId, projectId: ctx.project!.id, environmentId: ctx.environmentId, operationId,
        commit: fixture.fixture.commit, archive: fixture.expectedArchive, dockerfile: fixture.fixture.dockerfile });
      const stats = await fixture.stats();
      ensure(stats.minted >= 1 && stats.authenticated >= 1 && stats.archiveReads >= 1 && stats.movedArchiveReads === 0, "private-authenticated-pinned-reads");
      const workloads = JSON.parse(await ctx.kubectl(["get", "deployments,jobs", "-o", "json"]));
      const owned = workloads.items.filter((v: { metadata: { annotations?: Record<string, string> } }) => v.metadata.annotations?.["zenith.dev/environment"] === ctx.environmentId);
      ensure(owned.length === 1 && owned[0].kind === "Deployment" && owned[0].metadata.uid === baseline.uid, "no-source-effect-after-revocation");
      const selector = Object.entries(owned[0].spec.selector.matchLabels).map(([key, value]) => key + "=" + value).join(",");
      const pods = JSON.parse(await ctx.kubectl(["get", "pods", "-l", selector, "-o", "json"]));
      const pod = assertRunningBuiltImage(owned[0], pods.items, baseline.image, baseline.platformDigest);
      ensure((await ctx.kubectl(["get", "--raw", `/api/v1/namespaces/zenith-j2/pods/${pod}:8080/proxy/`])).trim() === "zenith-j6-source-release", "successful-baseline-survives-revocation");
      const builds = await ctx.sql("select operation_id from platform.evidence where workspace_id=$1 and operation_id=$2 and summary->>'kind'='build.provenance'", [ctx.workspaceId, operationId]);
      ensure(builds.length === 0, "no-later-build-after-revocation");
      const effects = await ctx.sql("select effect_id from platform.external_effects where workspace_id=$1 and operation_id=$2", [ctx.workspaceId, operationId]);
      ensure(effects.length === 0, "no-provider-dispatch-after-revocation");
    });
  }, ["GitHub provider HTTP/OAuth is an authenticated local emulator; no live GitHub installation is established.",
    "J6 runtime, enforcing CNI and native toolchain are required operator preconditions; physical isolation and successful deployment are checked in the gated Mac lane, never inferred from declaration."]);
}
async function snapshotRows(ctx: Operated, operationId: string) {
  return until(() => ctx.sql<{ snapshot: unknown; snapshot_digest: string }>(
    "select snapshot,snapshot_digest from platform.approved_source_snapshots where workspace_id=$1 and project_id=$2 and environment_id=$3 and operation_id=$4",
    [ctx.workspaceId, ctx.project!.id, ctx.environmentId, operationId]), (rows: { snapshot: unknown; snapshot_digest: string }[]) => rows.length === 1);
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve("scripts/release/drivers/private-source.ts"))
  void driverCli(run, process.argv.slice(2)).then(code => { process.exitCode = code; });
