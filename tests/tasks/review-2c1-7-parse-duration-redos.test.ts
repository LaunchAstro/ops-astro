// SPDX-License-Identifier: AGPL-3.0-only
//
// REVIEW-2C1-7 (REVIEW-BATCH #305, batch 2c1): parseDuration backtracks
// polynomially on a run of whitespace that never matches. Its pattern in
// packages/core-records/src/tasks/time.ts puts three \s* side by side (before
// the hours group, between the groups, and at the end), with both groups
// optional, so a line of spaces followed by any other character is tried in
// every split before it is refused. A person's typed duration reaches it, so a
// pasted run of spaces holds the request. Measured on ca72761d0: 1000 spaces
// took about 160 ms and 2000 about 1.2 s. A fixed pattern (one \s* run, or a
// trimmed input) refuses the same text in well under a millisecond.

import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { parseDuration } from '../../packages/core-records/src/tasks/time.ts';

describe('REVIEW-2C1-7: parseDuration on a long run of spaces', () => {
  it('REVIEW-2C1-7: refuses 3000 spaces then "x" within 200 ms (no catastrophic backtracking)', () => {
    const text = `${' '.repeat(3000)}x`;
    const started = performance.now();
    const minutes = parseDuration(text);
    const elapsed = performance.now() - started;
    expect(minutes).toBeUndefined();
    expect(elapsed, `parseDuration took ${Math.round(elapsed)} ms on 3000 spaces`).toBeLessThan(
      200,
    );
  });

  it('REVIEW-2C1-7: still reads a duration padded with spaces', () => {
    expect(parseDuration(`${' '.repeat(3000)}1h 30m${' '.repeat(3000)}`)).toBe(90);
  });
});
