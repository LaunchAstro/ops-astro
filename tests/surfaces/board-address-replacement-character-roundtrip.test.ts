// SPDX-License-Identifier: AGPL-3.0-only
//
// A committed search word that holds a real replacement character (U+FFFD)
// survives the address: the board writes it encoded, and reading it back
// keeps it. Only a word whose escapes did not decode is dropped. Synthetic
// rows only.

import { describe, expect, it } from 'vitest';
import { readView, writeView } from '../../packages/ui/src/board/address.ts';
import { narrowRows } from '../../packages/ui/src/board/filters.ts';
import { initialMachine, reduceBoard } from '../../packages/ui/src/board/machine.ts';
import type { BoardContext } from '../../packages/ui/src/board/types.ts';

const context: BoardContext<string> = { facets: [], columns: [], presets: [], modes: [] };
const hay = (row: string): string => row;

describe('a search word in the address', () => {
  it('reloading a committed word that holds a replacement character keeps it and its row', () => {
    const word = 'a�word';
    const rows = [word, 'other'];
    const committed = reduceBoard(initialMachine(), { type: 'commit', raw: word }, context).view;
    const before = narrowRows(rows, committed, context.facets, hay);
    expect(before).toStrictEqual([word]);
    const reloaded = readView(writeView(committed), context);
    expect(reloaded, 'the reloaded view must keep the word').toStrictEqual(committed);
    expect(narrowRows(rows, reloaded, context.facets, hay)).toStrictEqual(before);
  });

  it('a word whose escapes did not decode is dropped and its neighbours kept', () => {
    expect(readView('q=good+bad%FFword+%E0%A4+kept%20too', context).text).toStrictEqual([
      'good',
      'kept',
      'too',
    ]);
  });
});
