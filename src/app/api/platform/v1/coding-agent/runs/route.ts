/**
 * GET  /api/platform/v1/coding-agent/runs   recent runs of the workspace
 * POST /api/platform/v1/coding-agent/runs   start a bounded run (admin, browser only)
 *
 * POST body (strict): `{ task, repository: "owner/name", ref?, root?, target?: { projectId, environmentId },
 * model?, limits?: { inputTokens, outputTokens, toolCalls, wallTimeMs, spendMicroUsd } }`.
 * Limits are clamped to the platform ceilings. This call only PINS the repository to an exact commit,
 * records the run and starts its durable workflow, then returns 201 with the run (status `running`).
 * The execution worker analyses the repository with a model on fixed read-only tools, step by step
 * with a stored checkpoint, and, when a target is named, submits the resulting manifest as an
 * `infrastructure.plan` proposal to the capability broker. Nothing is deployed or adopted by this call.
 * 503 when the workflow engine cannot be reached (the run is recorded and can be resumed).
 */
import { z } from "zod";
import { codingAgentControl, codingAgentStore } from "@/lib/coding-agent/platform";
import { createRun, TASK_MAX } from "@/lib/coding-agent/service";
import { runView } from "@/lib/coding-agent/view";
import { parseWith, platformRoute, readJson } from "../../_lib/http";
import { agentAdmin, mapAgentError } from "../../_lib/coding-agent";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ID = /^[A-Za-z0-9_-]{1,100}$/;
const Body = z
  .object({
    task: z.string().min(1).max(TASK_MAX),
    repository: z.string().min(3).max(201),
    ref: z.string().min(1).max(250).prefault("HEAD"),
    root: z.string().max(200).optional(),
    target: z.object({ projectId: z.string().regex(ID), environmentId: z.string().regex(ID) }).strict().optional(),
    model: z.string().max(60).optional(),
    limits: z.object({ inputTokens: z.number().int(), outputTokens: z.number().int(), toolCalls: z.number().int(), wallTimeMs: z.number().int(), spendMicroUsd: z.number().int() }).partial().strict().optional(),
  })
  .strict();

export const GET = platformRoute(async (req) => {
  const caller = await agentAdmin(req);
  const rows = await (await codingAgentStore()).list(caller.agent.workspaceId, 25);
  return { body: { runs: rows.map(runView) } };
});

export const POST = platformRoute(async (req) => {
  const caller = await agentAdmin(req);
  const body = parseWith(Body, await readJson(req));
  try {
    const run = await createRun(await codingAgentControl(), caller.agent, {
      task: body.task,
      source: { repository: body.repository, ref: body.ref, ...(body.root ? { root: body.root } : {}) },
      ...(body.target ? { target: body.target } : {}),
      ...(body.model ? { model: body.model } : {}),
      ...(body.limits ? { limits: body.limits } : {}),
    });
    return { status: 201, body: runView(run) };
  } catch (error) {
    return mapAgentError(error);
  }
});
