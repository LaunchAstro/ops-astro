// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { readView, writeView } from '../../packages/ui/src/board/address.ts';
import { narrowRows } from '../../packages/ui/src/board/filters.ts';
import { initialMachine, reduceBoard } from '../../packages/ui/src/board/machine.ts';
import type { BoardContext } from '../../packages/ui/src/board/types.ts';

const context: BoardContext<string> = { facets: [], columns: [], presets: [], modes: [] };
const hay = (row: string): string => row;

// Sol OW-100.1 criterion correctness, retitled by what it proves; its body is Sol's.
it('reloading a committed 65-character search preserves its rows', () => {
  const term = 'a'.repeat(65);
  const rows = [term, 'unrelated task'];
  const committed = reduceBoard(initialMachine(), { type: 'commit', raw: term }, context).view;
  const before = narrowRows(rows, committed, context.facets, hay);
  expect(before).toEqual([term]);
  const reloaded = readView(writeView(committed), context);
  expect(narrowRows(rows, reloaded, context.facets, hay)).toEqual(before);
});

// Sol OW-100.1 criterion correctness, retitled by what it proves; its body is Sol's.
it('reloading a committed 21-word search preserves its rows', () => {
  const terms = Array.from({ length: 21 }, (_, i) => `word${String(i).padStart(2, '0')}`);
  const wanted = terms.join(' ');
  const rows = [wanted, terms.slice(0, 20).join(' ')];
  const committed = reduceBoard(initialMachine(), { type: 'commit', raw: wanted }, context).view;
  const before = narrowRows(rows, committed, context.facets, hay);
  expect(before).toEqual([wanted]);
  const reloaded = readView(writeView(committed), context);
  expect(narrowRows(rows, reloaded, context.facets, hay)).toEqual(before);
});
