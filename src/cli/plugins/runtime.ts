import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { LaunchBinding, LaunchLease } from "./authority";
import { LauncherError } from "./authority";

export interface SandboxSpec {
  image: string;
  scratch: string;
  ca: boolean;
  bootstrap: { token: string; binding: LaunchBinding; lease: LaunchLease; apiOrigin: string; artifactDigest: string; args: string[]; env: Record<string, string> };
}
export interface RunningSandbox { wait(): Promise<number>; stop(): Promise<void> }
export interface ContainerRuntime { start(spec: SandboxSpec): Promise<RunningSandbox> }

/** These arguments are the production runtime and the contract test seam. */
export function containerArgs(spec: SandboxSpec, name: string, volume: string, gateway: boolean): string[] {
  if (spec.scratch.includes(",") || spec.scratch.includes("\n")) throw new LauncherError("invalid_scratch_path");
  return ["create", "--name", name, "--label", `zenith.plugin.launch=${volume}`, "--pull", "never",
    "--network", gateway ? "bridge" : "none", "--read-only", "--user", "65532:65532", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges=true", "--pids-limit", "32", "--memory", "128m", "--memory-swap", "128m", "--cpus", "0.25",
    "--restart", "no", "--log-driver", "none", "--interactive",
    "--mount", `type=bind,src=${spec.scratch},dst=/zenith,readonly`,
    "--mount", `type=volume,src=${volume},dst=/channel${gateway ? "" : ",readonly"}`,
    "--tmpfs", "/work:rw,noexec,nosuid,nodev,size=67108864,uid=65532,gid=65532,mode=0700",
    "--workdir", "/work", ...(spec.ca && gateway ? ["--env", "NODE_EXTRA_CA_CERTS=/zenith/ca.pem"] : []),
    "--entrypoint", "node", spec.image, `/zenith/${gateway ? "gateway" : "runner"}.mjs`];
}

export class DockerRuntime implements ContainerRuntime {
  private command(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile("docker", args, { timeout: 15_000, maxBuffer: 65_536, windowsHide: true }, (error, stdout) => {
        if (error) reject(new LauncherError("container_runtime_failed")); else resolve(stdout.trim());
      });
    });
  }
  async start(spec: SandboxSpec): Promise<RunningSandbox> {
    if (await this.command(["info", "--format", "{{.OSType}}"]) !== "linux") throw new LauncherError("linux_container_runtime_required");
    const volume = `zenith-plugin-${randomUUID()}`;
    const gatewayName = `${volume}-gateway`; const pluginName = `${volume}-process`;
    let volumeCreated = false; const created: string[] = [];
    const attachments: ReturnType<typeof spawn>[] = [];
    const stop = async () => {
      // rm --force sends SIGKILL and removes the whole container cgroup, even
      // when an untrusted child ignores TERM or forks. Never rely on killing
      // just the local docker attach client.
      let failed = false;
      for (const name of [...created].reverse()) {
        try { await this.command(["rm", "--force", name]); } catch { failed = true; }
      }
      if (volumeCreated) {
        try { await this.command(["volume", "rm", volume]); } catch { failed = true; }
      }
      for (const child of attachments) child.kill();
      if (failed) throw new LauncherError("sandbox_cleanup_failed");
    };
    try {
      await this.command(["volume", "create", "--label", `zenith.plugin.launch=${volume}`, "--driver", "local", "--opt", "type=tmpfs", "--opt", "device=tmpfs", "--opt", "o=size=1048576,uid=65532,gid=65532,mode=0700,nodev,noexec,nosuid", volume]);
      volumeCreated = true;
      const attach = (name: string, gateway: boolean) => {
        const child = spawn("docker", ["start", "--attach", "--interactive", name], { windowsHide: true, stdio: ["pipe", gateway ? "pipe" : "ignore", "ignore"] });
        attachments.push(child);
        let readyResolve: (() => void) | undefined;
        let readyReject: ((error: Error) => void) | undefined;
        const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
        void ready.catch(() => {});
        let output = "";
        child.stdout?.on("data", (data: Buffer) => {
          output += data.toString("utf8");
          if (output.length > 1024) { readyReject?.(new LauncherError("sandbox_gateway_invalid")); child.kill(); }
          if (output.includes('{"event":"ready"}\n')) readyResolve?.();
        });
        const done = new Promise<number>((resolve, reject) => {
          child.on("error", () => { readyReject?.(new LauncherError("container_runtime_failed")); reject(new LauncherError("container_runtime_failed")); });
          child.on("close", (code) => { readyReject?.(new LauncherError("sandbox_gateway_stopped")); if (code === null) reject(new LauncherError("container_runtime_failed")); else resolve(code); });
        });
        void done.catch(() => {});
        child.stdin?.on("error", () => readyReject?.(new LauncherError("container_runtime_failed")));
        // Secret only on an anonymous pipe, never argv, Docker env, files or logs. Only the gateway
        // holds the child token; the plugin process never receives it (it reaches the API only via the gateway).
        const { token: _token, ...pluginBootstrap } = spec.bootstrap;
        child.stdin?.end(JSON.stringify(gateway ? spec.bootstrap : pluginBootstrap) + "\n");
        return { ready, done };
      };
      await this.command(containerArgs(spec, gatewayName, volume, true)); created.push(gatewayName);
      const gateway = attach(gatewayName, true);
      let readyTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([gateway.ready, new Promise<never>((_resolve, reject) => { readyTimer = setTimeout(() => reject(new LauncherError("sandbox_gateway_timeout")), 10_000); })]);
      } finally { if (readyTimer) clearTimeout(readyTimer); }
      await this.command(containerArgs(spec, pluginName, volume, false)); created.push(pluginName);
      const plugin = attach(pluginName, false);
      return {
        wait: () => Promise.race([plugin.done, gateway.done.then(() => { throw new LauncherError("sandbox_gateway_stopped"); })]),
        stop,
      };
    } catch (error) { await stop(); throw error; }
  }
}
