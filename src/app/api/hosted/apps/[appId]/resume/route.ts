/**
 * Resume a suspended app.
 *
 * It starts serving the release it was serving before, from the same artifact
 * bytes, to the same people: suspension took nothing away, so resuming does
 * not have to put anything back.
 */
import { z } from "zod";
import type { JobAccepted } from "@/lib/hosted/contracts";
import { accepted, executeHosted, hostedRoute, readJsonBody } from "@/lib/server/hosted";
import { buildCtx } from "@/lib/server/context";

export const dynamic = "force-dynamic";

const ResumeBody = z.object({ jobId: z.string().guid(), reason: z.string().trim().max(300).optional() });

export const POST = hostedRoute<{ appId: string }>(
  { workspaceRole: "admin" },
  async (req, { appId }, { actor }) => {
    const body = await readJsonBody(req, ResumeBody, { fix: 'POST { "jobId": "<uuid you generate>" }.' });
    const result = await executeHosted(
      "app.resume",
      buildCtx({}, actor),
      { appId, jobId: body.jobId, reason: body.reason }
    );
    const data = result.data as JobAccepted;
    return accepted({ job: data.job, jobId: data.jobId, created: data.created });
  }
);
