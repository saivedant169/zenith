/**
 * OPS-03 live: the runner's Zenith stack as a rolling-upgrade target, in the order scripts/ops/rolling-upgrade.mjs prints
 * (expand migration, then worker, then API; rollback API, then worker, never the schema), as DRV-3 drives it.
 *
 * Candidate images are rebuilt from this source with distinct rehearsal labels and pushed to the stack's owned registry
 * (default-stack/upgrade-candidates.mjs): they prove replacement of running services, not a released N-1/N matrix.
 * The composition file is rewritten for each replacement; close() puts the original bytes back so the stack's own
 * teardown still matches its recorded composition digest.
 *
 * Nothing here prints a URL, key or secret; refusals name the step only.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { Connection } from "@temporalio/client";
import type { EnvLike } from "../../config";
import { connectionOptionsFor, temporalConfigFromEnv } from "@/lib/workflows/config";
import { WORKFLOW_ID } from "@/lib/workflows/types";
import { compose, docker, readState } from "../../default-stack/runtime.mjs";
import { readPrepared } from "../../../deploy/installation.mjs";
import { upgradeImages } from "../../../release/drivers/contracts";
import { refuse } from "./mix-03";
import { named } from "./ops-04-stack";

export interface Ops03Images { api: string; worker: string; migration: string }
export interface Ops03History { runId: string; running: boolean; completed: boolean }
export interface Ops03Stack {
  /** Build the candidate images; returns them with the images running now (the rollback target). */
  candidates(): Promise<{ previous: Ops03Images; candidate: Ops03Images }>;
  /** Expand migration, then worker, then API onto `images`, each waited on until healthy on that exact image. */
  upgrade(images: Ops03Images): Promise<void>;
  /** API, then worker back onto `images`. The schema is never downgraded. */
  rollback(images: Ops03Images): Promise<void>;
  /** The operation's workflow as Temporal records it (raw describe: no payload is decoded). */
  history(operationId: string): Promise<Ops03History>;
  close(): Promise<void>;
}

type State = ReturnType<typeof readState> & { directory: string; compositionSha256: string; applicationInstallationId: string; installationId: string };
const run = promisify(execFile);
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

export function runnerOps03Stack(env: EnvLike, runId: string): Ops03Stack {
  const directory = env.ZENITH_DEFAULT_STACK_DIRECTORY?.trim() || refuse("no stack directory");
  const root = path.join(env.RUNNER_TEMP?.trim() || refuse("no runner temp"), "zenith-ops03");
  const original = readState(directory) as State;
  const file = path.join(original.directory, "installation", "stack.compose.json");
  const originalBytes = readFileSync(file);
  const namespace = (readPrepared(path.join(directory, "installation")) as { environment: Record<string, string> }).environment.ZENITH_TEMPORAL_NAMESPACE ?? refuse("no Temporal namespace");
  let active: State = original, connection: Connection | undefined;

  const imagesNow = (): Ops03Images => {
    const services = (JSON.parse(readFileSync(file, "utf8")) as { services: Record<string, { image?: string }> }).services;
    const image = (service: string) => services[service]?.image ?? refuse(`the composition has no ${service} image`);
    return { api: image("api"), worker: image("execution-worker"), migration: image("platform-migrate") };
  };
  const replace = (images: Ops03Images) => {
    const document = JSON.parse(readFileSync(file, "utf8")) as { services: Record<string, { image?: string }> };
    for (const [service, image] of [["api", images.api], ["execution-worker", images.worker], ["platform-migrate", images.migration]] as const) document.services[service]!.image = image;
    writeFileSync(file, JSON.stringify(document), { mode: 0o600 });
    active = { ...original, compositionSha256: sha(readFileSync(file)) };
  };
  const healthy = async (service: string, image: string) => {
    for (const deadline = Date.now() + 360_000; Date.now() < deadline; await new Promise(r => setTimeout(r, 5_000))) {
      const id = String(await compose(active, ["ps", "-q", service])).trim();
      if (!id) continue;
      const [item] = JSON.parse(String(await docker(["inspect", id]))) as { Config: { Image?: string; Labels?: Record<string, string> }; State: { Health?: { Status?: string } } }[];
      if (item?.Config.Labels?.["io.zenith.installation"] === original.applicationInstallationId && item.State.Health?.Status === "healthy" && item.Config.Image === image) return;
    }
    refuse(`the ${service} container was not healthy on its new image within 6 minutes`);
  };

  return {
    candidates: () => named("building the candidate images", async () => {
      if (existsSync(root)) refuse("the candidate directory already exists");
      mkdirSync(root, { recursive: true, mode: 0o700 });
      const out = path.join(root, "images.json"), previous = imagesNow();
      await run(process.execPath, ["scripts/acceptance/default-stack/upgrade-candidates.mjs"], {
        env: { ...process.env, ZENITH_ACCEPTANCE_DEFAULT_STACK: "1", ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR: directory, ZENITH_LOCAL_UPGRADE_IMAGES_FILE: out, ZENITH_LOCAL_RUN_ID: runId },
        timeout: 45 * 60_000, maxBuffer: 16 * 1024 * 1024,
      });
      const candidate = upgradeImages(JSON.parse(readFileSync(out, "utf8")), original.installationId, previous);
      return { previous, candidate };
    }),
    upgrade: (images) => named("the rolling upgrade", async () => {
      replace(images);
      await compose(active, ["run", "--rm", "--no-deps", "platform-migrate", "--dry-run"]);
      await compose(active, ["run", "--rm", "--no-deps", "platform-migrate"]);
      await compose(active, ["up", "-d", "--no-deps", "execution-worker"]);
      await healthy("execution-worker", images.worker);
      await compose(active, ["up", "-d", "--no-deps", "api"]);
      await healthy("api", images.api);
      await compose(active, ["run", "--rm", "--no-deps", "platform-migrate", "--status"]);
    }),
    rollback: (images) => named("the rollback", async () => {
      replace(images);
      await compose(active, ["up", "-d", "--no-deps", "api"]);
      await healthy("api", images.api);
      await compose(active, ["up", "-d", "--no-deps", "execution-worker"]);
      await healthy("execution-worker", images.worker);
    }),
    history: (operationId) => named("the workflow readback", async () => {
      connection ??= await Connection.connect(connectionOptionsFor(temporalConfigFromEnv({ ...env, ZENITH_TEMPORAL_NAMESPACE: namespace } as unknown as NodeJS.ProcessEnv)));
      const response = await connection.workflowService.describeWorkflowExecution({ namespace, execution: { workflowId: WORKFLOW_ID(operationId) } });
      const info = response.workflowExecutionInfo;
      // WORKFLOW_EXECUTION_STATUS_RUNNING = 1, _COMPLETED = 2.
      return { runId: info?.execution?.runId ?? "", running: info?.status === 1, completed: info?.status === 2 };
    }),
    async close() {
      await connection?.close().catch(() => undefined);
      writeFileSync(file, originalBytes, { mode: 0o600 });
    },
  };
}
