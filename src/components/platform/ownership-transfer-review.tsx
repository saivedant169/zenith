/**
 * Exact ownership transfers an approver is asked to bind (PROD-LIFE-12). The rows come from the
 * proposal's digest-covered `broker.ownershipTransfers`, so approving the proposal digest approves
 * precisely these rows and nothing else. Nothing here creates authority; the approvals store does.
 */
import { useId } from "react";
import { Callout } from "@/components/ui/callout";
import type { TransferRow } from "@/lib/platform/operator-journey";
import { DigestValue } from "./badges";

export function OwnershipTransferReview({ transfers, warnings = [], proposalDigest }: { transfers: readonly TransferRow[]; warnings?: readonly string[]; proposalDigest: string }) {
  const id = useId();
  if (transfers.length === 0 && warnings.length === 0) return null;
  return (
    <section aria-labelledby={`${id}-h`} className="space-y-3 rounded-card border border-line bg-bg1 p-4">
      <h2 id={`${id}-h`} className="text-[15px] font-medium text-ink">Field ownership</h2>
      {transfers.length > 0 && (
        <>
          <Callout tone="warn" title="Approving this proposal transfers write ownership">
            Each row below moves one field from one writer to another. The transfer is bound to proposal digest <DigestValue digest={proposalDigest} what="proposal digest" /> and exists only if a person approves exactly that digest. It expires, and it can be revoked.
          </Callout>
          <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Ownership transfers">
            <table className="w-full min-w-[640px] text-left text-[13px]">
              <caption className="sr-only">Ownership transfers requested by this proposal</caption>
              <thead className="text-[12px] text-ink-mute">
                <tr><th scope="col" className="py-1 pr-3 font-medium">Resource</th><th scope="col" className="py-1 pr-3 font-medium">Field</th><th scope="col" className="py-1 pr-3 font-medium">From</th><th scope="col" className="py-1 pr-3 font-medium">To</th><th scope="col" className="py-1 font-medium">Transfer digest</th></tr>
              </thead>
              <tbody className="divide-y divide-line">
                {transfers.map((t) => (
                  <tr key={t.digest} className="align-top">
                    <th scope="row" className="py-2 pr-3 font-normal"><span className="break-all font-mono text-[12px]">{t.address}</span><span className="block text-[12px] text-ink-mute">{t.resourceType}</span></th>
                    <td className="py-2 pr-3 font-mono text-[12px]">{t.path}</td>
                    <td className="py-2 pr-3">{t.from}</td>
                    <td className="py-2 pr-3">{t.to}</td>
                    <td className="py-2"><DigestValue digest={t.digest} what="transfer digest" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="list-disc space-y-1 pl-5 text-[12.5px] text-ink-mute">{transfers.map((t) => <li key={t.digest}>{t.effect}</li>)}</ul>
        </>
      )}
      {warnings.length > 0 && (
        <Callout tone="info" title="Ownership notes"><ul className="list-disc space-y-1 pl-5">{warnings.map((w) => <li key={w}>{w}</li>)}</ul></Callout>
      )}
    </section>
  );
}
