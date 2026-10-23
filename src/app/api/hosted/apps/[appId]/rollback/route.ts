/**
 * Put an app back onto a release it already ran.
 *
 * A rollback is not a restore and this route will not pretend otherwise: it
 * changes which artifact serves and touches no record any user wrote. The
 * compatibility check between the target release's schema and the app's data
 * happens inside the job, before the pointer moves.
 */
import { z } from "zod";
import type { JobAccepted } from "@/lib/hosted/contracts";
import { accepted, executeHosted, hostedRoute, readJsonBody } from "@/lib/server/hosted";
import { buildCtx } from "@/lib/server/context";

export const dynamic = "force-dynamic";

const RollbackBody = z.object({ jobId: z.string().guid(), releaseId: z.string().min(1) });

export const POST = hostedRoute<{ appId: string }>(
  { workspaceRole: "editor" },
  async (req, { appId }, { actor }) => {
    const body = await readJsonBody(req, RollbackBody, {
      fix: 'POST { "jobId": "<uuid you generate>", "releaseId": "<a release from GET …/releases>" }.',
    });
    const result = await executeHosted(
      "app.rollback",
      buildCtx({}, actor),
      { appId, jobId: body.jobId, releaseId: body.releaseId }
    );
    const data = result.data as JobAccepted;
    return accepted({ job: data.job, jobId: data.jobId, created: data.created });
  }
);
