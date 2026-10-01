// SPDX-License-Identifier: AGPL-3.0-only
//
// `parseDuration` against hostile input (review 2c1 finding 7, A3-1). The
// pattern once had three adjacent `\s*` that backtracked cubically: 8,000
// spaces and an "x" held `time.log` for over a minute inside its
// transaction. A duration is now length-capped before it is parsed, and the
// pattern has no two adjacent quantifiers that can match the same character.
// No database: the parser is pure.

import { describe, expect, it } from 'vitest';
import { parseDuration } from '../../packages/core-records/src/tasks/time.ts';

/** Milliseconds `work` took. */
function timed(work: () => unknown): number {
  const started = performance.now();
  work();
  return performance.now() - started;
}

describe('parseDuration against hostile input', () => {
  it('answers a 10,000-character hostile duration in under 50 ms, and refuses it', () => {
    for (const hostile of [
      `${' '.repeat(10_000)}x`,
      `1${' '.repeat(10_000)}x`,
      `1h${' '.repeat(10_000)}x`,
      `${'1'.repeat(10_000)}x`,
    ]) {
      let answer: number | undefined = 0;
      const took = timed(() => {
        answer = parseDuration(hostile);
      });
      expect(took, `${hostile.length} characters`).toBeLessThan(50);
      expect(answer).toBeUndefined();
    }
  });

  it('refuses a duration longer than the cap even when it would otherwise read', () => {
    expect(parseDuration(`${' '.repeat(10_000)}90`)).toBeUndefined();
  });

  it('still parses every format the store suite accepts, and refuses what it refuses', () => {
    expect(parseDuration('1h 30m')).toBe(90);
    expect(parseDuration('90m')).toBe(90);
    expect(parseDuration('90')).toBe(90);
    expect(parseDuration(' 2h ')).toBe(120);
    expect(parseDuration('1h30m')).toBe(90);
    expect(parseDuration('1 h 30 m')).toBe(90);
    expect(parseDuration('90 m')).toBe(90);
    for (const bad of ['', ' ', '0', '0m', 'h', '1x', '-5', '1.5', '90 minutes', '1h 70', '25h']) {
      expect(parseDuration(bad), bad).toBeUndefined();
    }
  });
});
