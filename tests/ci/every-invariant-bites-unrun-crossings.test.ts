// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { PARTS, classify } from './self-test/mutations.ts';

describe('every_invariant_bites: an unrun crossing, and each isolation suite of a part', () => {
  it('a declared crossing that never ran fails its part revert', () => {
    const line = classify('T4-N4 T3b reverted: unknown_stays_unknown', {
      applied: true,
      executed: 1,
      red: true,
      detail: 'the invariant failed, the client and person crossing was absent',
      cases: [{ name: 'unknown_stays_unknown: a swept attempt', passed: false }],
    });
    expect(line.status).toBe('fail');
    expect(line.detail).toContain('client to client and person to person');
  });

  it('T2d and T3c reverts run their separate isolation suites', () => {
    for (const [id, file] of [
      ['T2d', 'tests/runtime/t2d-settle-isolation.test.ts'],
      ['T3c', 'tests/runtime/t3c-write-off-isolation.test.ts'],
    ]) {
      const part = PARTS.find((one) => one.id === id);
      expect(part?.files, `${id} omits ${file}`).toContain(file);
    }
  });
});
