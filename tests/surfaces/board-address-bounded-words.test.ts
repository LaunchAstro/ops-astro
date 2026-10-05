// SPDX-License-Identifier: AGPL-3.0-only
//
// OW-100.1, security review low on d03b2b3: the free words are bounded once,
// the same way at commit and on reload, so a typed address cannot grow the
// view without limit and a committed view still reloads to the same rows.

import { expect, it } from 'vitest';
import { readView, writeView } from '../../packages/ui/src/board/address.ts';
import { initialMachine, reduceBoard } from '../../packages/ui/src/board/machine.ts';
import type { BoardContext } from '../../packages/ui/src/board/types.ts';

const context: BoardContext<string> = { facets: [], columns: [], presets: [], modes: [] };

it('a typed address and a committed search keep the same bounded free words', () => {
  const many = Array.from({ length: 10_000 }, (_, i) => `w${String(i)}`).join(' ');
  const long = 'x'.repeat(100_000);
  const read = readView(`q=${encodeURIComponent(`${many} ${long}`)}`, context);
  expect(read.text.length).toBeLessThanOrEqual(32);
  expect(read.text.every((word) => word.length <= 128)).toBe(true);
  for (const raw of [`${many} ${long}`, long]) {
    for (const type of ['commit', 'phrase'] as const) {
      const step = type === 'commit' ? { type, raw } : { type, text: raw };
      const committed = reduceBoard(initialMachine(), step, context).view;
      expect(committed.text.length).toBeLessThanOrEqual(32);
      expect(readView(writeView(committed), context).text).toEqual(committed.text);
    }
  }
});
