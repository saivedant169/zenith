/**
 * A fixed, secret-free code for why an OpenTofu command failed: `<command>:<cause>`. The cause is the first known phrase in the
 * command's redacted output, or an AWS SDK error code (`api error <Code>`), or an HTTP status. Never the message text itself,
 * so it may ride along on an operation error that names nothing of the user's.
 */
import { TofuCommandError } from "@/lib/tofu/runner";

const CAUSES: [RegExp, (match: RegExpExecArray) => string][] = [
  [/Failed to (?:save|persist) state/, () => "state_save"],
  [/Error acquiring the state lock/, () => "state_lock"],
  [/Provider produced inconsistent (?:final plan|result after apply)/, () => "inconsistent_result"],
  [/Saved plan is stale/, () => "stale_plan"],
  [/api error ([A-Za-z]{2,48})/, (m) => `api_${m[1]}`],
  [/StatusCode: (\d{3})/, (m) => `http_${m[1]}`],
];
const COMMAND = /^[a-z-]{1,16}$/;

export function tofuFailureCode(err: unknown): string | undefined {
  if (!(err instanceof TofuCommandError)) return undefined;
  const command = COMMAND.test(err.result.command) ? err.result.command : "tofu";
  return `${command}:${tofuOutputCause(err.result.output ?? "")}`;
}

/** The fixed cause name for raw OpenTofu output (stdout and stderr), or `unknown`; never any of the output itself. */
export function tofuOutputCause(output: string): string {
  for (const [pattern, name] of CAUSES) {
    const match = pattern.exec(output);
    if (match) return name(match);
  }
  return "unknown";
}
