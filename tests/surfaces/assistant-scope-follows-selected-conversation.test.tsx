// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { ask, initial, select } from '../../apps/web/src/assistant/chats.ts';
import { subjectFor } from '../../apps/web/src/assistant/subject.ts';

// Sol OW-079.3 criterion 2, retitled by what it proves; its body is Sol's.
it('client to client separation follows the selected assistant conversation', () => {
  const first = ask(initial(), {
    row: 'CL-M03',
    widget: { id: 'a', label: 'Client A' },
    question: 'Explain A',
    scope: { client: { id: 'a', name: 'Client A' }, task: null },
  });
  const second = ask(first, {
    row: 'CL-M03',
    widget: { id: 'b', label: 'Client B' },
    question: 'Explain B',
    scope: { client: { id: 'b', name: 'Client B' }, task: null },
  });
  const back = select(second, first.selected);
  expect(back.selected).toBe(first.selected);
  // AssistantView derives the displayed and submitted subject this way.
  expect(subjectFor({ route: 'agency:projects-board', ...back.scope }).clientId).toBe('a');
});
