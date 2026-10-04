// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { narrowRows, startsAWord } from '../../packages/ui/src/board/filters.ts';

// Sol OW-100.2 criterion correctness, retitled by what it proves; its body is Sol's.
it('an accent inside a decomposed word does not start a new word', () => {
  const composed = 'résumé';
  const decomposed = composed.normalize('NFD');
  expect(startsAWord('sum of costs', 'sum')).toBe(true);
  expect(startsAWord(composed, 'sum')).toBe(false);
  const rows = [decomposed, 'sum of costs'];
  expect(narrowRows(rows, { ids: [], text: ['sum'] }, [], (row) => row)).toEqual(['sum of costs']);
});
