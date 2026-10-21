/**
 * PROD-LIFE-12 autoscaler clause, checked by real OpenTofu semantics.
 *
 * The compile unit test asserts that the emitted object carries
 * `ignore_changes`. This test asks OpenTofu what that object does. For an
 * autoscaled service and for a non-autoscaled control, the ECS service is
 * compiled through the production driver and assembled into a workspace. Then
 * OpenTofu's native test framework (`mock_provider "aws"`) runs, sharing one state:
 *
 *   run 1  apply  the manifest workspace (configured desired_count = 2)
 *   run 2  plan   the same state after the IaC configuration says 5 (the
 *                 re-render that follows an autoscaler scale-out)
 *
 *   autoscaled  run 2 plans desired_count 2: ignore_changes holds, no fight with the autoscaler
 *   control     run 2 plans desired_count 5: the negative control shows the diff is real
 *
 *   ZENITH_TEST_TOFU_NETWORK=1 ZENITH_TOFU_BIN=/abs/path/tofu \
 *     node node_modules/vitest/vitest.mjs run tests/providers/aws/drivers/compute/ecs-ownership-tofu.test.ts
 *
 * Re-render seam: an OpenTofu test cannot change a root module's configuration
 * between runs, so the single literal `desired_count` is replaced by
 * `var.replicas`, and each run sets it. Nothing else in the emitted object is
 * touched; `lifecycle` is the production output and is asserted present first.
 *
 * Network is used only by `tofu init` to fetch the pinned hashicorp/aws schema.
 * The child process gets the runner's allowlisted environment, and the test
 * refuses to run while any AWS_* variable is set. The mock partition and
 * account id are fixed test values, not a real account.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TofuFragment } from "@/lib/drivers/types";
import type { ResourceNode } from "@/lib/resources/types";
import { ecsServiceDriver } from "@/lib/providers/aws/drivers/compute/ecs-service";
import { resolveTofuBinary } from "@/lib/tofu/binary";
import { buildChildEnv } from "@/lib/tofu/env";
import type { TofuWorkspace } from "@/lib/tofu/types";
import { assembleWorkspace } from "@/lib/tofu/workspace";
import { buildFixture, CTX_TAGS, mkCompileContext, REGION, stubFragments } from "./fixtures";
import { tempDir, tofuOnPath } from "../../../../tofu/_helpers";

const SERVICE = "container_service/web";
const LABEL = "aws_ecs_service.container_service_web";
const MANIFEST_COUNT = 2;
const RERENDER_COUNT = 5;

type TofuFile = { path: string; content: string };

/** The production ECS service compile, assembled with the stub neighbours the compute tests use. */
function emitService(autoscaled: boolean): TofuWorkspace {
  const fx = buildFixture({ artifact: { type: "image", ref: "ghcr.io/acme/web:2.0.1" }, withSecret: false, withLb: false, replicas: MANIFEST_COUNT });
  const node = fx.byAddress.get(SERVICE)!;
  const next: ResourceNode = autoscaled ? { ...node, spec: { ...node.spec, autoscaling: { min: 1, max: 4 } } } : node;
  const nodes = fx.nodes.map((n) => (n.address === SERVICE ? next : n));
  const byAddress = new Map(nodes.map((n) => [n.address, n]));
  const fragments = stubFragments({ ...fx, byAddress });
  fragments.set(SERVICE, ecsServiceDriver.compile!(next, mkCompileContext(byAddress)) as TofuFragment);
  return assembleWorkspace({
    graph: { ...fx.graph, nodes },
    fragments: fragments as Map<string, TofuFragment>,
    providerSet: "aws",
    region: REGION,
    backend: { kind: "local", path: "terraform.tfstate" },
    tags: CTX_TAGS,
  });
}

/** The emitted files, with the one literal count replaced by `var.replicas` (see the header). */
function withReplicasVariable(ws: TofuWorkspace): TofuFile[] {
  const main = ws.files.find((f) => f.path === "main.tf.json");
  if (!main) throw new Error("emitted workspace has no main.tf.json");
  const doc = JSON.parse(main.content) as { resource: { aws_ecs_service: { container_service_web: Record<string, unknown> } } };
  const svc = doc.resource.aws_ecs_service.container_service_web;
  if (svc.desired_count !== MANIFEST_COUNT) throw new Error(`emitted desired_count is ${String(svc.desired_count)}, expected ${MANIFEST_COUNT}`);
  svc.desired_count = "${var.replicas}";
  return [
    ...ws.files.map((f) => (f.path === "main.tf.json" ? { ...f, content: JSON.stringify(doc, null, 2) } : f)),
    { path: "variables.tf.json", content: JSON.stringify({ variable: { replicas: { type: "number" } } }) },
  ];
}

/**
 * Apply at the manifest count, then plan the re-render under the same state.
 * Mock data supplies the partition and account the emitted role ARNs are built from.
 */
function testFile(expectedAfterRerender: number): string {
  return `mock_provider "aws" {
  mock_data "aws_partition" {
    defaults = {
      partition = "aws"
    }
  }
  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "123456789012"
    }
  }
  mock_resource "aws_iam_role" {
    defaults = {
      arn = "arn:aws:iam::123456789012:role/zenith-test-role"
    }
  }
}

run "apply_manifest_count" {
  command = apply
  variables {
    replicas = ${MANIFEST_COUNT}
  }
  assert {
    condition     = ${LABEL}.desired_count == ${MANIFEST_COUNT}
    error_message = "apply must create the service with desired_count ${MANIFEST_COUNT}"
  }
}

run "rerender_count_${RERENDER_COUNT}_plans_against_applied_state" {
  command = plan
  variables {
    replicas = ${RERENDER_COUNT}
  }
  assert {
    condition     = ${LABEL}.desired_count == ${expectedAfterRerender}
    error_message = "planned desired_count must be ${expectedAfterRerender} when the configuration says ${RERENDER_COUNT}"
  }
}
`;
}

interface TestEvent {
  test_summary?: { status?: string; passed?: number; failed?: number; errored?: number };
}

/** Write the workspace, `tofu init` it (lockfile readonly), then `tofu test -json`. */
function runTofuTest(dir: string, ws: TofuWorkspace, files: TofuFile[], tftest: string) {
  const work = path.join(dir, "module");
  mkdirSync(work, { recursive: true });
  for (const f of files) writeFileSync(path.join(work, f.path), f.content, { mode: 0o600 });
  writeFileSync(path.join(work, ".terraform.lock.hcl"), ws.lockfile, { mode: 0o600 });
  writeFileSync(path.join(work, "ownership.tftest.hcl"), tftest, { mode: 0o600 });
  const home = path.join(dir, "home");
  const cli = path.join(dir, "tofu.rc");
  const cache = path.join(os.tmpdir(), "zenith-tofu-plugin-cache");
  // Short TMPDIR: the provider plugin's unix socket lives under it and macOS caps socket paths at 104 bytes.
  const tmp = mkdtempSync(path.join(os.tmpdir(), "zt"));
  for (const d of [home, cache]) mkdirSync(d, { recursive: true });
  writeFileSync(cli, "# generated by zenith test: provider installation is registry + shared plugin cache only\n", { mode: 0o600 });
  const env = buildChildEnv({ homeDir: home, tmpDir: tmp, cliConfigFile: cli, pluginCacheDir: cache }) as NodeJS.ProcessEnv;
  const bin = resolveTofuBinary();
  try {
    const init = spawnSync(bin, ["init", "-input=false", "-no-color", "-lockfile=readonly"], { cwd: work, env, encoding: "utf8", timeout: 600_000 });
    const test = spawnSync(bin, ["test", "-json", "-no-color"], { cwd: work, env, encoding: "utf8", timeout: 600_000 });
    const events = (test.stdout ?? "").split("\n").filter(Boolean).flatMap((line): TestEvent[] => {
      try {
        return [JSON.parse(line) as TestEvent];
      } catch {
        return [];
      }
    });
    return { init, test, events };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const enabled = process.env.ZENITH_TEST_TOFU_NETWORK === "1" && tofuOnPath();

describe.skipIf(!enabled)("tofu ignores desired_count once an autoscaler owns it (real OpenTofu, mock aws provider)", () => {
  let sandbox: { dir: string; cleanup(): void };

  beforeAll(() => {
    const aws = Object.keys(process.env).filter((k) => k.startsWith("AWS_"));
    if (aws.length > 0) throw new Error(`refusing to run: AWS credential environment is set (${aws.join(", ")})`);
    sandbox = tempDir("zenith-ecs-ownership-");
  });

  afterAll(() => sandbox?.cleanup());

  const check = (name: string, autoscaled: boolean, expectedAfterRerender: number) =>
    it(
      name,
      async () => {
        const ws = emitService(autoscaled);
        const emitted = JSON.parse(ws.files.find((f) => f.path === "main.tf.json")!.content) as { resource: { aws_ecs_service: { container_service_web: { lifecycle?: unknown } } } };
        expect(emitted.resource.aws_ecs_service.container_service_web.lifecycle).toEqual(autoscaled ? { ignore_changes: ["desired_count"] } : undefined);
        const { init, test, events } = runTofuTest(path.join(sandbox.dir, autoscaled ? "autoscaled" : "control"), ws, withReplicasVariable(ws), testFile(expectedAfterRerender));
        expect(init.status, `${init.stdout}\n${init.stderr}`).toBe(0);
        expect(test.status, `${test.stdout}\n${test.stderr}`).toBe(0);
        expect(events.find((e) => e.test_summary)?.test_summary).toMatchObject({ status: "pass", passed: 2, failed: 0, errored: 0 });
      },
      900_000
    );

  check("autoscaled service: re-rendering the count to 5 plans desired_count to stay 2", true, MANIFEST_COUNT);
  check("negative control: without an autoscaler the same re-render plans desired_count 2 -> 5", false, RERENDER_COUNT);
});
