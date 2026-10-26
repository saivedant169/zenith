import type { ReactNode } from "react";
import { cx, fmtUsd } from "@/lib/format";

/** Above this, a monthly increase gets a warn tint so it can't slip by. */
const NOTABLE_INCREASE_USD = 25;

export interface CostDeltaProps {
  /** monthly delta in USD; negative means the change saves money */
  usd: number;
  /** trailing unit, defaults to "/mo est." (every delta is an estimate) */
  suffix?: ReactNode;
  /** hide the unit entirely */
  bare?: boolean;
  className?: string;
}

/**
 * Signed monthly cost change. Savings read in `ok`; increases stay in `ink`
 * and pick up a warn tint past $25/mo. Always an estimate, so the default unit says so.
 */
export function CostDelta({ usd, suffix = "/mo est.", bare = false, className }: CostDeltaProps) {
  const zero = Math.abs(usd) < 0.005;
  const saving = usd < 0 && !zero;
  const notable = usd > NOTABLE_INCREASE_USD;

  return (
    <span
      title={
        zero
          ? "No change to the monthly estimate."
          : saving
            ? `Estimated saving of ${fmtUsd(Math.abs(usd))} per month.`
            : `Estimated increase of ${fmtUsd(usd)} per month.`
      }
      className={cx(
        "tnum inline-flex items-baseline gap-0.5 rounded-ctl font-mono text-[12.5px]",
        notable && "bg-warn-dim px-1.5 py-0.5",
        zero ? "text-ink-faint" : saving ? "text-ok" : "text-ink",
        className
      )}
    >
      {fmtUsd(usd, { sign: true })}
      {!bare && <span className="text-ink-faint">{suffix}</span>}
    </span>
  );
}
