/**
 * Publish a source package to an app.
 *
 * 202, not 200: the response means "this job exists and is durable", not "your
 * app is live". The job id is the client's, so the same request sent twice is
 * the same publish — and the same id with different content is refused rather
 * than joined to it. Both answers come from the job admission in the authority,
 * not from anything this route remembers.
 */
import { z } from "zod";
import type { JobAccepted } from "@/lib/hosted/contracts";
import { PublishSource } from "@/lib/hosted/release";
import { accepted, executeHosted, hostedRoute, readJsonBody } from "@/lib/server/hosted";
import { buildCtx } from "@/lib/server/context";

export const dynamic = "force-dynamic";

const PublishBody = z.object({
  jobId: z.string().guid(),
  source: PublishSource,
});

export const POST = hostedRoute<{ appId: string }>(
  { workspaceRole: "editor" },
  async (req, { appId }, { actor }) => {
    const body = await readJsonBody(req, PublishBody, {
      fix: 'POST { "jobId": "<uuid you generate>", "source": { "kind": "fixture", "name": "minimal-app" } } — or { "kind": "tarball", "base64": "…" }.',
    });
    const result = await executeHosted(
      "app.publish",
      buildCtx({}, actor),
      { appId, jobId: body.jobId, source: body.source }
    );
    const data = result.data as JobAccepted;
    return accepted({ job: data.job, jobId: data.jobId, created: data.created });
  }
);
