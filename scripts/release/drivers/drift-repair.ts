/** Operated replica drift -> REST proposal -> independent browser approval -> MCP execution. */
import { browserRequest, ok } from "../../../tests/e2e/default/support.mjs";
import { runOperated, ensure, sha256, until, type OperatedSession } from "./operated";

interface Drift {
  report: { computedAt: string; simulated: boolean; graphDigest: string; unobserved: unknown[];
    findings: { address: string; class: string; fields?: { attribute: string; desired: unknown; observed: unknown }[] }[] } | null;
  truncated: boolean;
}
async function observation(session: OperatedSession): Promise<Drift> {
  return ok(await browserRequest(session.a, "/api/platform/v1/environments/" + session.environmentId + "/drift", undefined, "GET", session.workspaceId)) as Drift;
}
const complete = (value: Drift, after: number) => !!value.report && value.report.simulated === false && value.truncated === false && value.report.unobserved.length === 0 && Date.parse(value.report.computedAt) > after;

export async function driftRepairDriver(receiptFile: string, env = process.env): Promise<number> {
  return runOperated({ scenarioId: "drift-repair", receiptFile, env }, async (session, step) => {
    let injectedAt = 0, observedAt = 0;
    await step("drift-injected", async () => {
      await session.deployment(); // Exact environment and nonce ownership before fault injection.
      injectedAt = Date.now();
      await session.kubectl(["scale", "deployment/witness", "--replicas=2", "--current-replicas=1"]);
      await session.readback(2);
    });
    await step("drift-observed", async () => {
      // Natural default reconcile schedule, never a seeded finding or forged timer.
      const value = await until(() => observation(session), value => complete(value, injectedAt) && value.report!.findings.some(finding => finding.address === "container_service/witness" && finding.class === "changed" && finding.fields?.some(field => field.attribute === "replicas" && field.desired === 1 && field.observed === 2)), 360_000);
      observedAt = Date.parse(value.report!.computedAt);
      session.readbacks.drift = sha256(value.report);
    });
    let operationId = "";
    await step("repair-browser-approved", async () => { operationId = await session.propose(1, "rest"); await session.approve(operationId); });
    await step("repair-independent-readback", async () => {
      await session.execute(operationId); await session.terminal(operationId);
      session.readbacks.repaired = await session.readback(1);
    });
    await step("fresh-clean-observation", async () => {
      const repairedAt = Math.max(Date.now(), observedAt);
      let last: Drift | undefined;
      const value = await until(() => observation(session).then(read => (last = read)), value => complete(value, repairedAt) && value.report!.findings.length === 0, 360_000)
        .catch(error => {
          // Shape only: freshness, coverage and finding classes/attributes, never observed values.
          if (env.ZENITH_OPERATED_DIAGNOSTICS === "1") process.stderr.write("clean-observation last " + JSON.stringify(last?.report ? {
            simulated: last.report.simulated, truncated: last.truncated, unobserved: last.report.unobserved.length, fresh: Date.parse(last.report.computedAt) > repairedAt,
            ageSeconds: Math.round((Date.now() - Date.parse(last.report.computedAt)) / 1000),
            findings: last.report.findings.slice(0, 10).map(finding => ({ address: finding.address.replace(/[^a-z0-9_/.-]/gi, "").slice(0, 80), class: finding.class,
              attributes: (finding.fields ?? []).map(field => field.attribute.replace(/[^a-z0-9_.-]/gi, "").slice(0, 60)) })),
          } : { report: null }) + "\n");
          throw error;
        });
      ensure(value.report!.graphDigest.length === 64, "clean-graph-digest");
      session.readbacks.clean = sha256(value.report);
    });
  });
}
