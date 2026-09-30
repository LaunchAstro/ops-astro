// SPDX-License-Identifier: AGPL-3.0-only
//
// T2d: the fixed synthetic price book. The worker reports what a step used,
// never what it cost; this book prices it, so the amount settled is the
// product's figure and not a number the caller chose. Made-up prices in AUD
// minor units for the synthetic step, one below the estimate a proposal asks a
// person to hold (`apps/worker/usage.ts`, 2 500) and one above it.
//
// Anything the book does not price is unpriced, never zero: an unknown item,
// a quantity that is not a positive whole number, an absent report, another
// book or another currency. Settlement reads unpriced as "not settled".

import { SYNTHETIC_PRICE_BOOK } from './decide.ts';

/** What a step used, as the worker's reporter says it. */
export interface Usage {
  readonly item: string;
  readonly quantity: number;
}

export const PRICE_BOOK_CURRENCY = 'AUD';

export const SYNTHETIC_PRICES: Readonly<Record<string, bigint>> = Object.freeze({
  synthetic_comment: 1_800n,
  synthetic_comment_long: 3_200n,
});

/** The cost of `usage` in minor units under the synthetic book, or `undefined` when it is unpriced. */
export function priceUsage(usage: unknown): bigint | undefined {
  if (typeof usage !== 'object' || usage === null) return undefined;
  const { item, quantity } = usage as Partial<Record<keyof Usage, unknown>>;
  if (typeof item !== 'string' || !Object.hasOwn(SYNTHETIC_PRICES, item)) return undefined;
  if (typeof quantity !== 'number' || !Number.isSafeInteger(quantity) || quantity <= 0) {
    return undefined;
  }
  return (SYNTHETIC_PRICES[item] ?? 0n) * BigInt(quantity);
}

/** The attempt's cost when its own book and currency are the ones priced here. */
export function priceAttempt(
  attempt: { readonly priceBook: string; readonly currency: string },
  usage: unknown,
): bigint | undefined {
  if (attempt.priceBook !== SYNTHETIC_PRICE_BOOK || attempt.currency !== PRICE_BOOK_CURRENCY) {
    return undefined;
  }
  return priceUsage(usage);
}
