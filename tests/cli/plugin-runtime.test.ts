import { describe, expect, it, beforeEach, vi } from "vitest";
import { DockerRuntime, type SandboxSpec } from "@/cli/plugins/runtime";
import { launchFixture } from "../plugins/launcher-support";

const model = vi.hoisted(() => ({ commands: [] as string[][], pipes: [] as string[], children: [] as {
  emit(event: string, ...args: unknown[]): boolean;
}[], fail: "", linux: true }));
vi.mock("node:child_process", async () => {
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  return {
    execFile: (_command: string, args: string[], _options: unknown, done: (error: Error | null, output: string) => void) => {
      model.commands.push(args);
      const failed = model.fail === "plugin-create" ? args[0] === "create" && args[2].endsWith("-process") : model.fail === "plugin-remove" && args[0] === "rm" && args[2].endsWith("-process");
      queueMicrotask(() => done(failed ? new Error("modeled daemon failure") : null, args[0] === "info" ? (model.linux ? "linux" : "windows") : "owned-id"));
    },
    spawn: () => {
      const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), kill: vi.fn() });
      child.stdin.on("data", (value: Buffer) => model.pipes.push(value.toString()));
      model.children.push(child);
      queueMicrotask(() => child.stdout.write('{"event":"ready"}\n'));
      return child;
    },
  };
});

beforeEach(() => { model.commands = []; model.children = []; model.pipes = []; model.fail = ""; model.linux = true; });
const spec = (): SandboxSpec => {
  const f = launchFixture();
  return { image: f.input.image, scratch: "/owned-scratch", ca: false, bootstrap: {
    token: f.input.token, binding: f.binding, lease: f.lease, apiOrigin: f.input.apiOrigin,
    artifactDigest: f.manifest.artifact.digest.slice(7), args: ["${CLAUDE_PLUGIN_ROOT}/main.mjs"], env: {},
  } };
};

describe("Docker runtime [modeled daemon commands, NOT engine proof]", () => {
  it("starts gateway before plugin, transports only a scoped token over pipes, and force removes both cgroups and volume", async () => {
    const input = spec(); const running = await new DockerRuntime().start(input);
    expect(model.commands.filter((args) => args[0] === "create").map((args) => args[2].split("-").at(-1))).toEqual(["gateway", "process"]);
    expect(model.commands.flat().join()).not.toContain(input.bootstrap.token);
    expect(model.pipes).toHaveLength(2); expect(JSON.parse(model.pipes[0]).token).toBe(input.bootstrap.token);
    // The plugin process never receives the child token.
    expect(model.pipes[1]).not.toContain(input.bootstrap.token); expect(JSON.parse(model.pipes[1])).not.toHaveProperty("token");
    const done = running.wait(); model.children[1].emit("close", 0); await expect(done).resolves.toBe(0);
    await running.stop();
    const removals = model.commands.filter((args) => args[0] === "rm");
    expect(removals).toHaveLength(2); expect(removals[0][2]).toMatch(/-process$/); expect(removals[1][2]).toMatch(/-gateway$/);
    expect(removals.every((args) => args[1] === "--force")).toBe(true);
    expect(model.commands.at(-1)).toEqual(["volume", "rm", expect.stringMatching(/^zenith-plugin-/)]);
  });
  it("refuses a non-Linux daemon without creating resources", async () => {
    model.linux = false; await expect(new DockerRuntime().start(spec())).rejects.toThrow("linux_container_runtime_required");
    expect(model.commands).toHaveLength(1); expect(model.children).toHaveLength(0);
  });
  it("rolls back the gateway and volume if plugin creation fails", async () => {
    model.fail = "plugin-create"; await expect(new DockerRuntime().start(spec())).rejects.toThrow("container_runtime_failed");
    expect(model.commands.filter((args) => args[0] === "rm")).toEqual([["rm", "--force", expect.stringMatching(/-gateway$/)]]);
    expect(model.commands.at(-1)?.slice(0, 2)).toEqual(["volume", "rm"]);
  });
  it("forces the plugin down when the gateway exits", async () => {
    const running = await new DockerRuntime().start(spec()); const done = running.wait();
    model.children[0].emit("close", 0); await expect(done).rejects.toThrow("sandbox_gateway_stopped");
    await running.stop(); expect(model.commands.filter((args) => args[0] === "rm")).toHaveLength(2);
  });
  it("attempts all cleanup operations and surfaces removal failure", async () => {
    const running = await new DockerRuntime().start(spec()); model.fail = "plugin-remove";
    await expect(running.stop()).rejects.toThrow("sandbox_cleanup_failed");
    expect(model.commands.filter((args) => args[0] === "rm")).toHaveLength(2);
    expect(model.commands.at(-1)?.slice(0, 2)).toEqual(["volume", "rm"]);
  });
});
