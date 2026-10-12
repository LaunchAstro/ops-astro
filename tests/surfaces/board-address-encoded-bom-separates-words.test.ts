// SPDX-License-Identifier: AGPL-3.0-only
// Proofs from the independent review of #1404 (round 1), retitled by what they prove; their bodies are as written.
import { expect, it } from 'vitest';
import { readView } from '../../packages/ui/src/board/address.ts';
import { narrowRows } from '../../packages/ui/src/board/filters.ts';
import type { BoardContext } from '../../packages/ui/src/board/types.ts';

it('an encoded BOM between query words remains a word separator', () => {
  const context: BoardContext<string> = { facets: [], columns: [], presets: [], modes: [] };
  const address = new URLSearchParams({ q: 'oil\uFEFFhinge' }).toString();
  const view = readView(address, context);
  expect(view.text).toEqual(['oil', 'hinge']);
  expect(narrowRows(['Oil the hinge', 'Oilhinge'], view, [], (row) => row)).toEqual([
    'Oil the hinge',
  ]);
});
