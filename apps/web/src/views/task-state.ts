// SPDX-License-Identifier: AGPL-3.0-only
//
// A stored task state as a drawn one, for the board and the task page alike.
//
// The label is the server's, because task states are preset records and the
// label on the record is the word the installation chose. The tone comes from
// the machine category, so a state the installation adds still draws with a
// tone rather than falling through to nothing. The tones are the ones the
// pinned step vocabulary gives the matching step word (`pending`, `running`,
// `waiting`, `done`, `refused`), written out here rather than reached by a
// round trip through a word whose only use was its tone.

import type { DrawnState } from '@launchastro/ui';
import type { TaskState } from '../operations/shapes.ts';

const TONE_BY_CATEGORY: Readonly<Record<string, DrawnState['tone']>> = {
  unstarted: 'wait',
  started: 'run',
  backlog: 'gate',
  completed: 'done',
  cancelled: 'bad',
};

export function drawTaskState(state: TaskState | null): DrawnState {
  // A task with no state is an incomplete record, not a crash and not a
  // blank cell. It says so, in the vocabulary the projection already has for
  // a word it cannot place, and the row stays on the screen.
  if (state === null) return { word: 'No state', tone: 'wait', reference: 'unknown' };
  return {
    word: state.label,
    tone: TONE_BY_CATEGORY[state.machineCategory] ?? 'wait',
    reference: 'new_behaviour',
  };
}
