// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { narrowRows, startsAWord } from '../../packages/ui/src/board/filters.ts';

// A letter outside the Basic Multilingual Plane is two code units; the one
// before a match is the whole letter, never its trailing half.
it('a term after a supplementary letter does not start a new word', () => {
  // 𐐨 (Deseret) and 𝐀 (mathematical bold) are letters written as surrogate pairs.
  expect(startsAWord('𐐨sum', 'sum')).toBe(false);
  expect(startsAWord('𝐀sum', 'sum')).toBe(false);
  expect(startsAWord('😀sum', 'sum')).toBe(true);
  expect(startsAWord('𐐨sum sum', 'sum')).toBe(true);
  const rows = ['𐐨sum', 'sum of costs'];
  expect(narrowRows(rows, { ids: [], text: ['sum'] }, [], (row) => row)).toEqual(['sum of costs']);
});
