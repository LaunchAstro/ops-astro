// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-5 on the task page, the thread's shape (R42, DT-19): replies one level
// under their message, a deleted message's replies kept under a line, a reply
// posted to its message in that message's audience, and where each client
// message stands. The tabs and the composer are in `mp-4-5-conversation`;
// own rows in `mp-4-5-own-rows`.

import { afterEach, describe, expect, it } from 'vitest';
import { tick } from './task-page-stub.tsx';
import { typeInto, unmountAll } from './perspective-support.tsx';
import { comment, conversing, repliesUnder } from './conversation-support.tsx';

afterEach(unmountAll);

const REPLIED = [
  comment('i1', 'internal', '2026-09-20T01:00:00.000Z', 'the first note'),
  // A reply arriving before its message, and a reply on a later message.
  comment('r2', 'internal', '2026-09-23T01:00:00.000Z', 'on the second', { parent: 'i2' }),
  comment('r1', 'internal', '2026-09-21T03:00:00.000Z', 'on the first', { parent: 'i1' }),
  comment('i2', 'internal', '2026-09-21T01:00:00.000Z', 'the second note'),
];

describe('MP-4-5 reply one level', () => {
  it('a reply sits under its message, and only a message offers a reply control', async () => {
    const { view } = conversing(REPLIED);
    const seen = await view();
    expect(repliesUnder(seen, 'i1')).toStrictEqual(['r1']);
    expect(repliesUnder(seen, 'i2')).toStrictEqual(['r2']);
    expect(
      seen.find('[data-comment-id="i1"] > .msg__acts [data-comment-act="reply"]'),
    ).not.toBeNull();
    expect(seen.find('[data-comment-id="r1"] [data-comment-act="reply"]')).toBeNull();
  });

  it('a reply goes to its message, in the message’s audience, and can be called off', async () => {
    const { view, sent } = conversing([
      comment('c1', 'client', '2026-09-21T02:00:00.000Z', 'from the client', {
        signal: 'owed',
      }),
    ]);
    const seen = await view();
    await seen.click('#conversation-tab-client');
    await seen.click('[data-comment-id="c1"] [data-comment-act="reply"]');
    expect(seen.find('[data-comment="replying"]')?.textContent).toContain('Replying to');
    await seen.click('[data-comment="replying"] button');
    expect(seen.find('[data-comment="replying"]')).toBeNull();
    await seen.click('[data-comment-id="c1"] [data-comment-act="reply"]');
    await typeInto(seen, '#comment-body', 'We are on it.');
    await seen.click('[data-comment="post"]');
    await tick();
    expect(sent).toMatchObject([
      {
        to: '/task/comment',
        body: { body: 'We are on it.', audience: 'client', commentType: 'client', parentId: 'c1' },
      },
    ]);
  });

  it('a deleted message’s replies stay, under a line saying it was deleted', async () => {
    const { view } = conversing([
      comment('r9', 'internal', '2026-09-21T03:00:00.000Z', 'still here', { parent: 'gone' }),
    ]);
    const seen = await view();
    expect(seen.find('[data-comment-deleted] .card__body')?.textContent).toBe(
      'This message was deleted.',
    );
    expect(seen.all('[data-comment-deleted] [data-replies] [data-comment-id]')).toHaveLength(1);
    expect(seen.find('[data-comment-deleted] [data-comment-act]')).toBeNull();
  });
});

describe('MP-4-5 replies survive loading', () => {
  it('replies on every message come back after a reread, not only the first message’s', async () => {
    const { view } = conversing(REPLIED);
    const seen = await view();
    await seen.click('[data-refresh="task"]');
    await tick();
    expect(repliesUnder(seen, 'i1')).toStrictEqual(['r1']);
    expect(repliesUnder(seen, 'i2')).toStrictEqual(['r2']);
    expect(seen.all('[data-comments="list"] > [data-comment-id]')).toHaveLength(2);
  });
});

describe('MP-4-5 signals', () => {
  it('each client message shows where it stands, in words and a title; notes and replies show none', async () => {
    const seen = await conversing([
      comment('c1', 'client', '2026-09-21T01:00:00.000Z', 'owed', { signal: 'owed' }),
      comment('c2', 'client', '2026-09-21T02:00:00.000Z', 'ours', { signal: 'not_acknowledged' }),
      comment('c3', 'client', '2026-09-21T03:00:00.000Z', 'done', { signal: 'answered' }),
      comment('c4', 'client', '2026-09-21T04:00:00.000Z', 'reply', { parent: 'c3' }),
      comment('i1', 'internal', '2026-09-21T05:00:00.000Z'),
    ]).view();
    await seen.click('#conversation-tab-all');
    const chip = (id: string): Element | null =>
      seen.find(`[data-comment-id="${id}"] > .sbact__meta [data-signal]`);
    expect(chip('c1')?.textContent).toBe('Reply owed');
    expect(chip('c2')?.textContent).toBe('Not acknowledged');
    expect(chip('c3')?.textContent).toBe('Answered');
    for (const id of ['c1', 'c2', 'c3']) {
      expect(chip(id)?.getAttribute('title')).toMatch(/client/u);
      // A label, never a control: nothing to press (R56).
      expect(chip(id)?.closest('button, a')).toBeNull();
    }
    expect(seen.find('[data-comment-id="c4"] [data-signal]')).toBeNull();
    expect(seen.find('[data-comment-id="i1"] [data-signal]')).toBeNull();
  });
});

describe('MP-4-5 reply clears owed', () => {
  it('after a reply to an owed client message, the reread shows it answered', async () => {
    const owed = comment('c1', 'client', '2026-09-21T01:00:00.000Z', 'help?', { signal: 'owed' });
    const { view, sent } = conversing(
      [owed],
      [
        { ...owed, signal: 'answered' },
        comment('r1', 'client', '2026-09-21T02:00:00.000Z', 'here', { parent: 'c1', own: true }),
      ],
    );
    const seen = await view();
    await seen.click('#conversation-tab-client');
    expect(seen.find('[data-comment-id="c1"] [data-signal]')?.textContent).toBe('Reply owed');
    await seen.click('[data-comment-id="c1"] [data-comment-act="reply"]');
    await typeInto(seen, '#comment-body', 'here');
    await seen.click('[data-comment="post"]');
    await tick();
    expect(sent[0]?.body).toMatchObject({ parentId: 'c1', audience: 'client' });
    expect(seen.find('[data-comment-id="c1"] > .sbact__meta [data-signal]')?.textContent).toBe(
      'Answered',
    );
    expect(repliesUnder(seen, 'c1')).toStrictEqual(['r1']);
    expect(seen.find('[data-comment="replying"]')).toBeNull();
  });
});

describe('MP-4-5 reaction chip display only', () => {
  // LEANS-ON a reactions model: the record holds no client acknowledgement
  // (the portal's `comment acknowledged`), so there is no chip to draw yet.
  it.todo('the reaction chip is a label with no pointer and no action (DT-19)');
});
