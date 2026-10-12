// SPDX-License-Identifier: AGPL-3.0-only
//
// A board step that leaves the view as it was records nothing: repeating an
// active search keeps the person's redo history and spends none of the
// bounded undo history. Synthetic rows only.

import { describe, expect, it } from 'vitest';
import { initialMachine, reduceBoard } from '../../packages/ui/src/board/machine.ts';
import type { BoardContext } from '../../packages/ui/src/board/types.ts';

const CONTEXT: BoardContext<{ readonly name: string }> = {
  facets: [],
  columns: [],
  presets: [],
  modes: [],
};

describe('a board step that changes nothing records nothing', () => {
  it('repeating an active search keeps the view, the history and the redo of the later word', () => {
    let state = initialMachine();
    state = reduceBoard(state, { type: 'commit', raw: 'alpha' }, CONTEXT);
    state = reduceBoard(state, { type: 'commit', raw: 'beta' }, CONTEXT);
    state = reduceBoard(state, { type: 'undo' }, CONTEXT);
    const before = state;
    const repeated = reduceBoard(state, { type: 'commit', raw: 'alpha' }, CONTEXT);
    expect(repeated.view).toStrictEqual(before.view);
    expect(repeated.history, 'an unchanged view must not record a step').toStrictEqual(
      before.history,
    );
    const redone = reduceBoard(repeated, { type: 'redo' }, CONTEXT);
    expect(redone.view.text).toStrictEqual(['alpha', 'beta']);
  });
});
