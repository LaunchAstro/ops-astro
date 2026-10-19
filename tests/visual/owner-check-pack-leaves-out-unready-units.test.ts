// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';

import { ACCESS } from './owner-checks-access.ts';
import { FOUNDATION } from './owner-checks-foundation.ts';

it('leaves U05, U14 and U18 out of the pack until their checks or screens exist (#1822, #1819, #1818)', () => {
  expect(ACCESS.map((one) => one.unit)).not.toContain('U14');
  expect(ACCESS.map((one) => one.unit)).not.toContain('U18');
  expect(FOUNDATION.map((one) => one.unit)).not.toContain('U05');
});
