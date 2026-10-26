"use client";
/** First read-only review and persisted status. Lost replies retain the same intent key. */
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { WorkspaceRole } from "@/lib/domain/roles";
import { api, executeAction } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { mutationError } from "../../_lib/browser-api";

interface Review { reviewOperationId: string; status: string; operationId?: string; planDigest?: string; planReview?: unknown }
const pending = (status: string) => ["approved", "queued", "running"].includes(status);
function parsedReview(value: unknown): Review | null {
  if (!value || typeof value !== "object" || !("review" in value) || !value.review || typeof value.review !== "object") return null;
  const row = value.review as Partial<Review>;
  if (typeof row.reviewOperationId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(row.reviewOperationId) || typeof row.status !== "string") return null;
  if (row.operationId !== undefined && (typeof row.operationId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(row.operationId))) return null;
  if (row.planDigest !== undefined && (typeof row.planDigest !== "string" || !/^[a-f0-9]{64}$/.test(row.planDigest))) return null;
  return row as Review;
}

export function EnvironmentTeardownReview({ workspaceId, environmentId, viewerRole }: { workspaceId: string; environmentId: string; viewerRole: WorkspaceRole | "none" }) {
  const [review, setReview] = useState<Review | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const intent = useRef<string | undefined>(undefined);
  const inFlight = useRef(false);
  const alive = useRef(true);
  const path = `/api/platform/v1/environments/${encodeURIComponent(environmentId)}/teardown-review`;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const result = parsedReview(await api<unknown>(path, { credentials: "same-origin", headers: { "x-zenith-workspace": workspaceId } }));
        if (!active) return;
        setReview(result);
        if (result && pending(result.status) && !result.operationId) timer = setTimeout(() => void load(), 2000);
      } catch (failure) { if (active) setError(mutationError(failure)); }
    };
    if (viewerRole !== "none") void load();
    return () => { active = false; clearTimeout(timer); };
  }, [workspaceId, path, viewerRole, busy]);

  const request = async () => {
    if (inFlight.current || viewerRole === "none" || (review && pending(review.status))) return;
    inFlight.current = true; setBusy(true); setError("");
    intent.current ??= crypto.randomUUID();
    try {
      const result = await executeAction("env.reviewTeardown", { scope: { environmentId },
        input: { environmentId, idempotencyKey: intent.current }, idempotencyKey: intent.current });
      if (!alive.current) return;
      if (!result?.ok || !result.data || typeof result.data !== "object" || !("reviewOperationId" in result.data) || typeof result.data.reviewOperationId !== "string") {
        setError("The review request could not be confirmed. Reload to inspect its recorded state.");
      } else {
        const next = parsedReview(await api<unknown>(`${path}?reviewId=${encodeURIComponent(result.data.reviewOperationId)}`, { credentials: "same-origin", headers: { "x-zenith-workspace": workspaceId } }));
        if (alive.current) { setReview(next); intent.current = undefined; }
      }
    } catch (failure) { if (alive.current) setError(mutationError(failure)); }
    finally { inFlight.current = false; if (alive.current) setBusy(false); }
  };
  return <div className="space-y-3" aria-label="Read-only teardown review">
    <p className="text-[13px] text-ink-mute">Run a read-only destroy plan and record a proposal for separate human approval. No infrastructure is changed by this review.</p>
    <p className="text-[13px] text-ink-mute">If this teardown is refused, the environment stays frozen until its possible deliveries drain.</p>
    <Button busy={busy} onClick={() => void request()} disabled={viewerRole === "none" || Boolean(review && pending(review.status))}
      disabledReason={viewerRole === "none" ? "Workspace membership is required." : "The recorded review or teardown is still in progress."}>Review teardown</Button>
    {review && <div role="status" className="space-y-2 text-[13px]">
      <p>{review.status === "awaiting_approval" ? "Teardown review is awaiting human approval." : `Teardown review: ${review.status}.`}</p>
      {review.planDigest && <p className="break-all">Plan digest: {review.planDigest}</p>}
      <Link href={`/platform/operations/${encodeURIComponent(review.operationId ?? review.reviewOperationId)}`} className="text-signal underline underline-offset-4">
        {review.operationId ? "Review teardown operation for approval" : "View review progress"}</Link>
      {review.operationId && !review.planReview && <Callout tone="warn">The recorded PlanView is unavailable. Approval requires a readable matching plan.</Callout>}
    </div>}
    {error && <Callout tone="warn" title="Teardown review unavailable">{error}</Callout>}
  </div>;
}
