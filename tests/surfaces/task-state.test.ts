// SPDX-License-Identifier: AGPL-3.0-only
//
// One task state, drawn one way on the board and the task page (thermo review
// M14). The two screens each held a copy of this mapping; the values below
// are what those copies drew at b483399, so the move changes nothing a person
// sees.

import { describe, expect, it } from 'vitest';
import { drawTaskState } from '../../apps/web/src/views/task-state.ts';

const state = (machineCategory: string) => ({
  id: 's',
  key: 'k',
  label: `Label ${machineCategory}`,
  machineCategory,
});

describe('drawTaskState', () => {
  it('draws the stored label with the tone its machine category has always had', () => {
    const tones: readonly [string, string][] = [
      ['unstarted', 'wait'],
      ['started', 'run'],
      ['backlog', 'gate'],
      ['completed', 'done'],
      ['cancelled', 'bad'],
      ['a category nobody registered', 'wait'],
    ];
    for (const [category, tone] of tones) {
      expect(drawTaskState(state(category))).toEqual({
        word: `Label ${category}`,
        tone,
        reference: 'new_behaviour',
      });
    }
  });

  it('draws a task with no state as an incomplete record', () => {
    expect(drawTaskState(null)).toEqual({ word: 'No state', tone: 'wait', reference: 'unknown' });
  });
});
