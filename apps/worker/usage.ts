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
  /** Nothing for the in-app stand-in; otherwise the provider's raw answer (AW-08). */
  readonly call: (step: { readonly kind: string }) => Promise<ProviderAnswer | undefined | void>;
}

/** A provider's answer as it arrived: read by `readProviderAnswer`, never trusted. */
export interface ProviderAnswer {
  readonly status: number;
  readonly body: string;
}

/** The most of an answer the worker reads; more is a hostile answer. */
export const PROVIDER_ANSWER_MAX = 4_096;

/**
 * AW-08: the receipt link a provider answered with, or a `ProviderFault` for a
 * hostile answer: redirected, any other non-success status, oversized, or not
 * a JSON object. A hostile answer may still have acted, so it is handed back
 * as a drop and the whole hold stays unknown: no money moves and nothing is
 * marked live. Its content is never kept, logged or put in the fault.
 */
export function readProviderAnswer(answer: ProviderAnswer | undefined | void): unknown {
  if (answer === undefined) return undefined;
  const hostile =
    answer.status < 200 ||
    answer.status > 299 ||
    typeof answer.body !== 'string' ||
    answer.body.length > PROVIDER_ANSWER_MAX;
  if (hostile) throw new ProviderFault('provider_unavailable');
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer.body);
  } catch {
    throw new ProviderFault('provider_unavailable');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ProviderFault('provider_unavailable');
  }
  return (parsed as Record<string, unknown>)['link'];
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
