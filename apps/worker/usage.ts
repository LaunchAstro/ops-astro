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

/**
 * T3e1: what the step calls once it is marked, before its effect. The shipped
 * provider always answers; a fault is injected only at construction, as the
 * reporter is, so no setting turns one on. A worker that meets a
 * `ProviderFault` hands back `dropped` with its cause; the call may have acted,
 * so the whole hold stays unknown until a person records what happened: the
 * register holds only the comment and cannot prove the provider did nothing.
 */
export interface Provider {
  readonly call: (step: { readonly kind: string }) => Promise<void>;
}

/** The provider did not answer, or the connection to it was lost. */
export class ProviderFault extends Error {
  readonly dropCause: 'provider_unavailable' | 'connection_lost';

  constructor(dropCause: 'provider_unavailable' | 'connection_lost') {
    super(`the provider call dropped: ${dropCause}`);
    this.dropCause = dropCause;
  }
}

export const SYNTHETIC_PROVIDER: Provider = {
  call: async () => {
    await Promise.resolve();
  },
};
