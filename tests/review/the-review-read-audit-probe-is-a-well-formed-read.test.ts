// SPDX-License-Identifier: AGPL-3.0-only
//
// S2061-4: the audit matrix's refused review.read call is meant to be refused by
// authority. A body the read's own operand check rejects answers FIELD_VALUE_INVALID
// first, so the probe has to carry a well-formed reviewId.

import { expect, it } from 'vitest';
import { READ_CATALOGUE } from '../../packages/core-commands/src/reads/catalogue.ts';
import { probeOperands } from '../acceptance/role-case-fixed-bodies.ts';

it('the review.read audit probe passes the read operand check, so authority answers it', () => {
  expect(READ_CATALOGUE['review.read'].parse(probeOperands('review.read')).ok).toBe(true);
});
