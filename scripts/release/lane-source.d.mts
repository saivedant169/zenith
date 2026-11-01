export declare const LANE_SOURCE_FORMAT: "zenith.release-lane-source.v1";
export interface LaneCounts { passed: number; failed: number; skipped: number }
export declare function countsOf(report: Record<string, unknown>): LaneCounts;
export declare function statusOf(counts: LaneCounts, exitCode: number): "passed" | "failed" | "skipped" | "not_run";
export declare function commandText(args: readonly string[], files: readonly string[]): string;
export declare function main(argv: readonly string[], seams?: {
  git?: (root: string, args: string[]) => string;
  vitest?: (root: string, args: string[], reportFile: string) => number;
}): number;
