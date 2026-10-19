import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runDiagnostic } from "../_support/postgres-autocommit-wire.mjs";

function resolvedPostgresVersion(): string {
  let directory = dirname(fileURLToPath(import.meta.resolve("postgres")));
  for (let depth = 0; depth < 4; depth += 1) {
    try {
      const metadata = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as {
        name?: string;
        version?: string;
      };
      if (metadata.name === "postgres") return metadata.version ?? "";
    } catch {
      // Keep the lookup bounded while walking toward the package root.
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error("could not resolve postgres package metadata within four parents");
}

describe("Postgres.js autocommit wire boundary", () => {
  it("guards the diagnostic against an unreviewed Postgres.js version", () => {
    expect(resolvedPostgresVersion()).toBe("3.4.7");
  });

  it("holds the next autocommit query until ReadyForQuery when requested", async () => {
    const diagnostic = await runDiagnostic();
    expect(diagnostic.kind).toBe("actual-postgresjs-in-memory-simple-query-boundary");
    expect(diagnostic.version).toBe("3.4.7");
    expect(diagnostic.acceptanceClaim).toBe(false);
    expect(diagnostic.realPoolerReproduction).toBe(false);
    expect(diagnostic.elapsedMs).toBeLessThan(10_000);
    expect(diagnostic.cases).toHaveLength(3);

    const [baseline, guarded, errorRecovery] = diagnostic.cases;
    expect(baseline).toMatchObject({
      guarded: false,
      errorCase: false,
      networkSockets: 0,
      explicitReadyBarrier: true,
      secondFrontendBeforeFirstReady: true,
    });
    expect(guarded).toMatchObject({
      guarded: true,
      errorCase: false,
      networkSockets: 0,
      explicitReadyBarrier: true,
      secondFrontendBeforeFirstReady: false,
    });
    expect(errorRecovery).toMatchObject({
      guarded: true,
      errorCase: true,
      networkSockets: 0,
      explicitReadyBarrier: true,
      secondFrontendBeforeFirstReady: false,
    });
  });
});
