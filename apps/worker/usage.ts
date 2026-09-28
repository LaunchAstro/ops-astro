// SPDX-License-Identifier: AGPL-3.0-only
//
// What a step cost, as the worker is told it (specification 12.2). The worker
// takes its reporter by construction (`worker.ts`), so a test hands it the
// declining fixture in `tests/support/` and a shipped build cannot: the
// cruiser refuses any shippable import from `tests/` (12.3).

export interface UsageReporter {
  /** The most a step may cost, which the proposal asks a person to hold. */
  readonly estimate: (step: { readonly kind: string }) => number;
  /** What the step cost once done, or `null` when the reporter declines to say. */
  readonly observe: (step: { readonly kind: string }) => number | null;
}

/**
 * The synthetic step's reporter: a team-only comment that costs a fixed,
 * made-up amount below its ceiling, so settlement has a smaller amount to
 * spend and the rest to release (T2d).
 */
export const SYNTHETIC_USAGE: UsageReporter = {
  estimate: () => 2_500,
  observe: () => 1_800,
};
