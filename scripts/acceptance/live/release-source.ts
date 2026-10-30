/**
 * Writes the release source for one requirement a recorded live run passed, from that run's published evidence.json
 * (REL-02). The packet must still carry its own digest; the source is then bound to the file's bytes. Nothing else is read,
 * and a requirement the run did not pass with cleanup complete gets no source.
 *
 *   npx tsx scripts/acceptance/live/release-source.ts --evidence <evidence.json> --requirement PROD-OPS-05 --out <release-source.json>
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { releaseSource } from "./evidence";
import { digest } from "./plan";

export function main(argv: readonly string[]): number {
  const value = (flag: string) => { const i = argv.indexOf(flag); return i < 0 ? undefined : argv[i + 1]; };
  const file = value("--evidence"), requirement = value("--requirement"), out = value("--out");
  try {
    if (!file || !requirement || !out) throw new Error("--evidence, --requirement and --out are required");
    const bytes = readFileSync(file);
    const packet = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
    const { sha256: own, ...rest } = packet;
    if (typeof own !== "string" || digest(rest) !== own) throw new Error("the evidence packet does not match its own digest");
    const source = releaseSource(packet, requirement, createHash("sha256").update(bytes).digest("hex"));
    if (!source) throw new Error(`the run did not pass ${requirement} with cleanup complete; no release source`);
    writeFileSync(out, `${JSON.stringify(source, null, 2)}\n`, { flag: "wx", mode: 0o644 });
    process.stdout.write(`${JSON.stringify({ requirement, commit: source.commit, runId: source.evidence.runId })}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "refused"}\n`);
    return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
