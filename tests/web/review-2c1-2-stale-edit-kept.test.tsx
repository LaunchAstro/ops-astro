// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// REVIEW-2C1-2 (batch 2c1 review): an edit to the reader's own message that
// the server refuses `VERSION_STALE` must not lose the words. The comment box
// keeps a stale comment's text across the reread and says why
// (stale-comment-proposal-reread); an edit is the same person's typing and is
// owed the same: after the reread the edited words are still on screen, with
// a notice that the task moved on.

import { afterEach, describe, expect, it } from 'vitest';
import { TaskDetailScreen } from '../../apps/web/src/screens/TaskDetail.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { task, tick } from './task-page-stub.tsx';
import { json, mount, typeInto, unmountAll } from './perspective-support.tsx';
import { comment, key } from './conversation-support.tsx';
import type { Mounted } from '../surfaces/mount.tsx';

afterEach(unmountAll);

const MINE = [
  comment('m1', 'internal', '2026-09-20T01:00:00.000Z', 'my words', { own: true }),
  comment('t1', 'internal', '2026-09-20T02:00:00.000Z', 'their words'),
];

const BOX = '[data-comment-id="m1"] [data-comment-edit]';

const refusal = (code: string, status: number): Response =>
  json({ refused: true, code, names: [`${code} here`], fixes: ['Read the task again.'] }, status);

/**
 * A server whose task moves on from revision 4 to 5 behind the reader's back:
 * the first read is at 4, every later read at 5, and `task.edit_comment`
 * against 4 is refused `VERSION_STALE`.
 */
function movingOn(): { readonly view: () => Promise<Mounted>; readonly edits: unknown[] } {
  const edits: unknown[] = [];
  let reads = 0;
  const fetch = ((url: string | URL, init?: RequestInit) => {
    const at = String(url);
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<
      string,
      unknown
    >;
    if (at.endsWith('/person/list')) return Promise.resolve(json({ ok: true, persons: [] }));
    if (at.endsWith('/task/queue')) {
      return Promise.resolve(json({ ok: true, queue: [], alerts: [], outages: [] }));
    }
    if (at.endsWith('/task/execution')) return Promise.resolve(json({ ok: false }));
    if (/\/live(\/task\/|\?|$)/u.test(at))
      return Promise.resolve(new Response(null, { status: 404 }));
    if (at.endsWith('/task/read')) {
      const revision = reads === 0 ? 4 : 5;
      reads += 1;
      return Promise.resolve(json({ ok: true, task: task({ comments: MINE, revision }) }));
    }
    if (at.endsWith('/task/edit_comment')) {
      edits.push(body);
      return Promise.resolve(refusal('VERSION_STALE', 409));
    }
    throw new Error(`unrouted ${at}`);
  }) as unknown as typeof globalThis.fetch;
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  return {
    edits,
    view: async () => {
      const view = await mount(
        <TaskDetailScreen client={client} grantKey="alpha:member" taskKey="Proj-Verity-Pacing" />,
      );
      await tick();
      return view;
    },
  };
}

/** Every word the comment section shows, typed or drawn. */
const shown = (view: Mounted): string => {
  const section = view.host.querySelector('[data-comments="section"]');
  const boxes = [...(section?.querySelectorAll('textarea') ?? [])].map((box) => box.value);
  return [section?.textContent ?? '', ...boxes].join('\n');
};

describe('REVIEW-2C1-2 own-message edit refused stale', () => {
  it('REVIEW-2C1-2: an own-message edit refused VERSION_STALE keeps the edited words on screen, with a stale notice, after the reread', async () => {
    const { view, edits } = movingOn();
    const seen = await view();
    await seen.click('[data-comment-id="m1"] [data-comment-act="edit"]');
    await typeInto(seen, BOX, 'my better words');
    await key(seen, BOX, { key: 'Enter', ctrlKey: true });
    await tick();
    await tick();
    // The edit went out, and was refused.
    expect(edits).toMatchObject([{ commentId: 'm1', body: 'my better words' }]);
    expect(
      shown(seen),
      'the edited words were thrown away when the server answered VERSION_STALE',
    ).toContain('my better words');
    expect(shown(seen), 'nothing says the edit was refused because the task moved on').toContain(
      'VERSION_STALE',
    );
  });
});
