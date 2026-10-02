// SPDX-License-Identifier: AGPL-3.0-only
//
// REVIEW-BATCH-2 #312 security review S2. The browser and the server must count
// a currency's minor units alike, or a figure typed in one is a different sum
// in the other. Both read Intl data before, and Intl data differs: Node gives
// IDR, HUF and IQD 0 digits, where ISO 4217 (and so a browser built on it)
// gives 2, 2 and 3, so an IDR top-up typed in such a browser was sent 100x.
// Both now read one fixed table, the ISO 4217 minor-unit exponents.

import { describe, expect, it } from 'vitest';
import { minorDigits as serverDigits } from '../../packages/core-runtime/src/four-eyes.ts';
import { minorDigits as clientDigits } from '../../packages/ui/src/surfaces/agent/format.ts';

/** ISO 4217's minor-unit exponents for the cases the review named. */
const ISO_4217: Readonly<Record<string, number>> = {
  IDR: 2,
  HUF: 2,
  IQD: 3,
  JPY: 0,
  KWD: 3,
  AUD: 2,
};

describe('REVIEW-3A-S2 one table of minor digits for the browser and the server', () => {
  it('REVIEW-3A-S2: the client and the server agree with ISO 4217 for IDR, HUF, IQD, JPY, KWD and AUD', () => {
    for (const [currency, digits] of Object.entries(ISO_4217)) {
      expect(serverDigits(currency), `server ${currency}`).toBe(digits);
      expect(clientDigits(currency), `client ${currency}`).toBe(digits);
    }
  });
});
