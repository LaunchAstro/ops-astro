// SPDX-License-Identifier: AGPL-3.0-only
//
// T2d, the fixed synthetic price book (product issue 14): at least two
// entries, one strictly below the maximum a proposal holds, and anything the
// book does not price is unpriced, never zero. `t2d-settle.test.ts` settles
// against it over a real database.

import { describe, expect, it } from 'vitest';
import { priceUsage, SYNTHETIC_PRICES } from '../../packages/core-runtime/src/index.ts';

/** The estimated maximum the synthetic proposal asks a person to hold (`apps/worker/usage.ts`). */
const MAXIMUM = 2_500;
const PRICED = { item: 'synthetic_comment', quantity: 1 };
const OVER = { item: 'synthetic_comment_long', quantity: 1 };

describe('T2d the synthetic price book', () => {
  it('has at least two entries, one strictly below the maximum, and prices nothing else', () => {
    expect(Object.keys(SYNTHETIC_PRICES).length).toBeGreaterThanOrEqual(2);
    const cost = priceUsage(PRICED);
    expect(cost).toBe(1_800n);
    expect(Number(cost)).toBeLessThan(MAXIMUM);
    expect(Number(priceUsage(OVER))).toBeGreaterThan(MAXIMUM);
    expect(priceUsage({ item: 'synthetic_comment', quantity: 3 })).toBe(5_400n);
    // Unpriced is not zero: nothing here answers a number.
    for (const usage of [
      undefined,
      null,
      {},
      { item: 'unknown', quantity: 1 },
      { item: 'synthetic_comment', quantity: 0 },
      { item: 'synthetic_comment', quantity: -1 },
      { item: 'synthetic_comment', quantity: 1.5 },
      { item: 'toString', quantity: 1 },
    ]) {
      expect(priceUsage(usage), JSON.stringify(usage)).toBeUndefined();
    }
  });
});
