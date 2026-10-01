// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-12, part one: the trigger is read first. It fires only when both limbs
// hold (the required reading exceeds one window at the pinned provider, and
// the work sub-delegates); "not yet" carries its two figures, enters no
// candidate and produces no number; and nothing enters the round without a
// reading made by the trigger itself.

import { describe, expect, it } from 'vitest';
import {
  DELEGATION_DEPTH_BUILT,
  enterCandidates,
  HARNESS_PINNED_WINDOW,
  readTrigger,
  type TriggerReading,
} from '../../packages/core-runtime/src/index.ts';
import { CANDIDATES } from './candidates.ts';

const WINDOW = HARNESS_PINNED_WINDOW.contextUnits;

describe('AW-12 trigger', () => {
  it('the pinned provider is the replay provider, its window 32 000 units, and the depth built is one', () => {
    expect(HARNESS_PINNED_WINDOW).toEqual({ model: 'replay-1', contextUnits: 32_000 });
    expect(DELEGATION_DEPTH_BUILT).toBe(1);
  });

  it('fires only when the reading exceeds one window and the work sub-delegates', () => {
    expect(readTrigger({ readingBytes: WINDOW + 1, delegationDepth: 1 })).toEqual({
      result: 'fired',
      figures: {
        reading: { units: WINDOW + 1, unit: 'utf8_byte', windowUnits: WINDOW, model: 'replay-1' },
        delegation: { depth: 1, builtDepth: 1 },
      },
    });
  });

  it('"not yet" when the reading fits one window, with the two figures', () => {
    const fits = readTrigger({ readingBytes: 1_234, delegationDepth: 1 });
    expect(fits).toEqual({
      result: 'not_yet',
      missing: ['reading'],
      figures: {
        reading: { units: 1_234, unit: 'utf8_byte', windowUnits: WINDOW, model: 'replay-1' },
        delegation: { depth: 1, builtDepth: 1 },
      },
    });
    // Exactly one window is not beyond it.
    expect(readTrigger({ readingBytes: WINDOW, delegationDepth: 1 })).toMatchObject({
      result: 'not_yet',
      missing: ['reading'],
    });
  });

  it('"not yet" when the work does not sub-delegate, however much it reads', () => {
    expect(readTrigger({ readingBytes: WINDOW * 10, delegationDepth: 0 })).toMatchObject({
      result: 'not_yet',
      missing: ['delegation'],
      figures: { delegation: { depth: 0, builtDepth: 1 } },
    });
    expect(readTrigger({ readingBytes: 0, delegationDepth: 0 })).toMatchObject({
      result: 'not_yet',
      missing: ['reading', 'delegation'],
    });
  });
});

describe('AW-12 trigger, its input and its liveness', () => {
  it('a shape that is not one is refused, never read as a figure', () => {
    for (const shape of [
      { readingBytes: -1, delegationDepth: 0 },
      { readingBytes: 1.5, delegationDepth: 0 },
      { readingBytes: Number.NaN, delegationDepth: 1 },
      { readingBytes: 10, delegationDepth: 2 },
      { readingBytes: 10, delegationDepth: -1 },
      { readingBytes: '40000', delegationDepth: 1 },
    ]) {
      expect(() => readTrigger(shape as never), JSON.stringify(shape)).toThrow(RangeError);
    }
  });

  it('the trigger stays live: the same shape reads the same on any date, and fires once the shape is there', () => {
    const before = readTrigger({ readingBytes: 2_000, delegationDepth: 1 });
    const later = readTrigger({ readingBytes: 2_000, delegationDepth: 1 });
    expect(later).toEqual(before);
    expect(readTrigger({ readingBytes: WINDOW * 4, delegationDepth: 1 }).result).toBe('fired');
  });
});

describe('the_trigger_is_read_first', () => {
  it('"not yet" enters no candidate and produces no number', () => {
    const entry = enterCandidates(
      readTrigger({ readingBytes: 900, delegationDepth: 1 }),
      CANDIDATES,
    );
    expect(entry.entered).toEqual([]);
    expect(Object.keys(entry).toSorted()).toEqual(['entered', 'trigger']);
    expect(Object.keys(entry.trigger).toSorted()).toEqual(['figures', 'missing', 'result']);
    expect(Object.isFrozen(entry) && Object.isFrozen(entry.trigger)).toBe(true);
  });

  it('a fired trigger enters the candidates, and adopts none of them', () => {
    const entry = enterCandidates(
      readTrigger({ readingBytes: WINDOW * 4, delegationDepth: 1 }),
      CANDIDATES,
    );
    expect(entry.entered.map((candidate) => candidate.entry)).toEqual(
      CANDIDATES.map((candidate) => candidate.entry),
    );
    expect(JSON.stringify(entry)).not.toMatch(/adopt/iu);
  });

  it('a reading the trigger did not make enters nothing, however it is shaped', () => {
    const real = readTrigger({ readingBytes: WINDOW * 4, delegationDepth: 1 });
    const forged: TriggerReading = { result: 'fired', figures: real.figures };
    const copied = { ...real } as TriggerReading;
    const recast = JSON.parse(JSON.stringify(real)) as TriggerReading;
    for (const reading of [forged, copied, recast]) {
      expect(() => enterCandidates(reading, CANDIDATES)).toThrow(/read the trigger first/u);
    }
    // A reading cannot be turned from "not yet" into "fired" after it is made.
    const notYet = readTrigger({ readingBytes: 10, delegationDepth: 1 });
    expect(() => {
      (notYet as { result: string }).result = 'fired';
    }).toThrow(TypeError);
    expect(enterCandidates(notYet, CANDIDATES).entered).toEqual([]);
  });
});
