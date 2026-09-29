// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-9: the one rank derivation (R70), with no database.
//
// Every fixture in the ticket's Spec is a case here, worked through the
// shipped module. The half-up case is also run against two builds of that
// module with the rounding line replaced, one flooring and one truncating, so
// the test is seen to fail on each: 10.5 must come out 11, and a build that
// reads it as 10 is caught by this file rather than by a reader of the board.

import { afterAll, describe, expect, it } from 'vitest';
import {
  calcLine,
  numberPool,
  scoreTask,
  type RankInput,
} from '../../packages/core-commands/src/reads/rank.ts';
import { createSourceMutant, type SourceMutant } from '../support/source-mutant.ts';

const NOW = new Date('2026-09-29T00:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY);

const task = (overrides: Partial<RankInput> = {}): RankInput => ({
  id: overrides.key ?? 'T-1',
  key: 'T-1',
  position: null,
  marks: { impact: 7, confidence: 9, ease: 8 },
  priorityStage: false,
  open: true,
  startedAt: null,
  ...overrides,
});

describe('MP-4-9 derivation fixtures', () => {
  it('marks 7, 9, 8 with no stage and no start give 504', () => {
    expect(scoreTask(task(), NOW).score).toBe(504);
  });

  it('the same with a priority stage give 630', () => {
    expect(scoreTask(task({ priorityStage: true }), NOW).score).toBe(630);
  });

  it('open and started 10 days ago (one whole week) give 529', () => {
    expect(scoreTask(task({ startedAt: daysAgo(10) }), NOW).score).toBe(529);
  });

  it('open and started 15 days ago (two whole weeks) give 554', () => {
    expect(scoreTask(task({ startedAt: daysAgo(15) }), NOW).score).toBe(554);
  });

  it('the age boost is capped at 1.5, however long ago the start', () => {
    const scored = scoreTask(task({ startedAt: daysAgo(7 * 40) }), NOW);
    expect([scored.ageBoost, scored.score]).toStrictEqual(['1.5', 756]);
  });

  it('a done task, or a start in the future, takes no age boost', () => {
    expect(scoreTask(task({ open: false, startedAt: daysAgo(30) }), NOW).score).toBe(504);
    expect(scoreTask(task({ startedAt: new Date(NOW.getTime() + 30 * DAY) }), NOW).score).toBe(504);
  });

  it('marks 5, 7 and absent give "not ranked", never 0', () => {
    const scored = scoreTask(task({ marks: { impact: 5, confidence: 7, ease: null } }), NOW);
    expect([scored.score, scored.missing]).toStrictEqual([null, ['ease']]);
  });

  it('two tasks both scoring 504 order by position, then by key', () => {
    const numbers = numberPool(
      [
        task({ id: 'b', key: 'T-2', position: 2 }),
        task({ id: 'a', key: 'T-1', position: 1 }),
        task({ id: 'c', key: 'T-3', position: null }),
        task({ id: 'd', key: 'T-0', position: null }),
      ],
      NOW,
    );
    expect(Object.fromEntries(numbers)).toStrictEqual({ a: 1, b: 2, d: 3, c: 4 });
  });

  it('scored tasks come first by score; unscored take no number', () => {
    const numbers = numberPool(
      [
        task({ id: 'low', marks: { impact: 1, confidence: 1, ease: 1 } }),
        task({ id: 'none', marks: { impact: null, confidence: 9, ease: 9 }, position: 1 }),
        task({ id: 'high', marks: { impact: 10, confidence: 10, ease: 10 } }),
      ],
      NOW,
    );
    expect(Object.fromEntries(numbers)).toStrictEqual({ high: 1, low: 2, none: null });
  });
});

describe('MP-4-9 calc line', () => {
  it('lists the marks and prints ×1 for a task with no stage and no start', () => {
    expect(calcLine(scoreTask(task(), NOW))).toBe(
      'impact 7 × confidence 9 × ease 8 × priority 1 × age 1 = 504 · derived',
    );
  });

  it('carries the priority and age modifiers with the whole weeks counted', () => {
    const scored = scoreTask(task({ priorityStage: true, startedAt: daysAgo(15) }), NOW);
    expect(calcLine(scored)).toBe(
      'impact 7 × confidence 9 × ease 8 × priority 1.25 × age 1.1 (2 weeks) = 693 · derived',
    );
  });

  it('says which marks are missing on a task that is not ranked', () => {
    const none = scoreTask(task({ marks: { impact: null, confidence: 7, ease: null } }), NOW);
    expect(calcLine(none)).toBe('not ranked: missing impact and ease');
  });

  it('says where an inherited rank comes from', () => {
    expect(calcLine(scoreTask(task(), NOW), { inheritedFrom: 'SWOT entry S-4' })).toBe(
      'impact 7 × confidence 9 × ease 8 × priority 1 × age 1 = 504 · inherited from SWOT entry S-4',
    );
  });
});

// The rounding line in the shipped module. A build that floors or truncates
// replaces exactly this line; the mutant loader refuses a line that moved, so
// the proof cannot quietly run the unmutated module.
const ROUNDING = 'return Math.floor((2 * numerator + denominator) / (2 * denominator));';
const HALF_WAY = task({
  marks: { impact: 2, confidence: 2, ease: 2 },
  priorityStage: true,
  startedAt: daysAgo(10),
});

describe('MP-4-9 half up', () => {
  const mutants: SourceMutant[] = [];
  afterAll(() => {
    for (const mutant of mutants) mutant.dispose();
  });

  it('marks 2, 2, 2 on a priority stage, one whole week open, give 11 (10.5 half up)', () => {
    expect(scoreTask(HALF_WAY, NOW).score).toBe(11);
  });

  it.each([
    ['flooring', 'return Math.floor(numerator / denominator);'],
    ['truncating', 'return Math.trunc(numerator / denominator);'],
  ])('is red against a %s build: that build gives 10', async (_label, to) => {
    const mutant = createSourceMutant({
      file: 'packages/core-commands/src/reads/rank.ts',
      from: ROUNDING,
      to,
    });
    mutants.push(mutant);
    const built = await mutant.load<
      typeof import('../../packages/core-commands/src/reads/rank.ts')
    >('packages/core-commands/src/reads/rank.ts');
    expect(built.scoreTask(HALF_WAY, NOW).score).toBe(10);
  });
});
