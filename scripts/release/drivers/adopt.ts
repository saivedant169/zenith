/** J15 LIFE-11 adoption on the owned kind cluster through the product API (journey in adopt-kind.ts). */
import { pathToFileURL } from "node:url";
import { ensure } from "../../../tests/e2e/default/support.mjs";
import { runOperated, runDriverCli, type DriverInput } from "./operated";
import { operatedAdoption } from "./adopt-kind";

export async function runAdopt(input: DriverInput): Promise<number> {
  ensure(input.scenarioId === "adopt", "scenario-binding");
  return runOperated(input, operatedAdoption);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void runDriverCli("adopt", runAdopt).then(code => { process.exitCode = code; });
