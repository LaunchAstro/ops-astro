// SPDX-License-Identifier: AGPL-3.0-only
//
// What a step cost, as the worker is told it (specification 12.2). The worker
// takes its reporter by construction (`worker.ts`), so a test hands it the
// declining fixture in `tests/support/` and a shipped build cannot: the
// cruiser refuses any shippable import from `tests/` (12.3).

/** One price-book item and how many of it (`core-runtime/src/price-book.ts`). */
export interface Usage {
  readonly item: string;
  readonly quantity: number;
}

export interface UsageReporter {
  /** The most a step may cost, which the proposal asks a person to hold. */
  readonly estimate: (step: { readonly kind: string }) => number;
  /** What the step used once done, priced by the product's book (T2d), or `null` when the reporter declines to say. */
  readonly observe: (step: { readonly kind: string }) => Usage | null;
}

/**
 * The synthetic step's reporter: one team-only comment, which the book prices
 * below its ceiling, so settlement has a smaller amount to spend and the rest
 * to release (T2d).
 */
export const SYNTHETIC_USAGE: UsageReporter = {
  estimate: () => 2_500,
  observe: () => ({ item: 'synthetic_comment', quantity: 1 }),
};
