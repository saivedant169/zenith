/** DRV-3: operated expand/worker/API replacement, injected outage and image rollback. */
import { Connection, WorkflowClient } from "@temporalio/client";
import { connectionOptionsFor, temporalConfigFromEnv } from "../../../src/lib/workflows/config";
import { WORKFLOW_ID } from "../../../src/lib/workflows/types";
import { compose, docker } from "../../acceptance/default-stack/runtime.mjs";
import { GATE_SUITES, buildPlan, parseArgs } from "../../ops/rolling-upgrade.mjs";
import { ensure, privateFile, kindReadback, NATIVE } from "../../../tests/e2e/default/support.mjs";
import { upgradeImages, type Images } from "./contracts";
import { operatedRun, driverCli, type DriverInput } from "./operated";

/** The existing runbook is the ordering authority; J1 supplies the concrete topology. */
export function upgradeOrder(images: Images): string[] {
  return buildPlan(parseArgs(["upgrade", "--topology", "compose", "--api-image", images.api, "--worker-image", images.worker, "--migration-image", images.migration]))
    .map((step: { id: string }) => step.id);
}
if (process.argv[1] && /[/\\]drivers[/\\]upgrade\.(?:ts|js)$/.test(process.argv[1])) void driverCli("upgrade", runUpgrade).then(code => { process.exitCode = code; });
export async function runUpgrade(input: DriverInput): Promise<number> {
  ensure(input.scenarioId === "upgrade", "scenario-binding");
  return operatedRun(input, async session => {
    const file = input.env.ZENITH_LOCAL_UPGRADE_IMAGES_FILE;
    ensure(file, "private-candidate-file");
    const previous: Images = session.prepared.images;
    const candidate = upgradeImages(JSON.parse(privateFile(file!)), session.state.installationId, previous);
    for (const [role, reference] of Object.entries(candidate)) {
      const [image] = JSON.parse(await docker(["image", "inspect", reference]));
      ensure(image.Architecture === NATIVE?.image && image.Config.Labels?.["io.zenith.installation"] === session.state.installationId
        && image.RepoDigests?.includes(reference) && image.Id !== JSON.parse(await docker(["image", "inspect", previous[role as keyof Images]]))[0].Id, "candidate-native-owned-distinct");
    }
    await session.step("compatibility-gates", () => session.gates(GATE_SUITES, { ZENITH_REPLAY_LANE: "1" }));
    let operationId = "", workflowId = "", runId = "";
    // A host Temporal client failure is named by its class (no message): config, TLS files or transport.
    const connection = await (async () => Connection.connect(connectionOptionsFor(temporalConfigFromEnv(session.environment))))().catch((error: unknown) => {
      throw new Error("journey:host-temporal-" + (error instanceof Error && /^[A-Za-z]{1,40}$/.test(error.name) ? error.name.toLowerCase() : "connect"));
    });
    session.finalizers.unshift(() => connection.close());
    const temporal = new WorkflowClient({ connection, namespace: session.prepared.environment.ZENITH_TEMPORAL_NAMESPACE });
    // Run id and status from the raw RPC: handle.describe() decodes memo/search attributes with the default
    // converter and refuses the product's encrypted payloads (ValueError); identity needs no payload key.
    const describe = async (id: string): Promise<{ runId: string; running: boolean }> => {
      const response = await connection.workflowService.describeWorkflowExecution({ namespace: session.prepared.environment.ZENITH_TEMPORAL_NAMESPACE, execution: { workflowId: id } });
      const info = response.workflowExecutionInfo;
      return { runId: info?.execution?.runId ?? "", running: info?.status === 1 /* WORKFLOW_EXECUTION_STATUS_RUNNING */ };
    };
    await session.step("browser-review-in-flight", async () => {
      operationId = (await session.deployReview()).operationId;
      // The durable binding is the acknowledged start intent; no production path writes operations.workflow_id.
      const authority = (await session.detail(operationId)).authority;
      const start = authority?.startIntent;
      workflowId = WORKFLOW_ID(operationId);
      ensure(start?.phase === "acknowledged" && !!start.runId && (authority!.workflowId === null || authority!.workflowId === workflowId), "real-operation-workflow");
      const description = await describe(workflowId);
      ensure(description.running && description.runId === start!.runId, "in-flight-history"); runId = description.runId;
    });
    await session.step("expand-worker-api", async () => {
      const order = upgradeOrder(candidate);
      ensure(order.indexOf("migrate") < order.indexOf("worker") && order.indexOf("worker-ready") < order.indexOf("api"), "runbook-order");
      const target = await session.replacement(candidate);
      await compose(target, ["run", "--rm", "--no-deps", "platform-migrate", "--dry-run"]);
      await compose(target, ["run", "--rm", "--no-deps", "platform-migrate"]);
      await compose(target, ["up", "-d", "--no-deps", "execution-worker"]);
      await session.healthy(target, "execution-worker", candidate.worker);
      await compose(target, ["up", "-d", "--no-deps", "api"]);
      await session.healthy(target, "api", candidate.api);
      await compose(target, ["run", "--rm", "--no-deps", "platform-migrate", "--status"]);
    });
    await session.step("candidate-readback", async () => {
      const detail = await session.detail(operationId);
      ensure(detail.operation.status === "awaiting_approval", "review-preserved");
      const current = await describe(workflowId);
      ensure(current.runId === runId && current.running, "same-history-after-upgrade");
    });
    await session.step("api-failure-injected", async () => {
      await compose(session.activeState, ["stop", "api"]);
      const id = (await compose(session.activeState, ["ps", "--all", "-q", "api"])).trim();
      ensure(JSON.parse(await docker(["inspect", id]))[0].State.Running === false, "api-stopped-readback");
      const unavailable = await fetch(session.stack.apiUrl + "/api/health", { redirect: "error", signal: AbortSignal.timeout(3000) }).then(r => !r.ok, () => true);
      ensure(unavailable, "api-outage-observed");
    });
    await session.step("rollback-readback", async () => {
      const rollback = await session.replacement(previous);
      // OPS-03 reverse roll: API, worker. Never downgrade the schema.
      await compose(rollback, ["up", "-d", "--no-deps", "api"]); await session.healthy(rollback, "api", previous.api);
      await compose(rollback, ["up", "-d", "--no-deps", "execution-worker"]); await session.healthy(rollback, "execution-worker", previous.worker);
      const description = await describe(workflowId);
      ensure(description.runId === runId && description.running, "same-history-after-rollback");
      ensure((await session.detail(operationId)).operation.status === "awaiting_approval", "rollback-review");
    });
    await session.step("approved-execution-readback", async () => {
      await session.completeDeploy(operationId);
      await kindReadback(session.config, 1, session.marker);
      const history = await temporal.getHandle(workflowId).fetchHistory();
      ensure(history.events?.some(event => event.workflowExecutionCompletedEventAttributes), "workflow-completion-history");
      const records = await session.db.query<{ n: number }>("select count(*)::int as n from platform.operations where workspace_id=$1 and id=$2 and status='succeeded'", [session.workspaceId, operationId]);
      ensure(records[0].n === 1, "one-terminal-operation");
    });
  });
}
