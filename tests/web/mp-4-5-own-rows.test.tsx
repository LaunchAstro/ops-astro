// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-5 on the task page, a person's own rows (DT-17, CS-4.34): the pencil
// and the x are drawn on rows the read marks as the reader's, and nowhere
// else. Esc reverts, Ctrl or Cmd and Enter or leaving the box commits, and an
// emptied box keeps the old words; the x deletes the row by its own id.

import { afterEach, describe, expect, it } from 'vitest';
import { tick } from './task-page-stub.tsx';
import { typeInto, unmountAll } from './perspective-support.tsx';
import { json } from './perspective-support.tsx';
import { blur, comment, conversing, key } from './conversation-support.tsx';
import type { Mounted } from '../surfaces/mount.tsx';

afterEach(unmountAll);

const MINE = [
  comment('m1', 'internal', '2026-09-20T01:00:00.000Z', 'my words', { own: true }),
  comment('t1', 'internal', '2026-09-20T02:00:00.000Z', 'their words'),
];

const BOX = '[data-comment-id="m1"] [data-comment-edit]';

const editBox = (view: Mounted): HTMLTextAreaElement | null =>
  view.host.querySelector<HTMLTextAreaElement>(BOX);

describe('MP-4-5 own rows only', () => {
  it('the pencil and the × are on the reader’s own rows and nobody else’s', async () => {
    const seen = await conversing(MINE).view();
    expect(seen.find('[data-comment-id="m1"] [data-comment-act="edit"]')).not.toBeNull();
    expect(seen.find('[data-comment-id="m1"] [data-comment-act="delete"]')).not.toBeNull();
    expect(seen.find('[data-comment-id="t1"] [data-comment-act="edit"]')).toBeNull();
    expect(seen.find('[data-comment-id="t1"] [data-comment-act="delete"]')).toBeNull();
  });
});

describe('MP-4-5 own rows only, editing', () => {
  it('Esc reverts; an emptied box keeps the old words; Ctrl and Enter commits', async () => {
    const { view, sent } = conversing(MINE);
    const seen = await view();
    await seen.click('[data-comment-id="m1"] [data-comment-act="edit"]');
    expect(editBox(seen)?.value).toBe('my words');
    await typeInto(seen, BOX, 'changed my mind');
    await key(seen, BOX, { key: 'Escape' });
    expect(editBox(seen)).toBeNull();
    expect(seen.find('[data-comment-id="m1"] .card__body')?.textContent).toBe('my words');

    await seen.click('[data-comment-id="m1"] [data-comment-act="edit"]');
    await typeInto(seen, BOX, '   ');
    await key(seen, BOX, { key: 'Enter', ctrlKey: true });
    await tick();
    expect(sent).toHaveLength(0);
    expect(seen.find('[data-comment-id="m1"] .card__body')?.textContent).toBe('my words');

    await seen.click('[data-comment-id="m1"] [data-comment-act="edit"]');
    await typeInto(seen, BOX, 'my better words');
    await key(seen, BOX, { key: 'Enter', metaKey: true });
    await tick();
    expect(sent).toMatchObject([
      { to: '/task/edit_comment', body: { commentId: 'm1', body: 'my better words' } },
    ]);
  });

  it('leaving the box commits, and the × deletes by the row’s own id', async () => {
    const { view, sent } = conversing(MINE);
    const seen = await view();
    await seen.click('[data-comment-id="m1"] [data-comment-act="edit"]');
    await typeInto(seen, BOX, 'said on blur');
    await blur(seen, BOX);
    await tick();
    await seen.click('[data-comment-id="m1"] [data-comment-act="delete"]');
    await tick();
    expect(sent).toMatchObject([
      { to: '/task/edit_comment', body: { commentId: 'm1', body: 'said on blur' } },
      { to: '/task/delete_comment', body: { commentId: 'm1' } },
    ]);
    expect(sent[1]?.body).not.toHaveProperty('body');
  });
});

const STALE = { refused: true, code: 'VERSION_STALE', names: ['expectedRevision'], fixes: [] };

describe('MP-4-5 own rows only, an edit the server answers', () => {
  it('the edit box stays open until the answer, and a refusal keeps the words and says why', async () => {
    const { view, sent, answers } = conversing(MINE);
    const held: { answer?: (response: Response) => void } = {};
    answers.set(
      '/task/edit_comment',
      () =>
        new Promise((resolve) => {
          held.answer = resolve;
        }),
    );
    const seen = await view();
    await seen.click('[data-comment-id="m1"] [data-comment-act="edit"]');
    await typeInto(seen, BOX, 'my better words');
    await key(seen, BOX, { key: 'Enter', ctrlKey: true });
    await tick();
    // In flight: still open, still holding the words, and marked busy.
    expect(editBox(seen)?.value).toBe('my better words');
    expect(editBox(seen)?.getAttribute('aria-busy')).toBe('true');
    held.answer?.(json(STALE, 409));
    await tick();
    // Refused stale: the task was read again, and the words and the reason are still here.
    expect(editBox(seen)?.value).toBe('my better words');
    expect(seen.find('[data-comment="row-refusal"]')?.textContent).toContain('VERSION_STALE');
    answers.delete('/task/edit_comment');
    await key(seen, BOX, { key: 'Enter', ctrlKey: true });
    await tick();
    expect(editBox(seen)).toBeNull();
    expect(sent.map((one) => one.body['body'])).toStrictEqual([
      'my better words',
      'my better words',
    ]);
  });

  it('a plain refusal keeps the edited words on screen with the server’s reason', async () => {
    const { view, answers } = conversing(MINE);
    const invalid = { refused: true, code: 'FIELD_VALUE_INVALID', names: ['body'], fixes: [] };
    answers.set('/task/edit_comment', () => Promise.resolve(json(invalid, 400)));
    const seen = await view();
    await seen.click('[data-comment-id="m1"] [data-comment-act="edit"]');
    await typeInto(seen, BOX, 'not allowed words');
    await key(seen, BOX, { key: 'Enter', metaKey: true });
    await tick();
    expect(editBox(seen)?.value).toBe('not allowed words');
    expect(seen.find('[data-comment="row-refusal"]')?.textContent).toContain('FIELD_VALUE_INVALID');
  });
});
