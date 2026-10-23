/**
 * GET /api/platform/v1/workspace/policy   any member
 * PUT /api/platform/v1/workspace/policy   admin, browser-only
 *
 * The workspace's policy parameters: the overrides it set and the complete
 * parameters policy evaluates with. PUT replaces the overrides; they are
 * validated by `resolveWorkspacePolicy` (an unknown key or capability name is a
 * 400 listing the fields). Body: `{ overrides: {...}, expectedVersion?: int }`.
 */
import { z } from "zod";
import { platformBroker } from "@/lib/capabilities/platform";
import { assertBrowserSession } from "../../_lib/browser";
import { parseWith, platformRoute, readJson } from "../../_lib/http";
import { callerOf } from "../../_lib/principal";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Body = z.object({ overrides: z.record(z.string(), z.unknown()), expectedVersion: z.number().int().min(0).optional() }).strict();

export const GET = platformRoute(async (req) => {
  const caller = await callerOf(req);
  return { body: await (await platformBroker()).getWorkspacePolicy({ workspaceId: caller.workspaceId, principal: caller.principal }) };
});

export const PUT = platformRoute(async (req) => {
  const caller = await assertBrowserSession(req);
  const body = parseWith(Body, await readJson(req));
  return {
    body: await (await platformBroker()).setWorkspacePolicy({
      workspaceId: caller.workspaceId,
      overrides: body.overrides,
      actor: caller.principal,
      session: caller.session,
      expectedVersion: body.expectedVersion,
    }),
  };
});
