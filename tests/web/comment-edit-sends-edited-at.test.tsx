// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// An edit of one's own message names the `edited_at` the words were typed
// against, so the server can refuse an edit made over someone else's newer
// one (another tab, the same author) rather than let the later one win. The
// stamp is the one shown when the box opened; a reread while typing does not
// move it. After a stale refusal the person has been told, and a resend names
// the stamp the reread shows.

import { afterEach, describe, expect, it } from 'vitest';
import { tick } from './task-page-stub.tsx';
import { json, typeInto, unmountAll } from './perspective-support.tsx';
import { comment, conversing, key } from './conversation-support.tsx';

afterEach(unmountAll);

const SHOWN = '2026-09-20T03:00:00.000Z';
const NEWER = '2026-09-20T04:00:00.000Z';

const thread = (editedAt: string) => [
  comment('m1', 'internal', '2026-09-20T01:00:00.000Z', 'my words', {
    own: true,
    edited_at: editedAt,
  }),
  comment('m2', 'internal', '2026-09-20T02:00:00.000Z', 'my other words', { own: true }),
];

const BOX = '[data-comment-id="m1"] [data-comment-edit]';
const STALE = { refused: true, code: 'VERSION_STALE', names: ['expectedEditedAt'], fixes: [] };

describe('a comment edit names the edited_at it was typed against', () => {
  it('sends the stamp the row showed', async () => {
    const { view, sent } = conversing(thread(SHOWN));
    const seen = await view();
    await seen.click('[data-comment-id="m1"] [data-comment-act="edit"]');
    await typeInto(seen, BOX, 'my better words');
    await key(seen, BOX, { key: 'Enter', ctrlKey: true });
    await tick();
    expect(sent).toMatchObject([
      {
        to: '/task/edit_comment',
        body: { commentId: 'm1', body: 'my better words', expectedEditedAt: SHOWN },
      },
    ]);
  });

  it('a reread while typing keeps the stamp the box opened on', async () => {
    const { view, sent } = conversing(thread(SHOWN), thread(NEWER));
    const seen = await view();
    await seen.click('[data-comment-id="m1"] [data-comment-act="edit"]');
    await typeInto(seen, BOX, 'typed over the old words');
    // Another row's delete reads the task again; the read now carries a newer edit of m1.
    await seen.click('[data-comment-id="m2"] [data-comment-act="delete"]');
    await tick();
    expect(sent.map((one) => one.to)).toStrictEqual(['/task/delete_comment']);
    await key(seen, BOX, { key: 'Enter', ctrlKey: true });
    await tick();
    expect(sent[1]).toMatchObject({
      to: '/task/edit_comment',
      body: { commentId: 'm1', expectedEditedAt: SHOWN },
    });
  });

  it('after a stale refusal, a resend names the stamp the reread shows', async () => {
    const { view, sent, answers } = conversing(thread(SHOWN), thread(NEWER));
    answers.set('/task/edit_comment', () => Promise.resolve(json(STALE, 409)));
    const seen = await view();
    await seen.click('[data-comment-id="m1"] [data-comment-act="edit"]');
    await typeInto(seen, BOX, 'my better words');
    await key(seen, BOX, { key: 'Enter', ctrlKey: true });
    await tick();
    expect(seen.find('[data-comment="row-refusal"]')?.textContent).toContain('VERSION_STALE');
    answers.delete('/task/edit_comment');
    await key(seen, BOX, { key: 'Enter', ctrlKey: true });
    await tick();
    expect(sent.map((one) => one.body['expectedEditedAt'])).toStrictEqual([SHOWN, NEWER]);
  });
});
