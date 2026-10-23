/**
 * Suspend an app: stop admitting requests, destroy nothing.
 *
 * Workspace admin plus the app's owner grant, because this is the control that
 * takes a live product away from the people using it. Data, grants,
 * invitations, releases and artifacts are all kept, and resume puts the app
 * back exactly where it was.
 */
import { z } from "zod";
import type { JobAccepted } from "@/lib/hosted/contracts";
import { accepted, executeHosted, hostedRoute, readJsonBody } from "@/lib/server/hosted";
import { buildCtx } from "@/lib/server/context";

export const dynamic = "force-dynamic";

const SuspendBody = z.object({ jobId: z.string().guid(), reason: z.string().trim().max(300).optional() });

export const POST = hostedRoute<{ appId: string }>(
  { workspaceRole: "admin" },
  async (req, { appId }, { actor }) => {
    const body = await readJsonBody(req, SuspendBody, {
      fix: 'POST { "jobId": "<uuid you generate>", "reason": "why this app is being suspended" }.',
    });
    const result = await executeHosted(
      "app.suspend",
      buildCtx({}, actor),
      { appId, jobId: body.jobId, reason: body.reason }
    );
    const data = result.data as JobAccepted;
    return accepted({ job: data.job, jobId: data.jobId, created: data.created });
  }
);
