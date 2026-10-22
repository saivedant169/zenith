import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fixtureResponse, sourceArchive } from "../../../scripts/release/drivers/github-emulator.mjs";
import { githubFixture } from "../../../scripts/release/drivers/github-fixture";

const support = vi.hoisted(() => ({ command: vi.fn(), kubeconfig: vi.fn(), until: vi.fn() }));
vi.mock("../../../scripts/release/drivers/operated", async () => {
  const { createHash } = await import("node:crypto");
  return { hash: (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex") };
});

vi.mock("../../../tests/e2e/default/support.mjs", () => ({
  ensure: (condition: unknown, code: string) => { if (!condition) throw new Error(code); },
  command: support.command,
  kubeconfig: support.kubeconfig,
  privateFile: () => { throw new Error("unexpected private fixture read"); },
  until: support.until,
}));

const roots: string[] = [];
afterEach(() => { vi.clearAllMocks(); while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function localFixtureContext(onInitialApiInspect: () => void) {
  const root = mkdtempSync(path.join(os.tmpdir(), "zenith-source-snapshot-test-")); roots.push(root);
  const scratch = path.join(root, "scratch"), stackDirectory = path.join(root, "stack");
  const installation = path.join(stackDirectory, "installation"), tls = path.join(stackDirectory, "tls");
  mkdirSync(scratch); mkdirSync(installation, { recursive: true }); mkdirSync(tls, { recursive: true });
  writeFileSync(path.join(installation, "stack.compose.json"), JSON.stringify({ services: { api: { environment: {} }, "execution-worker": { environment: {} } } }));
  writeFileSync(path.join(tls, "ca.crt"), "fixture CA");
  support.kubeconfig.mockReturnValue({ caData: "fixture CA" });
  support.command.mockImplementation(async (_name: string, args: string[]) => {
    const out = args.indexOf("-out"), keyout = args.indexOf("-keyout");
    if (keyout >= 0) writeFileSync(args[keyout + 1]!, "fixture key");
    if (out >= 0) writeFileSync(args[out + 1]!, "fixture certificate");
    return "";
  });
  support.until.mockImplementation(async (request: () => Promise<unknown>, accept: (value: never) => boolean) => {
    const response = await request();
    if (!accept(response as never)) throw new Error("fixture wait refused");
    return response;
  });

  const project = "fixture-j1", installationId = "fixture-installation", network = project + "_installation";
  const api = { Id: "api-id", Image: "zenith-api:fixture", NetworkSettings: { Networks: { [network]: { IPAddress: "172.18.0.9" } } },
    Config: { Labels: { "io.zenith.installation": installationId } } };
  let seededFixture: Record<string, unknown> | undefined;
  const docker = vi.fn(async (argv: string[], options?: { input?: string }) => {
    if (argv[0] === "run" && options?.input) {
      const files = JSON.parse(options.input).files as Record<string, string>;
      seededFixture = JSON.parse(files["fixture.json"]!) as Record<string, unknown>;
      return "";
    }
    if (argv[0] === "inspect" && argv[1] === "api-container") { onInitialApiInspect(); return JSON.stringify([api]); }
    if (argv[0] === "exec" && argv[1] === api.Id) return "1000";
    if (argv[0] === "container" && argv[1] === "ls") return "";
    if (argv[0] === "volume" && argv[1] === "create") return argv.at(-1)!;
    if (argv[0] === "create") return "owned-container-id";
    if (argv[0] === "start") return "owned-container-id";
    if (argv[0] === "container" && argv[1] === "inspect" && argv[2]?.startsWith("zenith-drv1-")) {
      const id = argv[2]!.slice("zenith-drv1-".length);
      return JSON.stringify([{ Id: "owned-container-id", Name: "/" + argv[2], Config: { Labels: { "io.zenith.drv1": id } },
        NetworkSettings: { Networks: { [network]: { IPAddress: "172.18.0.10" } } } }]);
    }
    if (argv[0] === "compose" && argv.includes("up")) return "";
    throw new Error("unexpected Docker fixture command: " + argv.join(" "));
  });
  const ctx = {
    githubPort: 40443,
    stack: { state: { applicationProjectName: project, applicationInstallationId: installationId, directory: stackDirectory },
      modules: { docker }, api: "api-container", apiUrl: "https://api.fixture.local" },
    env: { ZENITH_LOCAL_SOURCE_BUILD_DECLARATION_FILE: path.join(root, "declaration.json") },
    config: { kind: { kubeconfigFile: path.join(root, "kubeconfig"), server: "https://127.0.0.1" }, image: "kind" },
    workspaceId: "workspace", environmentId: "environment", scratch, cleaners: [],
    request: async () => ({ status: 200, data: { appConfigured: true } }),
    a: { route: async () => undefined },
  };
  return { ctx: ctx as never, docker, seededFixture: () => seededFixture };
}

describe("J6 source archive Dockerfile entry snapshot", () => {
  it("uses one entry-time Dockerfile snapshot for expected digest and later wire fixture", async () => {
    const entryDockerfile = "FROM scratch\nCOPY app.c /src/app.c\n";
    const changedDockerfile = "FROM scratch\nRUN changed after fixture setup\n";
    const sourceFixture = { appC: "int main(void) { return 0; }\n", migrationSql: "CREATE TABLE t(id integer);\n" };
    const built = { profile: {} as never, dockerfile: entryDockerfile, sourceFixture };
    let initialInspectObserved = false;
    const { ctx, seededFixture } = localFixtureContext(() => { initialInspectObserved = true; built.dockerfile = changedDockerfile; });
    const result = await githubFixture(ctx, built as never);
    const capturedFixture = seededFixture() as { dockerfile: string; sourceFixture: typeof sourceFixture; commit: string; installationToken: string };

    expect(initialInspectObserved).toBe(true);
    expect(built.dockerfile).toBe(changedDockerfile);
    expect(result.fixture.dockerfile).toBe(entryDockerfile);
    expect(capturedFixture.dockerfile).toBe(entryDockerfile);
    expect(capturedFixture.sourceFixture).toEqual(sourceFixture);
    expect(result.expectedArchive).toBe(sha(sourceArchive(entryDockerfile, "", undefined, sourceFixture)));
    expect(result.expectedArchive).not.toBe(sha(sourceArchive(changedDockerfile, "", undefined, sourceFixture)));
    const wire = fixtureResponse(capturedFixture, { refused: 0, archiveReads: 0, movedArchiveReads: 0, moved: false, revoked: false }, {
      host: "codeload.github.com", url: "/zenith-local/private-source/tar.gz/" + capturedFixture.commit,
      method: "GET", authorization: "Bearer " + capturedFixture.installationToken,
    });
    expect(wire.status).toBe(200);
    expect(Buffer.from(wire.body)).toEqual(sourceArchive(entryDockerfile, "fixture-/", undefined, sourceFixture));
  });
});
