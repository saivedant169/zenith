/**
 * Scripted OpenTofu port (`TofuPort`). It stands where the real engine stands:
 * the activities call `planWorkspace` and `applyVerifiedPlan` exactly as they
 * would the real ones and get a `NormalizedPlan` back. NOT OpenTofu: nothing is
 * planned or applied; the plan is whatever the test built. The real engine is
 * exercised separately in journey.test.ts.
 *
 * Like the real `planWorkspace`, when given a `planDir` it writes a binary plan
 * file there (mode 0600) — here containing a canary — so tests can assert that
 * the file stays in `planDir`, is removed after the apply, and never reaches the
 * evidence ledger or an activity result.
 */
import { digest } from "@/lib/controlplane/digest";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ApprovedPlan, PlanCustodyInput, ProducedPlan, ApplyVerifiedResult, EngineOptions, PlanWorkspaceOptions, PlanWorkspaceResult } from "@/lib/tofu/engine";
import type { TofuSessionEnv } from "@/lib/tofu/runner";
import { TofuCommandError } from "@/lib/tofu/runner";
import { TofuPlanChangedError, type NormalizedPlan, type TofuRunResult, type TofuWorkspace } from "@/lib/tofu/types";
import type { TofuPort } from "@/lib/execution/ports";
import { CANARY_SECRET, makePlan } from "./fixtures";

const bound=(plan:NormalizedPlan,source?:string):NormalizedPlan=>source?{...plan,executableSourceDigest:source,planDigest:digest({configDigest:plan.configDigest,lockDigest:plan.lockDigest,tofuVersion:plan.tofuVersion,resourceChanges:plan.resourceChanges,outputChanges:plan.outputChanges,executableSourceDigest:source})}:plan;

export const PLAN_FILE_CANARY = `FAKE-BINARY-PLAN-FILE-${CANARY_SECRET}`;

const run = (command: TofuRunResult["command"], exitCode = 1): TofuRunResult => ({ command, exitCode, output: "", truncated: false, durationMs: 7 });

export type ApplyBehaviour = "ok" | "fail_apply" | "fail_plan_before_apply" | "timeout" | "abort" | "unclassified" | "dispatch_unconfirmed" | "plan_changed" | "hang" | "fail_output";

export class FakeTofu implements TofuPort {
  readonly planCalls: { ws: TofuWorkspace; opts: PlanWorkspaceOptions; envKeys: string[]; inputEnvKeys: string[] }[] = [];
  readonly applyCalls: { ws: TofuWorkspace; approvedDigest: string; envKeys: string[]; inputEnvKeys: string[]; captureSensitive: boolean; fingerprintKey?: string }[] = [];
  /** values of sensitive outputs an apply returns ONLY when the caller asked for them (like the real engine) */
  sensitiveOutputs: Record<string, unknown> | undefined;
  /** the typed-input values the last session offered (kept only so a test can prove they reached the tool and nowhere else) */
  lastInputEnv: Record<string, string> = {};
  /** the plan each `planWorkspace` call returns */
  planFactory: (ws: TofuWorkspace, call: number) => NormalizedPlan = (ws) => makePlan({ configDigest: ws.configDigest, lockDigest: ws.lockDigest });
  planError: Error | undefined;
  /** `planWorkspace` waits for this before answering (the test holds it) */
  planGate: Promise<void> | undefined;
  apply: ApplyBehaviour = "ok";
  outputs: ApplyVerifiedResult["outputs"] = {
    alb_dns_name: { sensitive: false, type: "string", value: "lb.example.com" },
    db_master_password: { sensitive: true, type: "string" },
  };
  /** an "ok" apply waits for this before returning (the test holds it) */
  applyGate: Promise<void> | undefined;
  /** resolves once an apply has started */
  applyStarted: Promise<void>;
  private markApplyStarted!: () => void;

  constructor() {
    this.applyStarted = new Promise((resolve) => (this.markApplyStarted = resolve));
  }

  async planWorkspace(ws: TofuWorkspace, session?: TofuSessionEnv, opts: PlanWorkspaceOptions = {}): Promise<PlanWorkspaceResult> {
    this.lastInputEnv = session?.inputEnv?.() ?? this.lastInputEnv;
    this.planCalls.push({ ws, opts, envKeys: Object.keys(session?.childProcessEnv?.() ?? {}), inputEnvKeys: Object.keys(session?.inputEnv?.() ?? {}) });
    if (this.planGate) await this.planGate;
    if (opts.signal?.aborted) throw new TofuCommandError("tofu_aborted", "tofu plan was aborted.", run("plan"));
    if (this.planError) throw this.planError;
    const plan = bound(this.planFactory(ws, this.planCalls.length),opts.normalize?.executableSourceDigest);
    let planFilePath: string | undefined;
    if (opts.planDir) {
      await mkdir(opts.planDir, { recursive: true, mode: 0o700 });
      planFilePath = path.join(opts.planDir, `${plan.planDigest}.tfplan`);
      await writeFile(planFilePath, PLAN_FILE_CANARY, { mode: 0o600 });
    }
    const produced: ProducedPlan | undefined = opts.custody ? Object.freeze({ manifest: Object.freeze({ ...opts.custody,
      format: "zenith.plan-artifact.v1" as const, purpose: opts.destroy ? "destroy" as const : "deploy" as const,
      configDigest: ws.configDigest, lockDigest: ws.lockDigest, backendDigest: "0".repeat(64), addressMapDigest: "0".repeat(64),
      planDigest: plan.planDigest, rawSha256: createHash("sha256").update(PLAN_FILE_CANARY).digest("hex"), bytes: Buffer.byteLength(PLAN_FILE_CANARY),
      executable: { version:"isolated-test",platform:"isolated-test",sha256:"0".repeat(64),archiveSha256:null },
    }) }) : undefined;
    // This handle is deliberately NOT registered in the trusted engine WeakMap and cannot be published by production.
    return { plan, planFile: Buffer.from(PLAN_FILE_CANARY), planFilePath, produced };
  }

  async applyVerifiedPlan(ws: TofuWorkspace, args: { approvedDigest: string; session?: TofuSessionEnv; original?: ApprovedPlan; custody?: PlanCustodyInput; beforeDispatch?: () => Promise<void> } & EngineOptions): Promise<ApplyVerifiedResult> {
    this.lastInputEnv = args.session?.inputEnv?.() ?? this.lastInputEnv;
    this.applyCalls.push({ ws, approvedDigest: args.approvedDigest, envKeys: Object.keys(args.session?.childProcessEnv?.() ?? {}), inputEnvKeys: Object.keys(args.session?.inputEnv?.() ?? {}), captureSensitive: args.captureSensitiveOutputs === true, fingerprintKey: args.normalize?.fingerprintKey });
    if (this.apply === "fail_plan_before_apply") throw new TofuCommandError("tofu_command_failed", "tofu plan failed with exit code 1.", run("plan"));
    if (this.apply === "plan_changed") throw new TofuPlanChangedError(args.approvedDigest, this.planFactory(ws,this.planCalls.length+1).planDigest);
    const plan = bound(this.planFactory(ws, this.planCalls.length + 1),args.normalize?.executableSourceDigest);
    if (plan.planDigest !== args.approvedDigest) throw new TofuPlanChangedError(args.approvedDigest,plan.planDigest);
    await args.beforeDispatch?.();
    this.markApplyStarted();
    switch (this.apply) {
      case "fail_apply":
        throw new TofuCommandError("tofu_command_failed", "tofu apply failed with exit code 1.", run("apply"));
      case "fail_output":
        throw new TofuCommandError("tofu_command_failed", "tofu output failed with exit code 1.", run("output"));
      case "timeout":
        throw new TofuCommandError("tofu_timeout", "tofu apply timed out after 1800000 ms.", run("apply", -1));
      case "abort":
        throw new TofuCommandError("tofu_aborted", "tofu apply was aborted.", run("apply", -1));
      case "unclassified":
        throw new Error("socket hang up");
      case "dispatch_unconfirmed":
        // The plan dispatch wrapper's shape (src/lib/platform/plan-artifacts.ts): a sanitized cause only.
        throw new Error("Original plan dispatch outcome is unconfirmed; inspect this operation before another write.", {
          cause: Object.freeze({ name: "TofuCommandError", code: "tofu_command_failed", detail: "apply:api_AccessDeniedException" }),
        });
      case "hang":
        await new Promise<never>((_, reject) => {
          const fail = (): void => reject(new TofuCommandError("tofu_aborted", "tofu apply was aborted.", run("apply", -1)));
          if (args.signal?.aborted) fail();
          else args.signal?.addEventListener("abort", fail, { once: true });
        });
        break;
      case "ok":
        break;
    }
    if (plan.planDigest !== args.approvedDigest) throw new TofuPlanChangedError(args.approvedDigest, plan.planDigest);
    if (this.applyGate) await this.applyGate;
    return { plan, apply: { command: "apply", exitCode: 0, output: "Apply complete! Resources: 1 added, 0 changed, 0 destroyed.", truncated: false, durationMs: 42 }, outputs: this.outputs, ...(args.captureSensitiveOutputs && this.sensitiveOutputs ? { sensitiveOutputs: { ...this.sensitiveOutputs } } : {}) };
  }
}
