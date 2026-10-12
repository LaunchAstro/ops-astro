// SPDX-License-Identifier: AGPL-3.0-only
//
// The chat path's proposal block contract (designs/chat-path-slice.md): an
// agent's reply may end with one ```task block naming a create or an edit of
// the chat's own task. The parser is pure: a whole, valid block gives the words
// before it and the proposal; anything else gives no proposal and the body as
// written, so a malformed block is read as words and never half-acted on.

import { describe, expect, it } from 'vitest';
import {
  PROPOSAL_DESCRIPTION_LIMIT,
  PROPOSAL_TITLE_LIMIT,
  readProposal,
} from '../../packages/core-wire/src/index.ts';
import { WRITTEN } from './chat-proposal-written.ts';

const block = (json: string): string => `\`\`\`task\n${json}\n\`\`\``;
const reply = (json: string, words = 'Here is a task for that.'): string =>
  `${words}\n\n${block(json)}`;

// eslint-disable-next-line max-lines-per-function -- each case of the block contract, on one parser
describe('chat proposal block', () => {
  it('reads each reply the M5 models actually wrote as its words and a create', () => {
    expect(readProposal(WRITTEN.qwenWattle)).toStrictEqual({
      words: 'Righto, here is that task for you.',
      proposal: {
        action: 'create',
        title: 'Tidy up Wattle Cafe menu photos',
        description:
          'Sort and organise the mock menu photos for the Wattle Cafe. Needs to be done by Thursday.',
      },
    });
    expect(readProposal(WRITTEN.qwenRiverbend).proposal?.title).toBe(
      'Draft Riverbend Bakery newsletter',
    );
    expect(readProposal(WRITTEN.gemmaRiverbend)).toStrictEqual({
      words: "No worries, I've set that up for you.",
      proposal: {
        action: 'create',
        title: 'Draft Riverbend Bakery newsletter',
        description: 'Draft the newsletter, due Friday 17 October 2026.',
      },
    });
  });

  it('reads a create at the end of the reply: the words before it, the title and the description', () => {
    const body = reply(
      '{"action":"create","title":"Draft the spring brief","description":"Two pages."}',
    );
    expect(readProposal(body)).toStrictEqual({
      words: 'Here is a task for that.',
      proposal: {
        action: 'create',
        title: 'Draft the spring brief',
        description: 'Two pages.',
      },
    });
  });

  it('reads a create with no description, and a block that is the whole reply', () => {
    expect(readProposal(block('{"action":"create","title":"Call the printer"}'))).toStrictEqual({
      words: '',
      proposal: { action: 'create', title: 'Call the printer', description: null },
    });
  });

  it('reads an edit with only a title, only a description, or both, and never an id', () => {
    expect(
      readProposal(reply('{"action":"edit","title":"Spring brief, v2"}')).proposal,
    ).toStrictEqual({ action: 'edit', title: 'Spring brief, v2', description: null });
    expect(readProposal(reply('{"action":"edit","description":""}')).proposal).toStrictEqual({
      action: 'edit',
      title: null,
      description: '',
    });
    expect(
      readProposal(reply('{"action":"edit","title":"A","description":"B"}')).proposal,
    ).toStrictEqual({ action: 'edit', title: 'A', description: 'B' });
  });

  it('allows trailing space after the block and CRLF line ends', () => {
    const body = 'Sure.\r\n```task\r\n{"action":"create","title":"Book the room"}\r\n```\r\n  \n';
    expect(readProposal(body)).toStrictEqual({
      words: 'Sure.',
      proposal: { action: 'create', title: 'Book the room', description: null },
    });
  });

  it('takes the limits at their edges: a 200 character title and a 4,000 character description', () => {
    const title = 'x'.repeat(PROPOSAL_TITLE_LIMIT);
    const description = 'y'.repeat(PROPOSAL_DESCRIPTION_LIMIT);
    const body = reply(JSON.stringify({ action: 'create', title, description }));
    expect(readProposal(body).proposal).toStrictEqual({ action: 'create', title, description });
    expect(PROPOSAL_TITLE_LIMIT).toBe(200);
    expect(PROPOSAL_DESCRIPTION_LIMIT).toBe(4000);
  });

  it('counts characters, not UTF-16 units: 200 emoji is a title in range', () => {
    const title = '🙂'.repeat(PROPOSAL_TITLE_LIMIT);
    expect(
      readProposal(reply(JSON.stringify({ action: 'create', title }))).proposal,
    ).not.toBeNull();
  });

  const malformed: readonly (readonly [string, string])[] = [
    ['bad JSON', reply('{"action":"create","title":"Oops"')],
    ['JSON that is not an object', reply('["create","Oops"]')],
    ['JSON null', reply('null')],
    ['an unknown action', reply('{"action":"delete","title":"Gone"}')],
    ['no action', reply('{"title":"No action"}')],
    ['another key', reply('{"action":"create","title":"T","assignee":"me"}')],
    ['an id the model named', reply('{"action":"edit","id":"T-12","title":"T"}')],
    ['a create with no title', reply('{"action":"create","description":"Only words"}')],
    ['an empty title', reply('{"action":"create","title":""}')],
    ['a title of spaces', reply('{"action":"create","title":"   "}')],
    ['a title over 200', reply(JSON.stringify({ action: 'create', title: 'x'.repeat(201) }))],
    [
      'a description over 4,000',
      reply(JSON.stringify({ action: 'create', title: 'T', description: 'y'.repeat(4001) })),
    ],
    ['a title that is not text', reply('{"action":"create","title":12}')],
    ['a description that is not text', reply('{"action":"create","title":"T","description":null}')],
    ['an edit naming nothing', reply('{"action":"edit"}')],
    [
      'a second block',
      `${block('{"action":"create","title":"One"}')}\n\n${reply('{"action":"create","title":"Two"}')}`,
    ],
    ['a block followed by words', `${reply('{"action":"create","title":"T"}')}\nAnything else?`],
    ['an unclosed block', 'Here.\n```task\n{"action":"create","title":"T"}'],
    ['a block under another language', 'Here.\n```json\n{"action":"create","title":"T"}\n```'],
  ];

  it.each(malformed)(
    'draws no proposal for %s, and the words stay exactly as written',
    (_, body) => {
      expect(readProposal(body)).toStrictEqual({ words: body, proposal: null });
    },
  );

  it('keeps markup as text: angle brackets and a script tag pass through as characters', () => {
    const title = '<script>alert(1)</script>';
    const body = reply(
      JSON.stringify({ action: 'create', title, description: '<b>bold</b>' }),
      '<i>hi</i>',
    );
    expect(readProposal(body)).toStrictEqual({
      words: '<i>hi</i>',
      proposal: { action: 'create', title, description: '<b>bold</b>' },
    });
  });

  it('leaves a reply with no block untouched', () => {
    const body = 'No task needed.\n```ts\nconst a = 1;\n```';
    expect(readProposal(body)).toStrictEqual({ words: body, proposal: null });
  });
});
