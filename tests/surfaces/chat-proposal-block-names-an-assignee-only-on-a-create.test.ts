// SPDX-License-Identifier: AGPL-3.0-only
//
// A chat reply's task block may name who a new task is for, by the name the
// person used, as "assignee". It is read only on a create, as one line of
// words; an edit naming one, or a value that is not one line of words, gives
// no proposal and the body stays as written. The model is told the key, and
// told to leave it out when the task is for the person asking.

import { describe, expect, it } from 'vitest';
import { conversationInstructions } from '../../packages/core-connectors/src/index.ts';
import { PROPOSAL_TITLE_LIMIT, readProposal } from '../../packages/core-wire/src/index.ts';

const reply = (json: string): string => `Here is a task for that.\n\n\`\`\`task\n${json}\n\`\`\``;

describe('chat proposal block assignee', () => {
  it('reads a create naming who it is for', () => {
    expect(
      readProposal(reply('{"action":"create","title":"Book the printer","assignee":"Mia Chen"}')),
    ).toStrictEqual({
      words: 'Here is a task for that.',
      proposal: {
        action: 'create',
        title: 'Book the printer',
        description: null,
        assignee: 'Mia Chen',
      },
    });
  });

  it.each([
    ['an edit naming one', '{"action":"edit","title":"T","assignee":"Mia Chen"}'],
    ['a number', '{"action":"create","title":"T","assignee":7}'],
    ['an empty name', '{"action":"create","title":"T","assignee":"  "}'],
    ['two lines', String.raw`{"action":"create","title":"T","assignee":"Mia\nChen"}`],
    [
      'a name past the title limit',
      JSON.stringify({
        action: 'create',
        title: 'T',
        assignee: 'M'.repeat(PROPOSAL_TITLE_LIMIT + 1),
      }),
    ],
  ])('gives no proposal for %s, and the body as written', (_case, json) => {
    const body = reply(json);
    expect(readProposal(body)).toStrictEqual({ words: body, proposal: null });
  });

  it('tells the model the key, and to leave it out for the person asking', () => {
    const words = conversationInstructions(null, new Date('2026-10-13T00:00:00Z'));
    expect(words).toContain('"assignee"');
    expect(words).toContain('leave it out');
  });
});
