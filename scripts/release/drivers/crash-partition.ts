/** Owned process crash/network partition with durable recovery and independent writer readback. */
import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { prepareJoin, joinComposition } from "../../deploy/installation.mjs";
import { stagedComposition, stagingArguments } from "../../deploy/private-staging.mjs";
import { stagingImage } from "../../acceptance/default-stack/runtime.mjs";
import { installationLabel } from "../../acceptance/default-stack/config.mjs";
import { hostEnvironment } from "../../acceptance/default-stack/env.mjs";
import { mcp, pause, privateFile } from "../../../tests/e2e/default/support.mjs";
import { OwnedCleanup } from "./operated-contract";
import { runOperated, command, ensure, sha256, until, type OperatedSession } from "./operated";

interface Container {
  Id: string; Config: { Labels: Record<string, string> };
  HostConfig: { RestartPolicy: { Name: string } };
  State: { Running: boolean; Paused: boolean; ExitCode: number; Health?: { Status?: string } };
  NetworkSettings: { Networks: Record<string, unknown> };
}
/** Exact identity and installation labels are rechecked before EVERY worker mutation. */
async function worker(session: OperatedSession): Promise<Container> {
  const [value] = JSON.parse(await command("docker", ["inspect", session.stack.worker])) as Container[];
  ensure(value.Id === session.stack.worker && value.Config.Labels["io.zenith.installation"] === session.stack.state.applicationInstallationId && value.Config.Labels["com.docker.compose.service"] === "execution-worker", "worker-ownership");
  return value;
}
async function mutate(session: OperatedSession, args: string[]): Promise<void> { await worker(session); await command("docker", [...args, session.stack.worker]); }
/** Diagnostics only: structured log keys of a container (level, message key, failure category, error name/code, elided startup sentence), never values. */
async function logKeys(id: string): Promise<[string, number][]> {
  const logs = id ? await command("docker", ["logs", "--tail", "80", id]).catch(() => "") : "";
  const seen = new Map<string, number>();
  for (const line of logs.split("\n")) {
    try {
      const entry = JSON.parse(line) as { level?: string; msg?: string; failureCategory?: string; error?: string | { name?: string; code?: string }; err?: { name?: string; code?: string } };
      const failure = typeof entry.error === "object" ? entry.error : entry.err;
      // Startup failures carry a product-authored error sentence; key=value pairs, URLs, paths and long tokens are elided.
      const sentence = typeof entry.error === "string" ? entry.error.replace(/\b\w+=\S+/g, "…=…").replace(/[a-z]+:\/\/\S+/gi, "…url").replace(/(?:\/[^\s/]+){2,}/g, "…path").replace(/[A-Za-z0-9_+/=-]{24,}/g, "…").slice(0, 200) : undefined;
      const key = [entry.level, entry.msg, entry.failureCategory, failure?.name, failure?.code].filter(value => typeof value === "string").map(value => value!.replace(/[^A-Za-z0-9 ._:-]/g, "").slice(0, 80)).concat(sentence ? [sentence] : []).join(" | ");
      if (key) seen.set(key, (seen.get(key) ?? 0) + 1);
    } catch { seen.set("unstructured line", (seen.get("unstructured line") ?? 0) + 1); }
  }
  return [...seen].slice(-15);
}
/** The durable binding of an execution is its acknowledged start intent with the run id execute() started; operations.workflow_id is not written by any production path. */
async function durableStart(session: OperatedSession, env: NodeJS.ProcessEnv, operationId: string, workflowId: string, code: string): Promise<void> {
  const authority = (await session.detail(operationId)).authority;
  const runId = session.runIds.get(operationId);
  const durable = !!authority && !!runId && authority.startIntent?.phase === "acknowledged" && authority.startIntent.runId === runId
    && (authority.workflowId === null || authority.workflowId === workflowId);
  if (!durable && env.ZENITH_OPERATED_DIAGNOSTICS === "1") process.stderr.write(code + " authority " + JSON.stringify(authority ? {
    phase: authority.phase, status: authority.status, start: authority.startIntent?.phase ?? null, runMatches: authority.startIntent?.runId === runId,
    workflowId: authority.workflowId === null ? null : authority.workflowId === workflowId ? "match" : "other" } : null) + "\n");
  ensure(durable, code);
}

export async function crashPartitionDriver(receiptFile: string, env = process.env): Promise<number> {
  return runOperated({ scenarioId: "crash-partition", receiptFile, env }, async (session, step) => {
    const network = session.stack.state.applicationProjectName + "_installation";
    const original = await worker(session);
    ensure(original.State.Running && !original.State.Paused && original.HostConfig.RestartPolicy.Name === "unless-stopped" && Object.keys(original.NetworkSettings.Networks).length === 1 && network in original.NetworkSettings.Networks, "single-owned-worker-network");
    // Restoration is registered before the first kill/pause/disconnect can partly succeed.
    session.faults.add(async () => {
      let current = await worker(session);
      if (!(network in current.NetworkSettings.Networks)) {
        await command("docker", ["network", "connect", network, session.stack.worker]);
        ensure(network in (await worker(session)).NetworkSettings.Networks, "restored-worker-network");
      }
      current = await worker(session);
      if (current.State.Paused) await mutate(session, ["unpause"]);
      await mutate(session, ["update", "--restart=unless-stopped"]);
      if (!current.State.Running) await mutate(session, ["start"]);
      await until(() => worker(session), value => value.State.Running && !value.State.Paused && value.State.Health?.Status === "healthy", 240_000);
    });
    let crashOperation = "", crashWorkflow = "";
    await step("crash-injected", async () => {
      crashOperation = await session.propose(2); await session.approve(crashOperation);
      await mutate(session, ["update", "--restart=no"]);
      await mutate(session, ["kill", "--signal=KILL"]);
      const killed = await worker(session);
      ensure(!killed.State.Running && killed.State.ExitCode === 137, "actual-sigkill");
      crashWorkflow = await session.execute(crashOperation);
      await durableStart(session, env, crashOperation, crashWorkflow, "durable-during-crash");
    });
    await step("outage-traffic", async () => {
      ensure(!(await worker(session)).State.Running, "crash-outage-observed");
      session.readbacks.outage = await session.readback(1);
      await durableStart(session, env, crashOperation, crashWorkflow, "durable-crash-operation");
    });
    await step("restart-readback", async () => {
      await mutate(session, ["update", "--restart=unless-stopped"]);
      await mutate(session, ["start"]);
      await session.terminal(crashOperation);
      await durableStart(session, env, crashOperation, crashWorkflow, "same-crash-workflow");
      session.readbacks.restarted = await session.readback(2);
    });
    let partitionOperation = "", partitionWorkflow = "", peerId = "", peerProject = "", peerFile = "", peerWorkerId = "";
    let partitionGeneration = 0;
    await step("partition-injected", async () => {
      partitionOperation = await session.propose(1, "rest"); await session.approve(partitionOperation);
      await worker(session);
      await command("docker", ["network", "disconnect", network, session.stack.worker]);
      ensure(Object.keys((await worker(session)).NetworkSettings.Networks).length === 0, "worker-actually-partitioned");
      partitionGeneration = (await session.deployment()).metadata.generation;
      partitionWorkflow = await session.execute(partitionOperation);
    });
    await step("partition-no-write", async () => {
      // API/Temporal remain reachable and the independent app still serves; the isolated writer cannot mutate.
      await pause(5000);
      ensure(Object.keys((await worker(session)).NetworkSettings.Networks).length === 0, "partition-retained");
      ensure((await session.deployment()).metadata.generation === partitionGeneration, "partition-provider-no-write");
      session.readbacks.partition = await session.readback(2);
      const detail = await session.detail(partitionOperation);
      ensure(detail.operation.status === "running", "retained-partition-workflow");
      await durableStart(session, env, partitionOperation, partitionWorkflow, "retained-partition-workflow");
    });
    await step("survivor-readback", async () => {
      // J1's existing cleanup owns this exact private peer directory, including partial prepare failures.
      const peerDirectory = path.join(session.stack.state.directory, "worker-peer");
      const peer = prepareJoin(path.join(session.stack.state.directory, "installation/keyring.json"), peerDirectory);
      peerWorkerId = peer.workerId!;
      ensure(peerWorkerId !== session.stack.state.applicationInstallationId, "independent-peer-identity");
      const document = joinComposition(peer, peerDirectory);
      const service = document.services["execution-worker-" + peerWorkerId];
      // Retain canonical joined authority, user, capabilities, image and fresh scratch.
      service.mem_limit = "512m";
      service.volumes.push(path.join(session.stack.state.directory, "tls/ca.crt") + ":/run/zenith-ca.crt:ro");
      // The reconcile sweep input is part of the shared durable schedule contract: a joined worker must keep the
      // installation's values or it (correctly) refuses the existing schedule as incompatible.
      Object.assign(service, { environment: { NODE_EXTRA_CA_CERTS: "/run/zenith-ca.crt", NODE_OPTIONS: "--max-old-space-size=384", ZENITH_PLATFORM_DB_MAX: "2" } });
      // Native Linux keeps the host owner and 0600 mode on binds, which uid 10001 cannot read: bind the same
      // least-privilege uid-owned 0400 copies the stack's own compose uses (see private-staging.mjs). No-op elsewhere.
      const stageRoot = path.join(session.stack.state.directory, "staged");
      const staged = stagedComposition(document, { privateRoot: session.stack.state.directory, stageRoot });
      if (staged.copies.length) {
        fs.mkdirSync(stageRoot, { mode: 0o700, recursive: true });
        await command("docker", stagingArguments(staged.copies, { stageRoot, image: stagingImage(), labels: { [installationLabel]: session.stack.state.installationId } }));
      }
      peerFile = path.join(peerDirectory, "driver.compose.json");
      fs.writeFileSync(peerFile, JSON.stringify(staged.document), { mode: 0o600, flag: "wx" });
      const peerFileDigest = sha256(fs.readFileSync(peerFile, "utf8"));
      peerProject = "zenith-drv2-" + env.ZENITH_LOCAL_RUN_ID;
      const compose = (args: string[]) => {
        ensure(sha256(fs.readFileSync(peerFile, "utf8")) === peerFileDigest, "immutable-peer-composition");
        return command("docker", ["compose", "--project-name", peerProject, "-f", peerFile, ...args]);
      };
      ensure(!(await command("docker", ["ps", "-aq", "--filter", "label=com.docker.compose.project=" + peerProject])), "fresh-peer-project");
      ensure(!(await command("docker", ["volume", "ls", "-q", "--filter", "label=com.docker.compose.project=" + peerProject])), "fresh-peer-volumes");
      session.faults.add(async () => {
        // Canonical J1 teardown also owns the peer's installation-labelled resources.
        const ids = (await command("docker", ["ps", "-aq", "--filter", "label=com.docker.compose.project=" + peerProject])).split(/\s+/).filter(Boolean);
        for (const id of ids) {
          const [value] = JSON.parse(await command("docker", ["inspect", id])) as Container[];
          ensure(value.Config.Labels["io.zenith.installation"] === peer.installationId && value.Config.Labels["io.zenith.worker"] === peerWorkerId, "peer-cleanup-ownership");
        }
        const volumes = (await command("docker", ["volume", "ls", "-q", "--filter", "label=com.docker.compose.project=" + peerProject])).split(/\s+/).filter(Boolean);
        for (const volume of volumes) {
          const [value] = JSON.parse(await command("docker", ["volume", "inspect", volume])) as { Labels: Record<string, string> }[];
          ensure(value.Labels["io.zenith.installation"] === peer.installationId && value.Labels["io.zenith.worker"] === peerWorkerId, "peer-volume-ownership");
        }
        await compose(["down", "--volumes", "--timeout", "660"]);
        ensure(!(await command("docker", ["ps", "-aq", "--filter", "label=com.docker.compose.project=" + peerProject])), "peer-cleanup-absence");
        ensure(!(await command("docker", ["volume", "ls", "-q", "--filter", "label=com.docker.compose.project=" + peerProject])), "peer-volume-absence");
        // Keep private diagnostics, remove the exact copied worker credential file after absence.
        const files = new OwnedCleanup();
        for (const name of ["worker.env", "api.env", "migration.env", "compose.env", "installation.json"]) files.add(async () => {
          const file = path.join(peerDirectory, name);
          if (fs.existsSync(file)) { privateFile(file); fs.unlinkSync(file); }
        });
        await files.run();
      });
      await compose(["up", "-d", "--wait", "--wait-timeout", "240"]).catch(async error => {
        // Diagnostics only: structured log keys of the unready peer (level, message key, error name/code), never values.
        if (env.ZENITH_OPERATED_DIAGNOSTICS === "1") {
          const id = (await compose(["ps", "-aq", "execution-worker-" + peerWorkerId]).catch(() => "")).trim();
          process.stderr.write("peer-unready " + JSON.stringify(await logKeys(id)) + "\n");
        }
        throw error;
      });
      peerId = (await compose(["ps", "-q", "execution-worker-" + peerWorkerId])).trim();
      const [running] = JSON.parse(await command("docker", ["inspect", peerId])) as Container[];
      ensure(running.Config.Labels["io.zenith.worker"] === peerWorkerId && running.State.Running && running.State.Health?.Status === "healthy", "independent-survivor");
      await session.terminal(partitionOperation);
      await durableStart(session, env, partitionOperation, partitionWorkflow, "same-partition-workflow");
      session.readbacks.survivor = await session.readback(1);
    });
    let lastGeneration = 0;
    await step("writers-serialized", async () => {
      // Rejoin the original while a genuinely different joined worker is still polling.
      await worker(session); await command("docker", ["network", "connect", network, session.stack.worker]);
      if (!(await worker(session)).State.Running) await mutate(session, ["start"]);
      await until(() => worker(session), value => value.State.Health?.Status === "healthy", 240_000).catch(async () => {
        if (env.ZENITH_OPERATED_DIAGNOSTICS === "1") {
          const [state] = JSON.parse(await command("docker", ["inspect", "--format", "{{json .State}}", session.stack.worker]).then(text => "[" + text + "]").catch(() => "[{}]")) as { Status?: string; ExitCode?: number; Health?: { Status?: string; FailingStreak?: number } }[];
          const restarts = (await command("docker", ["inspect", "--format", "{{.RestartCount}}", session.stack.worker]).catch(() => "")).trim();
          process.stderr.write("rejoined-unready " + JSON.stringify({ status: state?.Status, exitCode: state?.ExitCode, health: state?.Health?.Status, failingStreak: state?.Health?.FailingStreak, restarts, logs: await logKeys(session.stack.worker) }) + "\n");
        }
        throw new Error("journey:rejoined-worker-unhealthy");
      });
      const first = await session.propose(2), second = await session.propose(3, "rest");
      await session.approve(first); await session.approve(second);
      // Same-environment writes are serialized by the environment lease: a concurrent start is refused as
      // lease_busy with nothing changed (src/lib/execution/errors.ts), so the two writes run one after the other
      // while both workers poll, and each must hold its own native fence.
      const runWriter = async (id: string) => { const workflow = await session.execute(id); await session.terminal(id); return workflow; };
      const writers = (async () => [await runWriter(first), await runWriter(second)] as const)();
      const [firstWorkflow, secondWorkflow] = await writers.catch(async (error: unknown) => {
        if (env.ZENITH_OPERATED_DIAGNOSTICS === "1") {
          // Status and the product's own error sentence, elided like other diagnostics (no values, paths, URLs or tokens).
          const elide = (text: unknown) => typeof text === "string" ? text.replace(/\b\w+=\S+/g, "…=…").replace(/[a-z]+:\/\/\S+/gi, "…url").replace(/(?:\/[^\s/]+){2,}/g, "…path").replace(/[A-Za-z0-9_+/=-]{24,}/g, "…").slice(0, 240) : undefined;
          const shape = async (id: string) => { const d = await session.detail(id); return { status: d.operation.status, error: elide((d.operation as { error?: unknown }).error), phase: d.authority?.phase }; };
          process.stderr.write("writers-terminal " + JSON.stringify({ first: await shape(first).catch(() => null), second: await shape(second).catch(() => null) }) + "\n");
        }
        throw error instanceof Error && error.message === "journey:readback-timeout" ? new Error("journey:writers-terminal-timeout") : error;
      });
      await durableStart(session, env, first, firstWorkflow, "first-writer-workflow");
      await durableStart(session, env, second, secondWorkflow, "second-writer-workflow");
      const url = (hostEnvironment(session.stack.state) as Record<string, string>).ZENITH_PLATFORM_DB_URL;
      const sql = postgres(url, { prepare: false, max: 1, connect_timeout: 10, ssl: { ca: fs.readFileSync(path.join(session.stack.state.directory, "tls/ca.crt"), "utf8"), rejectUnauthorized: true } });
      try {
        const rows = await sql.begin("read only", tx => tx`select id, status, fence_token::text, lease_scope, workflow_id from platform.operations where workspace_id=${session.workspaceId} and environment_id=${session.environmentId} and id in (${first},${second})`);
        ensure(rows.length === 2 && rows.every(row => row.status === "succeeded" && row.lease_scope === "env:" + session.environmentId && /^[1-9][0-9]*$/.test(row.fence_token)), "native-writer-fences");
        ensure(rows[0].fence_token !== rows[1].fence_token, "distinct-serialized-fences");
        const latest = [...rows].sort((a, b) => BigInt(a.fence_token) < BigInt(b.fence_token) ? -1 : 1).at(-1)!;
        const replicas = latest.id === first ? 2 : 3;
        await session.readback(replicas).catch((error: unknown) => {
          throw error instanceof Error && error.message === "journey:readback-timeout" ? new Error("journey:latest-writer-readback-timeout") : error;
        });
        session.readbacks.writers = sha256(rows);
      } finally { await sql.end({ timeout: 5 }); }
      lastGeneration = (await session.deployment()).metadata.generation;
    });
    await step("stale-writer-no-duplicate", async () => {
      // Replaying an already completed intent returns the original terminal outcome, never a second start.
      const replay = await mcp(session.stack, session.linked!.token, "tools/call", { name: "zenith_execute_approved_operation", arguments: { workspaceId: session.workspaceId, operationId: partitionOperation, expectedDigest: (await session.detail(partitionOperation)).operation.proposalDigest } });
      ensure(replay.data.startedNow === false && replay.data.status === "succeeded" && replay.data.operationId === partitionOperation, "no-second-start");
      await pause(5000);
      ensure((await session.deployment()).metadata.generation === lastGeneration && (await worker(session)).State.Running, "rejoined-no-provider-duplicate");
      const [peer] = JSON.parse(await command("docker", ["inspect", peerId])) as Container[];
      ensure(peer.State.Running && peer.Config.Labels["io.zenith.worker"] === peerWorkerId, "two-live-writers-readback");
      session.readbacks.rejoined = sha256(await session.deployment());
    });
  });
}
